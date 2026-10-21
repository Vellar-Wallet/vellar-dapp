import { Buffer } from "buffer";

// stellar-sdk (via passkey-kit) references the global `Buffer`; MV3 service
// workers have no Node globals. Import this module FIRST wherever those
// libraries load.
//
// Enumerated Buffer operations used across apps/extension (Issue #700):
// - Buffer.from(Uint8Array | ArrayBuffer | number[]) (tx-signer.ts)
// - Buffer.from(string, "hex") (hex decoding)
// - Buffer.from(string, "utf8")
// - Buffer.from(string, "base64") (signature formatting)
// - buf.toString("hex") (public keys, hashes)
// - buf.toString("utf8")
// - buf.toString("base64")
// - buf.subarray(start, end) / buf.slice(start, end)
// - buf.length and Buffer.byteLength(string, encoding)
// - Buffer.concat([buf1, buf2])
// - Buffer.isBuffer(val)
// - Empty inputs: Buffer.from(""), Buffer.from([]), Buffer.alloc(0)
// - Large inputs: multi-KB / MB payload conversions
const globals = globalThis as { Buffer?: typeof Buffer };
if (!globals.Buffer) globals.Buffer = Buffer;
