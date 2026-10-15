import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_FORMAT = "sre-oauth-refresh-token";
const ENVELOPE_VERSION = 1;
const ALGORITHM = "A256GCM";
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_KEYS = 8;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ENVELOPE_FIELDS = ["algorithm", "ciphertext", "format", "keyId", "nonce", "tag", "version"];

export interface EncryptedRefreshToken {
  readonly format: typeof ENVELOPE_FORMAT;
  readonly version: typeof ENVELOPE_VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly keyId: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface TokenVault {
  readonly activeKeyId: string;
  encrypt(token: string): EncryptedRefreshToken;
  decrypt(value: unknown): string;
}

/** Safe to return to session middleware; never includes key, token, or crypto-library details. */
export class TokenVaultError extends Error {
  constructor() {
    super("OAuth token protection is unavailable");
    this.name = "TokenVaultError";
  }
}

function fail(): never {
  throw new TokenVaultError();
}

function canonicalBase64Url(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) return fail();
  return bytes;
}

export function isEncryptedRefreshToken(value: unknown): value is EncryptedRefreshToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const fields = Object.keys(envelope).sort();
  return fields.length === ENVELOPE_FIELDS.length &&
    fields.every((field, index) => field === [...ENVELOPE_FIELDS].sort()[index]) &&
    envelope.format === ENVELOPE_FORMAT &&
    envelope.version === ENVELOPE_VERSION &&
    envelope.algorithm === ALGORITHM &&
    typeof envelope.keyId === "string" && KEY_ID.test(envelope.keyId) &&
    typeof envelope.nonce === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.ciphertext === "string";
}

export function createTokenVault(options: {
  activeKeyId: string;
  keys: Readonly<Record<string, Uint8Array>>;
}): TokenVault {
  if (!options || !KEY_ID.test(options.activeKeyId) || !options.keys ||
    (Object.getPrototypeOf(options.keys) !== Object.prototype && Object.getPrototypeOf(options.keys) !== null)) return fail();
  const keyIds = Object.keys(options.keys);
  if (keyIds.length < 1 || keyIds.length > MAX_KEYS ||
    keyIds.some(id => !KEY_ID.test(id)) ||
    !Object.prototype.hasOwnProperty.call(options.keys, options.activeKeyId)) return fail();

  const keys = new Map<string, Buffer>();
  for (const id of keyIds) {
    const material = options.keys[id];
    if (!(material instanceof Uint8Array) || material.byteLength !== 32) return fail();
    keys.set(id, Buffer.from(material));
  }

  const aad = (keyId: string) => Buffer.from(`${ENVELOPE_FORMAT}:v${ENVELOPE_VERSION}:${keyId}`, "utf8");
  const vault: TokenVault = {
    activeKeyId: options.activeKeyId,
    encrypt(token: string): EncryptedRefreshToken {
      if (typeof token !== "string" || token.length === 0 || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) return fail();
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", keys.get(options.activeKeyId)!, nonce);
        cipher.setAAD(aad(options.activeKeyId));
        const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
        return Object.freeze({
          format: ENVELOPE_FORMAT,
          version: ENVELOPE_VERSION,
          algorithm: ALGORITHM,
          keyId: options.activeKeyId,
          nonce: nonce.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
        });
      } catch {
        return fail();
      }
    },
    decrypt(value: unknown): string {
      if (!isEncryptedRefreshToken(value)) return fail();
      const key = keys.get(value.keyId);
      if (!key) return fail();
      try {
        const nonce = canonicalBase64Url(value.nonce, 12);
        const tag = canonicalBase64Url(value.tag, 16);
        const ciphertext = canonicalBase64Url(value.ciphertext);
        if (ciphertext.length === 0 || ciphertext.length > MAX_TOKEN_BYTES) return fail();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad(value.keyId));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (plaintext.length === 0 || plaintext.length > MAX_TOKEN_BYTES) return fail();
        const token = plaintext.toString("utf8");
        if (!Buffer.from(token, "utf8").equals(plaintext)) return fail();
        return token;
      } catch {
        return fail();
      }
    },
  };
  return Object.freeze(vault);
}

/** Reads only the dedicated keyring secret. Never substitute SESSION_SECRET. */
export function createTokenVaultFromConfig(serialized: string | undefined): TokenVault {
  if (!serialized || serialized.length > 64 * 1024) return fail();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
    const root = parsed as Record<string, unknown>;
    if (Object.keys(root).sort().join(",") !== "activeKeyId,keys" ||
      typeof root.activeKeyId !== "string" ||
      !root.keys || typeof root.keys !== "object" || Array.isArray(root.keys) ||
      Object.getPrototypeOf(root.keys) !== Object.prototype) return fail();
    const serializedKeys = root.keys as Record<string, unknown>;
    const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
    for (const [keyId, encoded] of Object.entries(serializedKeys)) {
      if (!KEY_ID.test(keyId)) return fail();
      keys[keyId] = canonicalBase64Url(encoded, 32);
    }
    return createTokenVault({ activeKeyId: root.activeKeyId, keys });
  } catch {
    return fail();
  }
}
