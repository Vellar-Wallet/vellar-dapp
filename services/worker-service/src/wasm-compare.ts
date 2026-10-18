// Metadata-tolerant wasm comparison for third-party contracts (issue #419;
// open-work-catalogue 1.5). The default verdict is still byte-for-byte
// (hashesMatch in artifact.ts); this module decides the narrower question
// "do two DIFFERENT wasm files differ ONLY in toolchain provenance stamps?".
//
// What a Soroban build emits (observed on the canonical vela-verify image,
// rustc 1.94.0 / soroban-sdk 27.0.0 / stellar-cli 26.1.0, and reproduced with
// rustc 1.93.0 and with stellar-cli 26.0.0 for comparison — see
// docs/decisions.md 2026-09-27): the standard sections (type, import,
// function, table, memory, global, export, code, data — this SDK version
// emits no data-count section on a contract with no data segments) followed
// by custom sections
//   contractspecv0     the contract's interface (ABI) — clients rely on it
//   contractenvmetav0  the host interface/protocol version — the HOST reads it
//   contractmetav0     [rsver, rssdkver]   written by soroban-sdk
//
// contractmetav0 is a stream of XDR SCMetaEntry values (SEP-46). Only two
// keys are normalized, and only inside contractmetav0:
//
//   rsver     rustc version that compiled the contract ("1.94.0")
//   rssdkver  soroban-sdk version + git revision ("27.0.0#e5cb4b52…")
//
// stellar-cli does NOT append its own contractmetav0 entry in this SDK/CLI
// combination: building the same contract source with stellar-cli 26.0.0 vs
// 26.1.0 (same rustc, same soroban-sdk) produced BYTE-IDENTICAL wasm — no
// `cliver` key exists to normalize. An earlier version of this module assumed
// one did; that assumption did not survive contact with a real build and was
// dropped (docs/decisions.md 2026-09-27) rather than kept untested.
//
// Why rsver/rssdkver cannot affect execution: they live in a wasm CUSTOM
// section, which the wasm spec defines as having no semantic effect on
// instantiation or execution, and the Soroban host never reads contractmetav0
// (it validates contractenvmetav0 only). They are written after compilation
// as provenance strings; no code references them.
//
// Why a toolchain difference legitimately changes them: each is literally the
// version/git revision of a tool in the build. A different rustc patch release
// changes `rsver` even when the SDK — and therefore every emitted instruction
// — is identical (verified: rustc 1.93.0 vs 1.94.0 building the same contract
// source differ ONLY in this contractmetav0 entry, byte-for-byte elsewhere).
//
// Why this stays a real guarantee: EVERYTHING else must be byte-identical and
// in the same order — every standard section (all executable code and data),
// contractspecv0, contractenvmetav0, any other custom section, and every
// OTHER contractmetav0 entry (contracts may publish their own meta, e.g.
// SEP-55 source provenance, via contractmeta!). If a toolchain difference
// changed a single instruction, the code section differs and this returns a
// mismatch. A contractmetav0 section that cannot be parsed as a clean SCMetaEntry
// stream is compared raw — metadata we cannot classify is never discarded.

/** The ONLY contractmetav0 keys normalized. Do not extend without the same
 * justification recorded above and in the decision log. */
export const TOOLCHAIN_META_KEYS: ReadonlySet<string> = new Set(["rsver", "rssdkver"]);

const CONTRACT_META_SECTION = "contractmetav0";
const SC_META_V0 = 0;

export class WasmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmParseError";
  }
}

export interface WasmSection {
  id: number;
  /** Custom-section name (id 0 only). */
  name?: string;
  /** Section content after the id/size header (for custom sections, after the name). */
  content: Uint8Array;
}

function readU32Leb(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) throw new WasmParseError("truncated LEB128");
    const byte = bytes[pos++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (i === 4 && byte > 0x0f) throw new WasmParseError("LEB128 overflows u32");
      return { value: result >>> 0, next: pos };
    }
    shift += 7;
  }
  throw new WasmParseError("LEB128 too long");
}

/** Split a wasm binary into its sections. Strict: bad magic/version, a section
 * overrunning the module, or an invalid custom-section name all throw. */
export function parseWasmSections(bytes: Uint8Array): WasmSection[] {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.length < 8 || header.some((b, i) => bytes[i] !== b)) {
    throw new WasmParseError("not a wasm v1 module");
  }
  const sections: WasmSection[] = [];
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos++]!;
    const size = readU32Leb(bytes, pos);
    const start = size.next;
    const end = start + size.value;
    if (end > bytes.length) throw new WasmParseError(`section ${id} overruns the module`);
    if (id === 0) {
      const nameLen = readU32Leb(bytes, start);
      const nameEnd = nameLen.next + nameLen.value;
      if (nameEnd > end) throw new WasmParseError("custom section name overruns the section");
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(nameLen.next, nameEnd),
        );
      } catch {
        throw new WasmParseError("custom section name is not valid UTF-8");
      }
      sections.push({ id, name, content: bytes.subarray(nameEnd, end) });
    } else {
      sections.push({ id, content: bytes.subarray(start, end) });
    }
    pos = end;
  }
  return sections;
}

