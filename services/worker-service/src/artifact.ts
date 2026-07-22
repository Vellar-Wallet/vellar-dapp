import { createHash } from "node:crypto";

// ArtifactHasher (idea.md §6.3): the on-chain identity of a deployed Soroban
// contract's code IS the sha256 of its wasm bytes — that is the "wasm hash"
// stored in the contract's ledger entry and what `soroban contract install`
// keys uploads by. So verifying source-to-bytecode equivalence reduces to:
// sha256(locally-rebuilt wasm) === deployed wasm hash.
//
// This must match Stellar's convention exactly: a lowercase hex sha256 of the
// raw .wasm bytes, with no framing. Keep it dependency-free and pure so it is
// trivially testable and identical across the worker and any future re-check.

/** Lowercase hex sha256 of the given bytes — the canonical Soroban wasm hash. */
export function hashArtifact(wasm: Uint8Array): string {
  return createHash("sha256").update(wasm).digest("hex");
}

/** Normalizes any hex hash (0x-prefixed, mixed case, whitespace) to the
 * canonical lowercase-hex form so comparisons never fail on formatting. */
export function normalizeHash(hash: string): string {
  return hash.trim().replace(/^0x/i, "").toLowerCase();
}

/** True when two wasm hashes refer to the same artifact, regardless of casing
 * or 0x-prefixing. Neither side is trusted to be pre-normalized. */
export function hashesMatch(a: string, b: string): boolean {
  return normalizeHash(a) === normalizeHash(b) && normalizeHash(a).length > 0;
}
