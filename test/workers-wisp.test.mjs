import test from "node:test";
import assert from "node:assert/strict";
import { frame, parseFrame, continueFrame } from "../workers/wisp-framing.js";

test("Wisp frame round trip uses little-endian stream IDs", () => {
  const encoded = frame(2, 0x12345678, new Uint8Array([7, 8, 9]));
  assert.deepEqual([...encoded.slice(0, 5)], [2, 0x78, 0x56, 0x34, 0x12]);
  const decoded = parseFrame(encoded);
  assert.equal(decoded.type, 2);
  assert.equal(decoded.streamId, 0x12345678);
  assert.deepEqual([...decoded.data], [7, 8, 9]);
});
test("CONNECT decodes TCP host and port", () => {
  const host = new TextEncoder().encode("novelpia.com");
  const payload = new Uint8Array(3 + host.length);
  payload.set([1, 187, 1]); // 443 in little-endian
  payload.set(host, 3);
  const message = parseFrame(frame(1, 29, payload));
  assert.deepEqual([message.protocol, message.port, message.host], [1, 443, "novelpia.com"]);
});
test("CONTINUE carries initial window", () => {
  const parsed = parseFrame(continueFrame(0, 16));
  assert.equal(parsed.type, 3);
  assert.equal(parsed.streamId, 0);
  assert.equal(new DataView(parsed.data.buffer, parsed.data.byteOffset).getUint32(0, true), 16);
});
test("Rejects incomplete frames", () => {
  assert.throws(() => parseFrame(new Uint8Array([1, 0])), /Invalid frame size/);
});
