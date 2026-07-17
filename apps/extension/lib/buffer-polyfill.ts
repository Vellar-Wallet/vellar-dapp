import { Buffer } from "buffer";

// stellar-sdk (via passkey-kit) references the global `Buffer`; MV3 service
// workers have no Node globals. Import this module FIRST wherever those
// libraries load.
const globals = globalThis as { Buffer?: typeof Buffer };
if (!globals.Buffer) globals.Buffer = Buffer;