interface MetaEntry {
  key: string;
  val: string;
  /** The entry's exact XDR bytes, so kept entries compare byte-for-byte. */
  raw: Uint8Array;
}

/** Parse a contractmetav0 payload as a stream of SCMetaEntry (SC_META_V0 only,
 * canonical zero padding). Returns undefined if it is anything else — the
 * caller then compares the section raw. */
function parseMetaEntries(content: Uint8Array): MetaEntry[] | undefined {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: MetaEntry[] = [];
  let pos = 0;
  const readString = (): string | undefined => {
    if (pos + 4 > content.length) return undefined;
    const len = view.getUint32(pos);
    pos += 4;
    const padded = len + ((4 - (len % 4)) % 4);
    if (pos + padded > content.length) return undefined;
    for (let i = pos + len; i < pos + padded; i++) if (content[i] !== 0) return undefined;
    let s: string;
    try {
      s = decoder.decode(content.subarray(pos, pos + len));
    } catch {
      return undefined;
    }
    pos += padded;
    return s;
  };
  while (pos < content.length) {
    const start = pos;
    if (pos + 4 > content.length) return undefined;
    if (view.getUint32(pos) !== SC_META_V0) return undefined;
    pos += 4;
    const key = readString();
    if (key === undefined) return undefined;
    const val = readString();
    if (val === undefined) return undefined;
    entries.push({ key, val, raw: content.subarray(start, pos) });
  }
  return entries;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The comparison view of a module: sections in order, with toolchain entries
 * removed from each cleanly-parsed contractmetav0 section, and a meta section
 * that held ONLY toolchain entries dropped (an older CLI that does not append
 * `cliver` emits no such section at all). */
function normalizedView(sections: WasmSection[]): WasmSection[] {
  const view: WasmSection[] = [];
  for (const section of sections) {
    if (section.id !== 0 || section.name !== CONTRACT_META_SECTION) {
      view.push(section);
      continue;
    }
    const entries = parseMetaEntries(section.content);
    if (!entries) {
      view.push(section); // unclassifiable: keep raw, compare strictly
      continue;
    }
    const kept = entries.filter((e) => !TOOLCHAIN_META_KEYS.has(e.key));
    if (kept.length === 0) continue;
    view.push({ id: 0, name: CONTRACT_META_SECTION, content: concat(kept.map((e) => e.raw)) });
  }
  return view;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface WasmByteDiffSpan {
  /** 0-based byte offset where the first contiguous difference starts. */
  offset: number;
  /** Length in bytes of the first contiguous differing span. */
  length: number;
  /** Hex preview of the rebuilt bytes at the first differing span. */
  rebuiltHex: string;
  /** Hex preview of the deployed bytes at the first differing span. */
  deployedHex: string;
}

export interface WasmByteDiffReport {
  /** True when the two byte sequences are byte-for-byte identical. */
  identical: boolean;
  /** Total byte length of the rebuilt wasm binary. */
  rebuiltLength: number;
  /** Total byte length of the deployed wasm binary. */
  deployedLength: number;
  /** Signed length delta (`rebuiltLength - deployedLength`). */
  lengthDelta: number;
  /** Total number of byte positions that differ (including any trailing length delta). */
  differingByteCount: number;
  /** Number of contiguous differing byte spans across the binaries. */
  differingSpanCount: number;
  /** Summary of the first differing byte span, or null when identical. */
  firstDifference: WasmByteDiffSpan | null;
}

const DEFAULT_DIFF_PREVIEW_BYTES = 16;

function toHexSlice(bytes: Uint8Array, start: number, maxLen: number): string {
  if (start >= bytes.length || maxLen <= 0) return "";
  const end = Math.min(bytes.length, start + maxLen);
  return Buffer.from(bytes.subarray(start, end)).toString("hex");
}

/**
 * Computes a structured byte-level diff summary between two wasm byte sequences.
 * Kept pure and independent of the verification pass/fail verdict so callers can
 * inspect divergence offsets, span lengths, differing byte counts, and length deltas.
 */
export function computeWasmByteDiff(
  rebuilt: Uint8Array,
  deployed: Uint8Array,
  previewMaxBytes: number = DEFAULT_DIFF_PREVIEW_BYTES,
): WasmByteDiffReport {
  const rebuiltLength = rebuilt.length;
  const deployedLength = deployed.length;
  const lengthDelta = rebuiltLength - deployedLength;
  const minLen = Math.min(rebuiltLength, deployedLength);
  const maxLen = Math.max(rebuiltLength, deployedLength);
  const extraLen = maxLen - minLen;

  let differingByteCount = 0;
  let differingSpanCount = 0;
  let firstOffset = -1;
  let firstLength = 0;
  let inDiffSpan = false;
  let firstSpanClosed = false;

  for (let i = 0; i < minLen; i++) {
    if (rebuilt[i] !== deployed[i]) {
      differingByteCount += 1;
      if (!inDiffSpan) {
        inDiffSpan = true;
        differingSpanCount += 1;
        if (firstOffset === -1) {
          firstOffset = i;
        }
      }
      if (!firstSpanClosed && firstOffset !== -1) {
        firstLength += 1;
      }
    } else if (inDiffSpan) {
      inDiffSpan = false;
      if (firstOffset !== -1 && !firstSpanClosed) {
        firstSpanClosed = true;
      }
    }
  }

  if (extraLen > 0) {
    differingByteCount += extraLen;
    if (!inDiffSpan) {
      differingSpanCount += 1;
      if (firstOffset === -1) {
        firstOffset = minLen;
        firstLength = extraLen;
        firstSpanClosed = true;
      }
    } else if (!firstSpanClosed && firstOffset !== -1) {
      firstLength += extraLen;
      firstSpanClosed = true;
    }
  }

  if (differingByteCount === 0) {
    return {
      identical: true,
      rebuiltLength,
      deployedLength,
      lengthDelta: 0,
      differingByteCount: 0,
      differingSpanCount: 0,
      firstDifference: null,
    };
  }

  const previewLen = Math.min(firstLength, previewMaxBytes);
  return {
    identical: false,
    rebuiltLength,
    deployedLength,
    lengthDelta,
    differingByteCount,
    differingSpanCount,
    firstDifference: {
      offset: firstOffset,
      length: firstLength,
      rebuiltHex: toHexSlice(rebuilt, firstOffset, previewLen),
      deployedHex: toHexSlice(deployed, firstOffset, previewLen),
    },
  };
}

export type WasmComparison =
  | { match: "exact" }
  | { match: "toolchain-metadata"; normalizedKeys: string[] }
  | { match: "none"; reason: string; byteDiff: WasmByteDiffReport };

/** Toolchain entries that differ between two parsed modules (for the log). */
function differingToolchainKeys(a: WasmSection[], b: WasmSection[]): string[] {
  const collect = (sections: WasmSection[]) => {
    const map = new Map<string, string>();
    for (const s of sections) {
      if (s.id !== 0 || s.name !== CONTRACT_META_SECTION) continue;
      for (const e of parseMetaEntries(s.content) ?? []) {
        if (TOOLCHAIN_META_KEYS.has(e.key)) map.set(e.key, e.val);
      }
    }
    return map;
  };
  const ma = collect(a);
  const mb = collect(b);
  return [...TOOLCHAIN_META_KEYS].filter((k) => ma.get(k) !== mb.get(k)).sort();
}

/**
 * Compare a rebuilt artifact to the deployed one. Byte-identical ⇒ "exact".
 * Otherwise ⇒ "toolchain-metadata" only if the two modules are identical after
 * removing TOOLCHAIN_META_KEYS from contractmetav0; anything else ⇒ "none"
 * with a structured `byteDiff` report alongside the failure `reason`.
 * Never throws: an unparseable module is a mismatch.
 */
export function compareWasm(rebuilt: Uint8Array, deployed: Uint8Array): WasmComparison {
  if (bytesEqual(rebuilt, deployed)) return { match: "exact" };
  let a: WasmSection[];
  let b: WasmSection[];
  try {
    a = parseWasmSections(rebuilt);
    b = parseWasmSections(deployed);
  } catch (err) {
    return {
      match: "none",
      reason: `unparseable wasm: ${(err as Error).message}`,
      byteDiff: computeWasmByteDiff(rebuilt, deployed),
    };
  }
  const va = normalizedView(a);
  const vb = normalizedView(b);
  if (va.length !== vb.length) {
    return {
      match: "none",
      reason: "section layout differs",
      byteDiff: computeWasmByteDiff(rebuilt, deployed),
    };
  }
  for (let i = 0; i < va.length; i++) {
    const sa = va[i]!;
    const sb = vb[i]!;
    if (sa.id !== sb.id || sa.name !== sb.name || !bytesEqual(sa.content, sb.content)) {
      const label = sa.id === 0 ? `custom section "${sa.name}"` : `section id ${sa.id}`;
      return {
        match: "none",
        reason: `${label} differs`,
        byteDiff: computeWasmByteDiff(rebuilt, deployed),
      };
    }
  }
  // The bytes differ, yet no toolchain stamp VALUE does: whatever changed (e.g.
  // entries moved between sections, re-encoded headers) is not the difference
  // this normalization exists for. Do not accept a difference we cannot name.
  const normalizedKeys = differingToolchainKeys(a, b);
  if (normalizedKeys.length === 0) {
    return {
      match: "none",
      reason: "binary differs outside the toolchain stamp values",
      byteDiff: computeWasmByteDiff(rebuilt, deployed),
    };
  }
  return { match: "toolchain-metadata", normalizedKeys };
}
