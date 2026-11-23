/**
 * What a secret is bound to. Every provider authenticates it (KMS as the
 * encryption context, AES-GCM and Key Vault as additional data), so a sealed
 * secret only opens for the same user, row and organisation: copying it into
 * another row, or another organisation's, gets a decrypt error, not a key.
 */
export type SecretContext = {
  /** What the secret is for, from its source: "posthog-api-key", "postgres-password". */
  purpose: string;
  /** Who created the row it belongs to. */
  userId: string;
  /** The row it belongs to: a connection, a model provider, a sign-in. */
  connectionId: string;
  /**
   * The organisation the row belongs to. Secrets sealed with it are marked
   * `org: true` and open only with the same one. Secrets sealed before
   * organisations existed have no mark and are opened without it.
   */
  orgId?: string;
};

/** The fields a provider authenticates, for a secret as it was sealed. */
export function boundContext(context: SecretContext, orgBound: boolean): Record<string, string> {
  const { purpose, userId, connectionId, orgId } = context;
  if (!orgBound) return { purpose, userId, connectionId };
  if (!orgId) throw new SecretUnreadableError();
  return { purpose, userId, connectionId, orgId };
}

/** Additional authenticated data for the AEAD providers: the bound context, in a fixed order. */
export function aadFor(context: SecretContext, orgBound: boolean): Buffer {
  const bound = boundContext(context, orgBound);
  return Buffer.from(JSON.stringify(Object.keys(bound).sort().map((key) => [key, bound[key]])), "utf8");
}

/**
 * A secret as stored. `provider` and `v` say how to open it. "none" records
 * that there is no secret: a server that needs no password. It holds nothing,
 * so there is nothing to encrypt.
 */
export type SealedSecret =
  | { v: 1; provider: "plaintext"; value: string }
  | { v: 1; provider: "kms"; keyId: string; ciphertext: string; org?: true }
  /** AES-256-GCM with a key from the environment. `keyId` is the key's fingerprint, never the key. */
  | { v: 1; provider: "aes-gcm"; keyId: string; iv: string; ciphertext: string; tag: string; org?: true }
  /** Envelope encryption: a fresh AES-256-GCM key per secret, wrapped by an Azure Key Vault key (RSA-OAEP-256). */
  | { v: 1; provider: "azure-kv"; keyId: string; wrappedKey: string; iv: string; ciphertext: string; tag: string; org?: true }
  | { v: 1; provider: "none" };

export type SecretProvider = Exclude<SealedSecret["provider"], "none">;

export interface SecretBox {
  readonly provider: SecretProvider;
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>;
  open(sealed: SealedSecret, context: SecretContext): Promise<string>;
}

/**
 * The largest secret we store, in bytes of UTF-8. KMS's Encrypt takes at most
 * 4,096 bytes of plaintext with a symmetric key, and every provider applies the
 * same limit so local development fails exactly where production would.
 */
export const MAX_SECRET_BYTES = 4_096;

/** Bytes a secret takes: KMS counts bytes, not characters. */
export const secretBytes = (plaintext: string) => Buffer.byteLength(plaintext, "utf8");

/** A secret over MAX_SECRET_BYTES. Carries only its size, never the value. */
export class SecretTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number = MAX_SECRET_BYTES,
  ) {
    super(`The secret is ${bytes} bytes; the most that can be stored is ${limit}`);
    this.name = "SecretTooLargeError";
  }
}

/** Refuses a secret over the limit, before any provider sees it. */
export function assertSecretSize(plaintext: string): void {
  const bytes = secretBytes(plaintext);
  if (bytes > MAX_SECRET_BYTES) throw new SecretTooLargeError(bytes);
}

/** The secret store couldn't be reached or refused the call. A retry may work. */
export class SecretStorageUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretStorageUnavailableError";
  }
}

/** The stored value can't be opened for this user and connection: the user has to enter it again. */
export class SecretUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The stored secret can't be decrypted for this connection", options);
    this.name = "SecretUnreadableError";
  }
}

/** Production has no usable secret storage configured. */
export class SecretStorageNotConfiguredError extends Error {
  constructor() {
    super("Secret storage isn't configured: set KMS_KEY_ID, AZURE_KEY_VAULT_KEY_ID or SECRETS_ENCRYPTION_KEY");
    this.name = "SecretStorageNotConfiguredError";
  }
}

/**
 * A stored secret was written by a different provider than the one running,
 * e.g. a plaintext row (from a local database) read by a KMS deployment. It's
 * never used: the user has to enter the key again.
 */
export class SecretProviderMismatchError extends Error {
  constructor(
    readonly expected: SecretProvider,
    readonly found: string,
  ) {
    super(`Secret was stored by "${found}", but this deployment uses "${expected}"`);
    this.name = "SecretProviderMismatchError";
  }
}
