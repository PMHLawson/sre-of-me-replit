import { describe, expect, it } from "vitest";
import {
  createTokenVault,
  createTokenVaultFromConfig,
  isEncryptedRefreshToken,
  TokenVaultError,
} from "./token-vault";

const legacyKey = Buffer.alloc(32, 0x31);
const activeKey = Buffer.alloc(32, 0x72);
const marker = "synthetic-refresh-token-never-log";

describe("OAuth refresh-token vault", () => {
  it("persists authenticated ciphertext, not the synthetic token", () => {
    const vault = createTokenVault({ activeKeyId: "active", keys: { active: activeKey } });
    const envelope = vault.encrypt(marker);
    expect(isEncryptedRefreshToken(envelope)).toBe(true);
    expect(envelope.algorithm).toBe("A256GCM");
    expect(envelope.ciphertext).not.toContain(marker);
    expect(JSON.stringify(envelope)).not.toContain(marker);
    expect(vault.decrypt(envelope)).toBe(marker);
  });

  it("rejects tampering, unknown key IDs and malformed envelopes with a safe error", () => {
    const vault = createTokenVault({ activeKeyId: "active", keys: { active: activeKey } });
    const envelope = vault.encrypt(marker);
    const tampered = { ...envelope, nonce: `${envelope.nonce[0] === "A" ? "B" : "A"}${envelope.nonce.slice(1)}` };
    for (const value of [
      tampered,
      { ...envelope, keyId: "unknown" },
      { ...envelope, extra: "unexpected" },
      { ...envelope, version: 2 },
    ]) {
      try {
        vault.decrypt(value);
        throw new Error("expected token decryption rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TokenVaultError);
        expect((error as Error).message).not.toContain(marker);
        expect((error as Error).message).not.toContain(activeKey.toString("base64"));
      }
    }
  });

  it("requires the dedicated keyring setting and never falls back to SESSION_SECRET", () => {
    for (const value of [undefined, "", "not-json", JSON.stringify({ activeKeyId: "only", keys: { only: "short" } })]) {
      expect(() => createTokenVaultFromConfig(value)).toThrow(TokenVaultError);
    }
  });

  it("rotates writes while retaining reads for sessions encrypted under a previous key", () => {
    const oldVault = createTokenVault({ activeKeyId: "old", keys: { old: legacyKey } });
    const rotatingVault = createTokenVault({
      activeKeyId: "active",
      keys: { old: legacyKey, active: activeKey },
    });
    const oldEnvelope = oldVault.encrypt(marker);
    expect(rotatingVault.decrypt(oldEnvelope)).toBe(marker);
    const newEnvelope = rotatingVault.encrypt(rotatingVault.decrypt(oldEnvelope));
    expect(newEnvelope.keyId).toBe("active");
    expect(rotatingVault.decrypt(newEnvelope)).toBe(marker);
    const activeOnly = createTokenVault({ activeKeyId: "active", keys: { active: activeKey } });
    expect(activeOnly.decrypt(newEnvelope)).toBe(marker);
    expect(() => activeOnly.decrypt(oldEnvelope)).toThrow(TokenVaultError);
  });

  it("parses a dedicated JSON keyring using canonical 32-byte base64url key material", () => {
    const encoded = activeKey.toString("base64url");
    const vault = createTokenVaultFromConfig(JSON.stringify({ activeKeyId: "active", keys: { active: encoded } }));
    expect(vault.activeKeyId).toBe("active");
    expect(vault.decrypt(vault.encrypt(marker))).toBe(marker);
  });
});
