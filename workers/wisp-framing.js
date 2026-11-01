// Small bounded Wisp framing parser for the Cloudflare Workers runtime.
// No network access is performed by this module; transport must explicitly
// enforce destination policies before opening outbound connections.
const dec = new TextDecoder("utf-8", { fatal: true });
export function parseFrame(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 5 || bytes.byteLength > 65541) throw new Error("Invalid frame size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1, true);
  const data = bytes.subarray(5);
  if (type === 1) {
    if (data.length < 3) throw new Error("Invalid connect frame");
    const protocol = data[0];
    const port = data[1] | (data[2] << 8);
    const host = dec.decode(data.subarray(3));
    return { type, streamId, protocol, port, host };
  }
  return { type, streamId, data };
}
export function frame(type, streamId, payload = new Uint8Array()) {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId, true);
  out.set(payload, 5);
  return out;
}
export function continueFrame(streamId, bufferSize = 16) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bufferSize, true);
  return frame(3, streamId, payload);
}
