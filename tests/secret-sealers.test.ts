import { randomBytes } from "node:crypto";

import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";

import { getSecretBox, getSecretMode, SecretProviderMismatchError, SecretStorageUnavailableError, SecretUnreadableError, type SecretContext } from "@/lib/secrets";
import { createAesGcmSecretBox, parseAesKeys } from "@/lib/secrets/aes-gcm";
import { createAzureKeyVaultSecretBox, type KeyWrapper } from "@/lib/secrets/azure-key-vault";
import { createKmsSecretBox, type KmsClient } from "@/lib/secrets/kms";
import { secretProblems } from "@/config";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const context: SecretContext = { purpose: "mcp-api-key", userId: "alice", connectionId: "c1", orgId: ORG_A };
const key = () => randomBytes(32).toString("base64");

describe("AES-256-GCM sealer", () => {
  const box = createAesGcmSecretBox(parseAesKeys(key()));

  it("round-trips, and never stores the plaintext or the key", async () => {
    const sealed = await box.seal("sk-very-secret-value", context);
    expect(sealed).toMatchObject({ v: 1, provider: "aes-gcm", org: true });
    expect(JSON.stringify(sealed)).not.toContain("sk-very-secret-value");
    await expect(box.open(sealed, context)).resolves.toBe("sk-very-secret-value");
  });

  it("uses a fresh IV every time", async () => {
    const [a, b] = [await box.seal("same", context), await box.seal("same", context)];
    expect(a).not.toEqual(b);
  });

  it.each([
    ["another organisation", { orgId: ORG_B }],
    ["another row", { connectionId: "c2" }],
    ["another creator", { userId: "mallory" }],
    ["another purpose", { purpose: "postgres-password" }],
  ])("won't open a secret copied to %s", async (_label, change) => {
    const sealed = await box.seal("sk-secret", context);
    await expect(box.open(sealed, { ...context, ...change })).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("won't open an organisation-bound secret without an organisation", async () => {
    const sealed = await box.seal("sk-secret", context);
    await expect(box.open(sealed, { ...context, orgId: undefined })).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("detects tampering", async () => {
    const sealed = await box.seal("sk-secret", context);
    if (sealed.provider !== "aes-gcm") throw new Error("unexpected provider");
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] ^= 1;
    await expect(box.open({ ...sealed, ciphertext: flipped.toString("base64") }, context)).rejects.toBeInstanceOf(SecretUnreadableError);
    await expect(box.open({ ...sealed, org: undefined }, context)).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("rotates keys: the first key seals, older keys still open", async () => {
    const [oldKey, newKey] = [key(), key()];
    const sealedOld = await createAesGcmSecretBox(parseAesKeys(oldKey)).seal("sk-old", context);
    const rotated = createAesGcmSecretBox(parseAesKeys(`${newKey},${oldKey}`));
    await expect(rotated.open(sealedOld, context)).resolves.toBe("sk-old");
    const sealedNew = await rotated.seal("sk-new", context);
    if (sealedNew.provider !== "aes-gcm" || sealedOld.provider !== "aes-gcm") throw new Error("unexpected provider");
    expect(sealedNew.keyId).not.toBe(sealedOld.keyId);
    // Without the old key, an old secret can't be opened.
    await expect(createAesGcmSecretBox(parseAesKeys(newKey)).open(sealedOld, context)).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("names keys by fingerprint, never by value", async () => {
    const raw = key();
    const sealed = await createAesGcmSecretBox(parseAesKeys(raw)).seal("x", context);
    expect(JSON.stringify(sealed)).not.toContain(raw);
  });

  it("refuses keys that aren't 32 bytes", () => {
    expect(() => parseAesKeys("c2hvcnQ=")).toThrow(/32-byte/);
    expect(() => parseAesKeys("")).toThrow();
  });

  it("opens a secret sealed before organisations existed, by its creator and row", async () => {
    const legacyBox = createAesGcmSecretBox(parseAesKeys(key()));
    const legacy = await legacyBox.seal("sk-legacy", { purpose: context.purpose, userId: "alice", connectionId: "c1" });
    expect(legacy).not.toHaveProperty("org");
    await expect(legacyBox.open(legacy, context)).resolves.toBe("sk-legacy");
  });
});

describe("Azure Key Vault sealer (envelope encryption)", () => {
  /** Stands in for Key Vault: "wraps" by XOR with a vault-only secret, and records calls. */
  function fakeVault() {
    const vaultSecret = randomBytes(32);
    const calls: string[] = [];
    const wrapper: KeyWrapper = {
      async wrap(dataKey) {
        calls.push("wrap");
        return { keyId: "https://vault.vault.azure.net/keys/od/v1", wrapped: Buffer.from(dataKey.map((byte, i) => byte ^ vaultSecret[i]!)) };
      },
      async unwrap(keyId, wrapped) {
        calls.push(`unwrap:${keyId}`);
        return Buffer.from(wrapped.map((byte, i) => byte ^ vaultSecret[i]!));
      },
    };
    return { wrapper, calls };
  }

  it("round-trips with a fresh data key per secret, wrapped by the vault key", async () => {
    const { wrapper, calls } = fakeVault();
    const box = createAzureKeyVaultSecretBox(wrapper);
    const a = await box.seal("sk-1", context);
    const b = await box.seal("sk-1", context);
    if (a.provider !== "azure-kv" || b.provider !== "azure-kv") throw new Error("unexpected provider");
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.keyId).toBe("https://vault.vault.azure.net/keys/od/v1");
    expect(JSON.stringify(a)).not.toContain("sk-1");
    await expect(box.open(a, context)).resolves.toBe("sk-1");
    expect(calls).toEqual(["wrap", "wrap", "unwrap:https://vault.vault.azure.net/keys/od/v1"]);
  });

  it("won't open a secret copied to another organisation", async () => {
    const box = createAzureKeyVaultSecretBox(fakeVault().wrapper);
    const sealed = await box.seal("sk-1", context);
    await expect(box.open(sealed, { ...context, orgId: ORG_B })).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("reports the vault being unreachable as temporary, and a refused unwrap as unreadable", async () => {
    const down: KeyWrapper = {
      wrap: async () => {
        throw Object.assign(new Error("ECONNRESET"), { name: "RestError", statusCode: 503 });
      },
      unwrap: async () => {
        throw Object.assign(new Error("bad key"), { name: "RestError", statusCode: 400 });
      },
    };
    const box = createAzureKeyVaultSecretBox(down);
    await expect(box.seal("sk-1", context)).rejects.toBeInstanceOf(SecretStorageUnavailableError);
    const sealed = await createAzureKeyVaultSecretBox(fakeVault().wrapper).seal("sk-1", context);
    await expect(box.open(sealed, context)).rejects.toBeInstanceOf(SecretUnreadableError);
  });
});

describe("KMS sealer and organisations", () => {
  function fakeKms() {
    const contexts: unknown[] = [];
    const client: KmsClient = {
      send: (async (command: EncryptCommand | DecryptCommand) => {
        if (command instanceof EncryptCommand) {
          contexts.push(command.input.EncryptionContext);
          const sealed = JSON.stringify({ text: new TextDecoder().decode(command.input.Plaintext), context: command.input.EncryptionContext });
          return { CiphertextBlob: new TextEncoder().encode(sealed) };
        }
        const { text, context: sealedWith } = JSON.parse(new TextDecoder().decode(command.input.CiphertextBlob));
        if (JSON.stringify(sealedWith) !== JSON.stringify(command.input.EncryptionContext)) {
          throw Object.assign(new Error("bad context"), { name: "InvalidCiphertextException" });
        }
        return { Plaintext: new TextEncoder().encode(text) };
      }) as unknown as KmsClient["send"],
    };
    return { client, contexts };
  }

  it("puts the organisation in the encryption context", async () => {
    const { client, contexts } = fakeKms();
    const kms = createKmsSecretBox("key", { client, roleArn: "role" });
    const sealed = await kms.seal("sk-1", context);
    expect(sealed).toMatchObject({ provider: "kms", org: true });
    expect(contexts[0]).toEqual({ purpose: "mcp-api-key", userId: "alice", connectionId: "c1", orgId: ORG_A });
    await expect(kms.open(sealed, context)).resolves.toBe("sk-1");
    await expect(kms.open(sealed, { ...context, orgId: ORG_B })).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("still opens secrets sealed before organisations, without the organisation", async () => {
    const { client } = fakeKms();
    const kms = createKmsSecretBox("key", { client, roleArn: "role" });
    const legacy = await kms.seal("sk-legacy", { purpose: "mcp-api-key", userId: "alice", connectionId: "c1" });
    await expect(kms.open(legacy, context)).resolves.toBe("sk-legacy");
  });
});

describe("choosing a sealer", () => {
  const base = { environment: "prod" as const, kmsKeyId: undefined, allowPlaintext: false };

  it("prefers KMS, then Key Vault, then the AES key", () => {
    expect(getSecretMode({ ...base, kmsKeyId: "k", kmsRoleArn: "r", azureKeyVaultKeyId: "https://v.vault.azure.net/keys/k", encryptionKeys: key() })).toBe("kms");
    expect(getSecretMode({ ...base, azureKeyVaultKeyId: "https://v.vault.azure.net/keys/k", encryptionKeys: key() })).toBe("azure-kv");
    expect(getSecretMode({ ...base, encryptionKeys: key() })).toBe("aes-gcm");
    expect(getSecretMode(base)).toBe("unconfigured");
  });

  it("seals with the first and opens with whichever sealed it", async () => {
    const aesKey = key();
    const aesOnly = getSecretBox({ ...base, encryptionKeys: aesKey });
    const sealedByAes = await aesOnly.seal("sk-aes", context);
    // A deployment that moved to Key Vault keeps the AES key to open what it sealed.
    const both = getSecretBox({ ...base, azureKeyVaultKeyId: "https://v.vault.azure.net/keys/k", encryptionKeys: aesKey });
    expect(both.provider).toBe("azure-kv");
    await expect(both.open(sealedByAes, context)).resolves.toBe("sk-aes");
    await expect(Promise.resolve().then(() => aesOnly.open({ v: 1, provider: "kms", keyId: "k", ciphertext: "x" }, context))).rejects.toBeInstanceOf(
      SecretProviderMismatchError,
    );
  });

  it("accepts any real sealer in production config, and checks the AES key's shape", () => {
    const env = { DATABASE_URL: "x", THESYS_API_KEY: "x", SUPABASE_URL: "x", SUPABASE_PUBLISHABLE_KEY: "x" };
    const settings = { secrets: { allowPlaintext: false }, auth: { devUser: null }, demoData: { datasets: [] } } as never;
    const problems = (extra: Record<string, string>) => secretProblems("prod", settings, { ...env, ...extra }).join("\n");
    expect(problems({})).toMatch(/No secret storage/);
    expect(problems({ SECRETS_ENCRYPTION_KEY: key() })).not.toMatch(/secret storage|SECRETS_ENCRYPTION_KEY/);
    expect(problems({ SECRETS_ENCRYPTION_KEY: "short" })).toMatch(/SECRETS_ENCRYPTION_KEY must be/);
    expect(problems({ AZURE_KEY_VAULT_KEY_ID: "https://od.vault.azure.net/keys/secrets" })).not.toMatch(/secret storage|AZURE_KEY_VAULT/);
    expect(problems({ AZURE_KEY_VAULT_KEY_ID: "not-a-url" })).toMatch(/AZURE_KEY_VAULT_KEY_ID must be/);
    expect(problems({ KMS_KEY_ID: "k" })).toMatch(/KMS_ROLE_ARN/);
  });
});
