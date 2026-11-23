import { randomBytes } from "node:crypto";

import type { TokenCredential } from "@azure/identity";

import { count } from "@/lib/metrics";

import { aesGcmDecrypt, aesGcmEncrypt } from "./aes-gcm";
import {
  aadFor,
  assertSecretSize,
  SecretProviderMismatchError,
  SecretStorageUnavailableError,
  SecretUnreadableError,
  type SealedSecret,
  type SecretBox,
  type SecretContext,
} from "./types";

/**
 * Azure Key Vault (or Managed HSM), by envelope encryption: each secret gets
 * a fresh 256-bit data key, the secret is sealed with it by AES-256-GCM (the
 * bound context as additional data), and the data key is wrapped by the
 * vault's RSA key with RSA-OAEP-256. Only the wrapped key and ciphertext are
 * stored; the vault key never leaves the vault.
 *
 * AZURE_KEY_VAULT_KEY_ID is the key's full id,
 * https://<vault>.vault.azure.net/keys/<name>[/<version>]. The app signs in
 * with DefaultAzureCredential: a managed identity on Azure, or
 * AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET elsewhere. It needs
 * the "Key Vault Crypto User" role (wrapKey, unwrapKey) on the key.
 */

/** What this provider needs from the Key Vault SDK, so tests can stand in for it. */
export type KeyWrapper = {
  wrap(dataKey: Buffer): Promise<{ keyId: string; wrapped: Buffer }>;
  unwrap(keyId: string, wrapped: Buffer): Promise<Buffer>;
};

const ALGORITHM = "RSA-OAEP-256";

/** The SDK-backed wrapper. Loaded lazily: deployments without Key Vault never import it. */
export function keyVaultWrapper(keyId: string, credential?: TokenCredential): KeyWrapper {
  let clients: Map<string, import("@azure/keyvault-keys").CryptographyClient> | undefined;
  let cred: TokenCredential | undefined = credential;
  async function client(id: string) {
    const { CryptographyClient } = await import("@azure/keyvault-keys");
    if (!cred) {
      const { DefaultAzureCredential } = await import("@azure/identity");
      cred = new DefaultAzureCredential();
    }
    clients ??= new Map();
    let c = clients.get(id);
    if (!c) clients.set(id, (c = new CryptographyClient(id, cred)));
    return c;
  }
  return {
    async wrap(dataKey) {
      const result = await (await client(keyId)).wrapKey(ALGORITHM, dataKey);
      // The versioned id it was wrapped with, so secrets outlive key rotation.
      return { keyId: result.keyID ?? keyId, wrapped: Buffer.from(result.result) };
    },
    async unwrap(id, wrapped) {
      const result = await (await client(id)).unwrapKey(ALGORITHM, wrapped);
      return Buffer.from(result.result);
    },
  };
}

function countFailure(operation: "wrap" | "unwrap", cause: unknown) {
  count("opendashboards.keyvault.failure", { operation, error: cause instanceof Error ? cause.name : "unknown" });
}

export function createAzureKeyVaultSecretBox(wrapper: KeyWrapper): SecretBox {
  return {
    provider: "azure-kv",

    async seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
      assertSecretSize(plaintext);
      const orgBound = Boolean(context.orgId);
      const dataKey = randomBytes(32);
      try {
        const box = aesGcmEncrypt(dataKey, Buffer.from(plaintext, "utf8"), aadFor(context, orgBound));
        let wrapped: { keyId: string; wrapped: Buffer };
        try {
          wrapped = await wrapper.wrap(dataKey);
        } catch (cause) {
          countFailure("wrap", cause);
          throw new SecretStorageUnavailableError("Key Vault couldn't wrap the key", { cause });
        }
        return {
          v: 1,
          provider: "azure-kv",
          keyId: wrapped.keyId,
          wrappedKey: wrapped.wrapped.toString("base64"),
          ...box,
          ...(orgBound ? { org: true as const } : {}),
        };
      } finally {
        dataKey.fill(0);
      }
    },

    async open(sealed: SealedSecret, context: SecretContext): Promise<string> {
      if (sealed.provider !== "azure-kv") throw new SecretProviderMismatchError("azure-kv", sealed.provider);
      let dataKey: Buffer;
      try {
        dataKey = await wrapper.unwrap(sealed.keyId, Buffer.from(sealed.wrappedKey, "base64"));
      } catch (cause) {
        countFailure("unwrap", cause);
        // 4xx from the vault (bad ciphertext, key gone): the user re-enters it. Anything else may pass on retry.
        const status = (cause as { statusCode?: number })?.statusCode;
        if (status === 400 || status === 404) throw new SecretUnreadableError({ cause });
        throw new SecretStorageUnavailableError("Key Vault couldn't unwrap the key", { cause });
      }
      try {
        return aesGcmDecrypt(dataKey, sealed, aadFor(context, sealed.org === true)).toString("utf8");
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
