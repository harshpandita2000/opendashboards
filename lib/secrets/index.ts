import { config, secrets, type Environment } from "@/config";

import { createAesGcmSecretBox, parseAesKeys } from "./aes-gcm";
import { createAzureKeyVaultSecretBox, keyVaultWrapper } from "./azure-key-vault";
import { createKmsSecretBox } from "./kms";
import { plaintextSecretBox } from "./plaintext";
import {
  SecretProviderMismatchError,
  SecretStorageNotConfiguredError,
  type SealedSecret,
  type SecretBox,
  type SecretContext,
  type SecretProvider,
} from "./types";

export * from "./types";

/**
 * Secret storage is pluggable. Whichever of these is configured seals new
 * secrets, in this order: AWS KMS (KMS_KEY_ID + KMS_ROLE_ARN), Azure Key Vault
 * (AZURE_KEY_VAULT_KEY_ID), AES-256-GCM with a key from the environment
 * (SECRETS_ENCRYPTION_KEY), and, locally only, plaintext. Every configured
 * provider can still open what it sealed, so switching providers doesn't
 * strand existing secrets (they're re-sealed when next replaced).
 */
export type SecretSettings = {
  environment: Environment;
  kmsKeyId: string | undefined;
  kmsRoleArn?: string;
  /** https://<vault>.vault.azure.net/keys/<name>[/<version>] */
  azureKeyVaultKeyId?: string;
  /** One or more base64 32-byte keys, comma-separated; the first seals. */
  encryptionKeys?: string;
  allowPlaintext: boolean;
};

const current = (): SecretSettings => {
  const { env, secrets: settings } = config();
  return {
    environment: env,
    kmsKeyId: secrets.kmsKeyId(),
    kmsRoleArn: secrets.kmsRoleArn(),
    azureKeyVaultKeyId: secrets.azureKeyVaultKeyId(),
    encryptionKeys: secrets.encryptionKeys(),
    allowPlaintext: settings.allowPlaintext,
  };
};

/** Plaintext is allowed only where the settings allow it and only locally, whatever a settings file says. */
const plaintextAllowed = (settings: SecretSettings) => settings.allowPlaintext && settings.environment === "local";

// One Key Vault client per key id per process: it caches its token.
const keyVaultBoxes = new Map<string, SecretBox>();
function keyVaultBox(keyId: string): SecretBox {
  let box = keyVaultBoxes.get(keyId);
  if (!box) keyVaultBoxes.set(keyId, (box = createAzureKeyVaultSecretBox(keyVaultWrapper(keyId))));
  return box;
}

/** Every provider this deployment has, the sealing one first. */
function configuredBoxes(settings: SecretSettings): SecretBox[] {
  const boxes: SecretBox[] = [];
  if (settings.kmsKeyId && settings.kmsRoleArn) boxes.push(createKmsSecretBox(settings.kmsKeyId, { roleArn: settings.kmsRoleArn }));
  if (settings.azureKeyVaultKeyId) boxes.push(keyVaultBox(settings.azureKeyVaultKeyId));
  if (settings.encryptionKeys) boxes.push(createAesGcmSecretBox(parseAesKeys(settings.encryptionKeys)));
  if (plaintextAllowed(settings)) boxes.push(plaintextSecretBox);
  return boxes;
}

/**
 * The deployment's secret storage: seals with the first configured provider,
 * opens with whichever provider sealed the value (if it's configured here).
 * Anywhere but local without a real provider throws: secrets are never stored
 * unencrypted there.
 */
export function getSecretBox(settings: SecretSettings = current()): SecretBox {
  const boxes = configuredBoxes(settings);
  if (!boxes.length) throw new SecretStorageNotConfiguredError();
  const [primary] = boxes;
  if (primary.provider === "plaintext") warnPlaintextOnce();
  if (boxes.length === 1) return primary;
  return {
    provider: primary.provider,
    seal: (plaintext: string, context: SecretContext) => primary.seal(plaintext, context),
    open(sealed: SealedSecret, context: SecretContext) {
      const box = boxes.find((candidate) => candidate.provider === sealed.provider);
      if (!box) throw new SecretProviderMismatchError(primary.provider, sealed.provider);
      return box.open(sealed, context);
    },
  };
}

/** For the UI: which provider seals new secrets, without throwing. */
export function getSecretMode(settings: SecretSettings = current()): SecretProvider | "unconfigured" {
  if (settings.kmsKeyId && settings.kmsRoleArn) return "kms";
  if (settings.azureKeyVaultKeyId) return "azure-kv";
  if (settings.encryptionKeys) return "aes-gcm";
  return plaintextAllowed(settings) ? "plaintext" : "unconfigured";
}

let warned = false;
function warnPlaintextOnce() {
  if (warned) return;
  warned = true;
  console.warn("[opendashboards] Secrets are stored unencrypted (no KMS, Key Vault or SECRETS_ENCRYPTION_KEY). Local development only.");
}
