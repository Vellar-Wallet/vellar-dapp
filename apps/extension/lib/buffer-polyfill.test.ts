import { describe, expect, it } from "vitest";
import { Buffer as PolyfillBuffer } from "buffer";
import { Buffer as NodeBuffer } from "node:buffer";
import "./buffer-polyfill";

describe("Buffer polyfill parity with Node native Buffer (#700)", () => {
  it("ensures globalThis.Buffer is populated by buffer-polyfill", () => {
    expect(globalThis.Buffer).toBeDefined();
    expect(globalThis.Buffer).toBe(PolyfillBuffer);
  });

  describe("Buffer.from with Uint8Array and byte arrays", () => {
    it("matches Node Buffer for Uint8Array inputs", () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 32]);
      const poly = PolyfillBuffer.from(bytes);
      const node = NodeBuffer.from(bytes);

      expect(poly.length).toBe(node.length);
      expect(Array.from(poly)).toEqual(Array.from(node));
    });

    it("matches Node Buffer for empty Uint8Array", () => {
      const empty = new Uint8Array(0);
      const poly = PolyfillBuffer.from(empty);
      const node = NodeBuffer.from(empty);

      expect(poly.length).toBe(node.length);
      expect(poly.length).toBe(0);
      expect(Array.from(poly)).toEqual(Array.from(node));
    });

    it("matches Node Buffer for number array input", () => {
      const nums = [10, 20, 30, 40, 50];
      const poly = PolyfillBuffer.from(nums);
      const node = NodeBuffer.from(nums);

      expect(Array.from(poly)).toEqual(Array.from(node));
    });

    it("matches Node Buffer for ArrayBuffer input", () => {
      const arrayBuf = new Uint8Array([5, 15, 25, 35]).buffer;
      const poly = PolyfillBuffer.from(arrayBuf);
      const node = NodeBuffer.from(arrayBuf);

      expect(Array.from(poly)).toEqual(Array.from(node));
    });
  });

  describe("Buffer.from with string encodings (hex, utf8, base64)", () => {
    it("matches Node Buffer for hex string (lowercase)", () => {
      const hex = "deadbeef0123456789abcdef";
      const poly = PolyfillBuffer.from(hex, "hex");
      const node = NodeBuffer.from(hex, "hex");

      expect(Array.from(poly)).toEqual(Array.from(node));
      expect(poly.toString("hex")).toBe(node.toString("hex"));
    });

    it("matches Node Buffer for hex string (uppercase and mixed case)", () => {
      const hex = "DEADBEEF0123456789ABCDEF";
      const poly = PolyfillBuffer.from(hex, "hex");
      const node = NodeBuffer.from(hex, "hex");

      expect(Array.from(poly)).toEqual(Array.from(node));
      expect(poly.toString("hex")).toBe(node.toString("hex"));
    });

    it("matches Node Buffer for empty hex string", () => {
      const poly = PolyfillBuffer.from("", "hex");
      const node = NodeBuffer.from("", "hex");

      expect(poly.length).toBe(0);
      expect(Array.from(poly)).toEqual(Array.from(node));
    });

    it("matches Node Buffer for UTF-8 strings including multi-byte characters and emojis", () => {
      const str = "Vellar Wallet — 🚀 Safe, Non-Custodial, Ed25519 & Soroban 🔑";
      const poly = PolyfillBuffer.from(str, "utf8");
      const node = NodeBuffer.from(str, "utf8");

      expect(poly.length).toBe(node.length);
      expect(Array.from(poly)).toEqual(Array.from(node));
      expect(poly.toString("utf8")).toBe(node.toString("utf8"));
    });

    it("matches Node Buffer for base64 encoding and decoding", () => {
      const raw = "Sample payload for transaction signing verification";
      const base64 = NodeBuffer.from(raw).toString("base64");

      const poly = PolyfillBuffer.from(base64, "base64");
      const node = NodeBuffer.from(base64, "base64");

      expect(Array.from(poly)).toEqual(Array.from(node));
      expect(poly.toString("utf8")).toBe(raw);
      expect(poly.toString("base64")).toBe(node.toString("base64"));
    });
  });

  describe("Slice and Subarray operations", () => {
    it("matches Node Buffer for slice and subarray with offsets and negative indices", () => {
      const bytes = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
      const poly = PolyfillBuffer.from(bytes);
      const node = NodeBuffer.from(bytes);

      expect(Array.from(poly.slice(2, 6))).toEqual(Array.from(node.slice(2, 6)));
      expect(Array.from(poly.subarray(2, 6))).toEqual(Array.from(node.subarray(2, 6)));
      expect(Array.from(poly.slice(-4, -1))).toEqual(Array.from(node.slice(-4, -1)));
      expect(Array.from(poly.subarray(-4, -1))).toEqual(Array.from(node.subarray(-4, -1)));
      expect(Array.from(poly.slice(5))).toEqual(Array.from(node.slice(5)));
    });
  });

  describe("Buffer.byteLength, Buffer.concat, and Buffer.alloc", () => {
    it("matches Node Buffer for byteLength across encodings", () => {
      const text = "Hello world! 🌟 1234";
      expect(PolyfillBuffer.byteLength(text, "utf8")).toBe(NodeBuffer.byteLength(text, "utf8"));

      const hex = "010203040506";
      expect(PolyfillBuffer.byteLength(hex, "hex")).toBe(NodeBuffer.byteLength(hex, "hex"));

      const base64 = "AQIDBAUG";
      expect(PolyfillBuffer.byteLength(base64, "base64")).toBe(
        NodeBuffer.byteLength(base64, "base64"),
      );
    });

    it("matches Node Buffer for Buffer.concat", () => {
      const b1 = PolyfillBuffer.from("Part1 ");
      const b2 = PolyfillBuffer.from("Part2 ");
      const b3 = PolyfillBuffer.from("Part3");

      const nb1 = NodeBuffer.from("Part1 ");
      const nb2 = NodeBuffer.from("Part2 ");
      const nb3 = NodeBuffer.from("Part3");

      const polyConcat = PolyfillBuffer.concat([b1, b2, b3]);
      const nodeConcat = NodeBuffer.concat([nb1, nb2, nb3]);

      expect(polyConcat.length).toBe(nodeConcat.length);
      expect(polyConcat.toString("utf8")).toBe(nodeConcat.toString("utf8"));
    });

    it("matches Node Buffer for Buffer.alloc", () => {
      const poly = PolyfillBuffer.alloc(32);
      const node = NodeBuffer.alloc(32);

      expect(poly.length).toBe(node.length);
      expect(Array.from(poly)).toEqual(Array.from(node));
      expect(Array.from(poly).every((b) => b === 0)).toBe(true);
    });
  });

  describe("Empty and Large Buffer handling", () => {
    it("handles empty buffers strictly consistently", () => {
      const polyEmptyStr = PolyfillBuffer.from("");
      const nodeEmptyStr = NodeBuffer.from("");

      expect(polyEmptyStr.length).toBe(0);
      expect(nodeEmptyStr.length).toBe(0);
      expect(polyEmptyStr.toString("hex")).toBe("");
      expect(polyEmptyStr.toString("base64")).toBe("");

      const polyAlloc0 = PolyfillBuffer.alloc(0);
      const nodeAlloc0 = NodeBuffer.alloc(0);
      expect(polyAlloc0.length).toBe(nodeAlloc0.length);
    });

    it("handles large buffers (128 KB) identically without data corruption", () => {
      const size = 128 * 1024;
      const largeArray = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        largeArray[i] = (i * 31 + 17) & 0xff;
      }

      const poly = PolyfillBuffer.from(largeArray);
      const node = NodeBuffer.from(largeArray);

      expect(poly.length).toBe(node.length);
      expect(poly.length).toBe(size);

      // Check subsegments across boundaries
      expect(Array.from(poly.slice(0, 100))).toEqual(Array.from(node.slice(0, 100)));
      expect(Array.from(poly.slice(65530, 65540))).toEqual(Array.from(node.slice(65530, 65540)));
      expect(Array.from(poly.slice(-100))).toEqual(Array.from(node.slice(-100)));

      // Hex conversion parity
      const polyHex = poly.slice(0, 1024).toString("hex");
      const nodeHex = node.slice(0, 1024).toString("hex");
      expect(polyHex).toBe(nodeHex);
    });
  });
});
