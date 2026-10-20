import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareWasm,
  computeWasmByteDiff,
  parseWasmSections,
  TOOLCHAIN_META_KEYS,
  WasmParseError,
  type WasmSection,
} from "./wasm-compare";

// Fixtures: the SAME contract (contracts/attestation-registry) built by the
// canonical image (rustc 1.94.0) and by an otherwise identical image pinned to
// rustc 1.93.0 (same soroban-sdk lockfile, same stellar-cli) — a genuine
// cross-toolchain pair, not a synthetic one. See docs/decisions.md 2026-09-27
// for how they were produced and why this pair (not a stellar-cli version
// pair) is the real toolchain-metadata difference in this repo.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
const CANONICAL = fixture("attestation-registry.rustc-1.94.0.wasm");
const OTHER_RUSTC = fixture("attestation-registry.rustc-1.93.0.wasm");

// --- helpers: re-encode a module from sections (tests only) ------------------

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 7;
    byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function encode(sections: WasmSection[]): Uint8Array {
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const s of sections) {
    const body: number[] = [];
    if (s.id === 0) {
      const name = new TextEncoder().encode(s.name ?? "");
      body.push(...leb(name.length), ...name);
    }
    body.push(...s.content);
    out.push(s.id, ...leb(body.length), ...body);
  }
  return new Uint8Array(out);
}

function xdrString(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  const pad = (4 - (bytes.length % 4)) % 4;
  const len = bytes.length;
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...bytes,
    ...Array(pad).fill(0),
  ];
}

/** A contractmetav0 payload: SCMetaEntry(SC_META_V0) per [key, val]. */
function meta(entries: Array<[string, string]>, kind = 0): Uint8Array {
  const out: number[] = [];
  for (const [k, v] of entries) out.push(0, 0, 0, kind, ...xdrString(k), ...xdrString(v));
  return new Uint8Array(out);
}

function metaEntries(section: WasmSection): Array<[string, string]> {
  const view = new DataView(
    section.content.buffer,
    section.content.byteOffset,
    section.content.byteLength,
  );
  const dec = new TextDecoder();
  const out: Array<[string, string]> = [];
  let p = 0;
  const str = () => {
    const n = view.getUint32(p);
    p += 4;
    const s = dec.decode(section.content.subarray(p, p + n));
    p += n + ((4 - (n % 4)) % 4);
    return s;
  };
  while (p < section.content.length) {
    p += 4;
    out.push([str(), str()]);
  }
  return out;
}

/** Rebuild CANONICAL with each section passed through `edit`. */
function variant(
  edit: (s: WasmSection, i: number) => WasmSection | WasmSection[] | null,
): Uint8Array {
  return encode(
    parseWasmSections(CANONICAL).flatMap((s, i) => {
      const r = edit(s, i);
      return r === null ? [] : Array.isArray(r) ? r : [r];
    }),
  );
}

const isMeta = (s: WasmSection) => s.id === 0 && s.name === "contractmetav0";

function withMetaValue(key: string, val: string) {
  return variant((s) => {
    if (!isMeta(s)) return s;
    const entries = metaEntries(s).map(([k, v]) => [k, k === key ? val : v] as [string, string]);
    return { ...s, content: meta(entries) };
  });
}

// ---------------------------------------------------------------------------

describe("the real cross-toolchain fixture pair", () => {
  it("differs in bytes, and ONLY in the rustc contractmetav0 stamp", () => {
    expect(Buffer.compare(CANONICAL, OTHER_RUSTC)).not.toBe(0);
    const a = parseWasmSections(CANONICAL);
    const b = parseWasmSections(OTHER_RUSTC);
    const rsver = (secs: WasmSection[]) =>
      secs
        .filter(isMeta)
        .flatMap(metaEntries)
        .find(([k]) => k === "rsver")?.[1];
    expect(rsver(a)).toBe("1.94.0");
    expect(rsver(b)).toBe("1.93.0");
    const rssdkver = (secs: WasmSection[]) =>
      secs
        .filter(isMeta)
        .flatMap(metaEntries)
        .find(([k]) => k === "rssdkver")?.[1];
    expect(rssdkver(a)).toBe(rssdkver(b));
    // Every non-contractmetav0 section, including all code, is byte-identical.
    const strip = (secs: WasmSection[]) => secs.filter((s) => !isMeta(s));
    expect(strip(a).map((s) => [s.id, s.name, Buffer.from(s.content).toString("hex")])).toEqual(
      strip(b).map((s) => [s.id, s.name, Buffer.from(s.content).toString("hex")]),
    );
  });
});

