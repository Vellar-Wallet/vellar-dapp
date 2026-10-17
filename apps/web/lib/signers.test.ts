import { describe, expect, it, vi } from "vitest";
import type { SignerEntry } from "./signer-model";
import {
  getSignerRevokeConfirmation,
  isOnlyRemainingSigner,
  LAST_SIGNER_CONFIRMATION_PHRASE,
  LAST_SIGNER_REVOKE_PROMPT,
  LastSignerConfirmationRequiredError,
  revokeSignerWithConfirmation,
  ROUTINE_REVOKE_PROMPT,
} from "./signers";

function makeSigner(overrides: Partial<SignerEntry> = {}): SignerEntry {
  const key = overrides.key ?? { kind: "Secp256r1", value: "cred-1" };
  return {
    id: `${key.kind}:${key.value}`,
    kind: "passkey",
    key,
    status: "live",
    storage: "persistent",
    isCurrent: true,
    isDurableAdmin: true,
    ...overrides,
  };
}

describe("last-signer revocation confirmation (#595)", () => {
  const signerA = makeSigner({ key: { kind: "Secp256r1", value: "cred-a" } });
  const signerB = makeSigner({
    key: { kind: "Secp256r1", value: "cred-b" },
    isCurrent: false,
  });

  it("uses routine confirmation and allows revocation when 2 live signers exist", async () => {
    const entries = [signerA, signerB];
    expect(isOnlyRemainingSigner(signerB, entries)).toBe(false);

    const step = getSignerRevokeConfirmation(signerB, entries);
    expect(step.requiresLastSignerConfirmation).toBe(false);
    expect(step.prompt).toBe(ROUTINE_REVOKE_PROMPT);
    expect(step.confirmationPhrase).toBeUndefined();

    const removeSigner = vi.fn().mockResolvedValue({ hash: "tx-routine-revoke" });
    const res = await revokeSignerWithConfirmation({
      key: signerB.key,
      entries,
      removeSigner,
    });

    expect(res).toEqual({ hash: "tx-routine-revoke" });
    expect(removeSigner).toHaveBeenCalledWith(signerB.key);
  });

  it("requires a distinct last-signer confirmation step when revoking the only remaining signer", async () => {
    const entries = [signerA];
    expect(isOnlyRemainingSigner(signerA, entries)).toBe(true);

    const step = getSignerRevokeConfirmation(signerA, entries);
    expect(step.requiresLastSignerConfirmation).toBe(true);
    expect(step.prompt).toBe(LAST_SIGNER_REVOKE_PROMPT);
    expect(step.prompt).not.toBe(ROUTINE_REVOKE_PROMPT);
    expect(step.confirmationPhrase).toBe(LAST_SIGNER_CONFIRMATION_PHRASE);

    const removeSigner = vi.fn().mockResolvedValue({ hash: "tx-last-revoke" });

    // Without explicit last-signer confirmation, revocation is rejected before calling removeSigner
    await expect(
      revokeSignerWithConfirmation({
        key: signerA.key,
        entries,
        removeSigner,
      }),
    ).rejects.toBeInstanceOf(LastSignerConfirmationRequiredError);
    expect(removeSigner).not.toHaveBeenCalled();

    // Wrong confirmation phrase is also rejected
    await expect(
      revokeSignerWithConfirmation({
        key: signerA.key,
        entries,
        confirmLastSigner: "WRONG PHRASE",
        removeSigner,
      }),
    ).rejects.toBeInstanceOf(LastSignerConfirmationRequiredError);
    expect(removeSigner).not.toHaveBeenCalled();

    // Explicit last-signer confirmation phrase succeeds
    const confirmed = await revokeSignerWithConfirmation({
      key: signerA.key,
      entries,
      confirmLastSigner: LAST_SIGNER_CONFIRMATION_PHRASE,
      removeSigner,
    });
    expect(confirmed).toEqual({ hash: "tx-last-revoke" });
    expect(removeSigner).toHaveBeenCalledTimes(1);
  });

  it("ignores expired or evicted signers when counting remaining live signers", () => {
    const expiredDevice = makeSigner({
      kind: "device-session",
      key: { kind: "Ed25519", value: "G_EXPIRED_DEVICE" },
      status: "expired",
      storage: "temporary",
      isDurableAdmin: false,
    });

    expect(isOnlyRemainingSigner(signerA, [signerA, expiredDevice])).toBe(true);
  });
});
