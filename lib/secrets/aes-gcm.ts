import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  aadFor,
  assertSecretSize,
  SecretProviderMismatchError,
  SecretUnreadableError,
  type SealedSecret,
  type SecretBox,
  type SecretContext,
} from "./types";

/**
 * AES-256-GCM with a 32-byte key from the environment (SECRETS_ENCRYPTION_KEY,
 * base64). For local development and self-hosting without a cloud KMS: real
 * encryption at rest, but the key lives next to the app, so prefer KMS or
 * Key Vault in production. The bound context is the additional data, so a
 * secret opens only for the row and organisation it was sealed for.
 *
 * Several keys may be configured for rotation: the first seals, any opens.
 */
export type AesKey = { id: string; key: Buffer };

/** Parses "base64key" or "base64key,base64oldkey,…". Throws on anything that isn't 32 bytes. */
export function parseAesKeys(value: string): AesKey[] {
  const keys = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Buffer.from(part, "base64"));
  if (!keys.length || keys.some((key) => key.length !== 32)) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be one or more comma-separated base64 32-byte keys (openssl rand -base64 32)");
  }
  return keys.map((key) => ({ id: fingerprint(key), key }));
}

/** A key's public name: the first 16 hex characters of SHA-256 over a label and the key. */
export function fingerprint(key: Buffer): string {
  return createHash("sha256").update("opendashboards-aes-gcm-key\0").update(key).digest("hex").slice(0, 16);
}

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function aesGcmDecrypt(key: Buffer, sealed: { iv: string; ciphertext: string; tag: string }, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
  } catch (cause) {
    // A wrong key, context or damaged value: never which.
    throw new SecretUnreadableError({ cause });
  }
}

export function createAesGcmSecretBox(keys: AesKey[]): SecretBox {
  if (!keys.length) throw new Error("No AES-GCM key");
  const [primary] = keys;
  return {
    provider: "aes-gcm",

    async seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
      assertSecretSize(plaintext);
      const orgBound = Boolean(context.orgId);
      const box = aesGcmEncrypt(primary.key, Buffer.from(plaintext, "utf8"), aadFor(context, orgBound));
      return { v: 1, provider: "aes-gcm", keyId: primary.id, ...box, ...(orgBound ? { org: true as const } : {}) };
    },

    async open(sealed: SealedSecret, context: SecretContext): Promise<string> {
      if (sealed.provider !== "aes-gcm") throw new SecretProviderMismatchError("aes-gcm", sealed.provider);
      const key = keys.find((candidate) => candidate.id === sealed.keyId);
      if (!key) throw new SecretUnreadableError();
      return aesGcmDecrypt(key.key, sealed, aadFor(context, sealed.org === true)).toString("utf8");
    },
  };
}