describe("compareWasm", () => {
  it("byte-identical modules are an exact match", () => {
    expect(compareWasm(CANONICAL, new Uint8Array(CANONICAL))).toEqual({ match: "exact" });
  });

  it("A: a third-party build on a different rustc patch version verifies (toolchain-metadata)", () => {
    expect(compareWasm(OTHER_RUSTC, CANONICAL)).toEqual({
      match: "toolchain-metadata",
      normalizedKeys: ["rsver"],
    });
  });

  it.each(["rsver", "rssdkver"])("normalizes a differing %s stamp", (key) => {
    const other = withMetaValue(key, "0.0.0#0000000000000000000000000000000000000000");
    expect(compareWasm(other, CANONICAL)).toEqual({
      match: "toolchain-metadata",
      normalizedKeys: [key],
    });
  });

  it("the normalized key set is exactly rsver, rssdkver", () => {
    expect([...TOOLCHAIN_META_KEYS].sort()).toEqual(["rssdkver", "rsver"]);
  });

  describe("B: executable-code differences still FAIL", () => {
    it("rejects the real other-toolchain build with ONE code byte changed", () => {
      const sections = parseWasmSections(OTHER_RUSTC);
      const code = sections.findIndex((s) => s.id === 10);
      expect(code).toBeGreaterThan(-1);
      const mutated = sections.map((s, i) => {
        if (i !== code) return s;
        const content = new Uint8Array(s.content);
        content[content.length - 2] ^= 0x01;
        return { ...s, content };
      });
      expect(compareWasm(encode(mutated), CANONICAL)).toEqual({
        match: "none",
        reason: "section id 10 differs",
        byteDiff: expect.objectContaining({
          identical: false,
          lengthDelta: 0,
        }),
      });
    });

    it.each([
      [1, "type"],
      [2, "import"],
      [3, "function"],
      [7, "export"],
      [11, "data"],
    ])("rejects a change in section id %i (%s) even with toolchain stamps differing too", (id) => {
      const mutated = parseWasmSections(OTHER_RUSTC).map((s) => {
        if (s.id !== id) return s;
        const content = new Uint8Array(s.content);
        content[content.length - 1] ^= 0x01;
        return { ...s, content };
      });
      expect(compareWasm(encode(mutated), CANONICAL)).toMatchObject({ match: "none" });
    });

    it("rejects an added or removed section", () => {
      const extraFunction = variant((s) =>
        s.id === 7 ? [s, { id: 12, content: new Uint8Array([0]) }] : s,
      );
      expect(compareWasm(extraFunction, CANONICAL)).toMatchObject({ match: "none" });
    });

    it("rejects a changed contract interface (contractspecv0)", () => {
      const spec = variant((s) =>
        s.id === 0 && s.name === "contractspecv0"
          ? {
              ...s,
              content: new Uint8Array([...s.content].map((b, i) => (i === 10 ? b ^ 1 : b))),
            }
          : s,
      );
      expect(compareWasm(spec, CANONICAL)).toEqual({
        match: "none",
        reason: 'custom section "contractspecv0" differs',
        byteDiff: expect.objectContaining({
          identical: false,
          differingByteCount: 1,
          lengthDelta: 0,
        }),
      });
    });

    it("rejects a changed host-interface version (contractenvmetav0 — read by the host)", () => {
      const env = variant((s) =>
        s.id === 0 && s.name === "contractenvmetav0"
          ? {
              ...s,
              content: new Uint8Array(
                [...s.content].map((b, i) => (i === s.content.length - 1 ? b ^ 1 : b)),
              ),
            }
          : s,
      );
      expect(compareWasm(env, CANONICAL)).toMatchObject({ match: "none" });
    });

    it("rejects unparseable input rather than throwing", () => {
      expect(compareWasm(new Uint8Array([1, 2, 3]), CANONICAL)).toMatchObject({ match: "none" });
    });
  });

  describe("D: metadata that cannot be classified as toolchain provenance stays verified", () => {
    it("rejects a differing NON-toolchain contractmetav0 entry (e.g. contract-published meta)", () => {
      const withBinver = variant((s) =>
        isMeta(s) && metaEntries(s).some(([k]) => k === "rsver")
          ? { ...s, content: meta([...metaEntries(s), ["binver", "1.0.0"]]) }
          : s,
      );
      const withOtherBinver = variant((s) =>
        isMeta(s) && metaEntries(s).some(([k]) => k === "rsver")
          ? { ...s, content: meta([...metaEntries(s), ["binver", "2.0.0"]]) }
          : s,
      );
      expect(compareWasm(withBinver, withOtherBinver)).toEqual({
        match: "none",
        reason: 'custom section "contractmetav0" differs',
        byteDiff: expect.objectContaining({
          identical: false,
          differingByteCount: 1,
          lengthDelta: 0,
        }),
      });
      // …and an entry present on one side only.
      expect(compareWasm(withBinver, CANONICAL)).toMatchObject({ match: "none" });
    });

    it("compares a contractmetav0 section with an unknown SCMetaEntry kind RAW", () => {
      const unknownKind = (val: string) =>
        variant((s) =>
          isMeta(s) && metaEntries(s).some(([k]) => k === "rsver")
            ? { ...s, content: meta([["rsver", val]], 1) }
            : s,
        );
      // Same "rsver" key, but kind 1 is not SC_META_V0: not classifiable, so
      // the difference is NOT normalized away.
      expect(compareWasm(unknownKind("1.93.0"), unknownKind("1.94.0"))).toMatchObject({
        match: "none",
      });
    });

    it("compares a contractmetav0 section with non-zero XDR padding RAW", () => {
      const padded = variant((s) => {
        if (!isMeta(s) || !metaEntries(s).some(([k]) => k === "rsver")) return s;
        const content = meta(metaEntries(s));
        content[content.length - 1] = 0xff; // last entry's value has >=1 pad byte
        return { ...s, content };
      });
      expect(compareWasm(padded, CANONICAL)).toMatchObject({ match: "none" });
    });

    it("rejects a renamed or extra custom section", () => {
      const renamed = variant((s) =>
        s.id === 0 && s.name === "contractenvmetav0" ? { ...s, name: "contractenvmetav1" } : s,
      );
      expect(compareWasm(renamed, CANONICAL)).toMatchObject({ match: "none" });
      const extra = variant((s) =>
        s.id === 0 && s.name === "contractspecv0"
          ? [s, { id: 0, name: "vendor", content: new Uint8Array([1]) }]
          : s,
      );
      expect(compareWasm(extra, CANONICAL)).toMatchObject({ match: "none" });
    });

    it("rejects bytes that differ outside every recognized stamp (e.g. re-encoded headers)", () => {
      // Same logical entries, but the contractmetav0 section is re-encoded with
      // the entries in reverse order — nothing a toolchain VERSION changes.
      // Normalized entry sets are equal, yet the raw bytes differ outside any
      // stamp VALUE: do not accept a difference we did not account for.
      const reordered = variant((s) => {
        if (!isMeta(s)) return s;
        return { ...s, content: meta([...metaEntries(s)].reverse()) };
      });
      expect(compareWasm(reordered, CANONICAL)).toMatchObject({ match: "none" });
    });
  });
});

describe("parseWasmSections", () => {
  it("parses the canonical Soroban layout", () => {
    const names = parseWasmSections(CANONICAL).map((s) => (s.id === 0 ? s.name : s.id));
    expect(names).toEqual([
      1,
      2,
      3,
      5,
      6,
      7,
      10,
      11,
      "contractspecv0",
      "contractenvmetav0",
      "contractmetav0",
    ]);
  });

  it("rejects a non-wasm header, a truncated section, and an overlong LEB128", () => {
    expect(() => parseWasmSections(new TextEncoder().encode("vela-stub-wasm\nx"))).toThrow(
      WasmParseError,
    );
    expect(() => parseWasmSections(CANONICAL.subarray(0, CANONICAL.length - 3))).toThrow(
      WasmParseError,
    );
    const overlong = new Uint8Array([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
    ]);
    expect(() => parseWasmSections(overlong)).toThrow(WasmParseError);
  });
});

describe("computeWasmByteDiff & mismatch byte-level diff report (#538)", () => {
  it("returns an identical report with no firstDifference when blobs match byte-for-byte", () => {
    const report = computeWasmByteDiff(CANONICAL, new Uint8Array(CANONICAL));
    expect(report).toEqual({
      identical: true,
      rebuiltLength: CANONICAL.length,
      deployedLength: CANONICAL.length,
      lengthDelta: 0,
      differingByteCount: 0,
      differingSpanCount: 0,
      firstDifference: null,
    });
  });

  it("reports exact byte offset, span length, and hex slices for same-length byte differences", () => {
    const mutated = new Uint8Array(CANONICAL);
    // Flip a 3-byte contiguous span starting at offset 40 and a 1-byte flip at offset 100
    mutated[40] = CANONICAL[40]! ^ 0xff;
    mutated[41] = CANONICAL[41]! ^ 0xff;
    mutated[42] = CANONICAL[42]! ^ 0xff;
    mutated[100] = CANONICAL[100]! ^ 0x01;

    const comparison = compareWasm(mutated, CANONICAL);
    expect(comparison.match).toBe("none");
    if (comparison.match === "none") {
      expect(comparison.byteDiff).toEqual({
        identical: false,
        rebuiltLength: CANONICAL.length,
        deployedLength: CANONICAL.length,
        lengthDelta: 0,
        differingByteCount: 4,
        differingSpanCount: 2,
        firstDifference: {
          offset: 40,
          length: 3,
          rebuiltHex: Buffer.from(mutated.subarray(40, 43)).toString("hex"),
          deployedHex: Buffer.from(CANONICAL.subarray(40, 43)).toString("hex"),
        },
      });
    }
  });

  it("reports lengthDelta, differingByteCount, and firstDifference when two wasm blobs have different total lengths", () => {
    const withExtraSection = variant((s) =>
      s.id === 0 && s.name === "contractspecv0"
        ? [s, { id: 0, name: "vendor", content: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }]
        : s,
    );

    const comparison = compareWasm(withExtraSection, CANONICAL);
    expect(comparison.match).toBe("none");
    if (comparison.match === "none") {
      expect(comparison.reason).toBe("section layout differs");
      expect(comparison.byteDiff.identical).toBe(false);
      expect(comparison.byteDiff.rebuiltLength).toBe(withExtraSection.length);
      expect(comparison.byteDiff.deployedLength).toBe(CANONICAL.length);
      expect(comparison.byteDiff.lengthDelta).toBe(withExtraSection.length - CANONICAL.length);
      expect(comparison.byteDiff.lengthDelta).toBeGreaterThan(0);
      expect(comparison.byteDiff.differingByteCount).toBeGreaterThanOrEqual(
        withExtraSection.length - CANONICAL.length,
      );
      expect(comparison.byteDiff.firstDifference).not.toBeNull();
      expect(comparison.byteDiff.firstDifference!.offset).toBeGreaterThan(0);
      expect(comparison.byteDiff.firstDifference!.length).toBeGreaterThan(0);
    }

    // Also test a pure prefix truncation where the first minLen bytes match identically
    const truncated = CANONICAL.subarray(0, CANONICAL.length - 12);
    const truncComparison = compareWasm(truncated, CANONICAL);
    expect(truncComparison.match).toBe("none");
    if (truncComparison.match === "none") {
      expect(truncComparison.byteDiff).toEqual({
        identical: false,
        rebuiltLength: CANONICAL.length - 12,
        deployedLength: CANONICAL.length,
        lengthDelta: -12,
        differingByteCount: 12,
        differingSpanCount: 1,
        firstDifference: {
          offset: CANONICAL.length - 12,
          length: 12,
          rebuiltHex: "",
          deployedHex: Buffer.from(CANONICAL.subarray(CANONICAL.length - 12)).toString("hex"),
        },
      });
    }
  });
});
