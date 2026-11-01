import { connect } from "cloudflare:sockets";
import { parseFrame, frame, continueFrame } from "./wisp-framing.js";

// Restrict outbound sockets to the domains used by the site and common web assets.
// Avoid arbitrary destinations, IP literals, local hosts and private-network access.
const EXACT_HOSTS = new Set([
  "novelpia.com", "www.novelpia.com", "images.novelpia.com",
  "accounts.google.com", "fonts.googleapis.com", "fonts.gstatic.com",
  "www.google.com", "www.gstatic.com", "www.google-analytics.com",
  "www.googletagmanager.com", "www.googleadservices.com",
  "googleads.g.doubleclick.net", "stats.g.doubleclick.net",
  "connect.facebook.net", "static.cloudflareinsights.com",
  "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
  "ajax.googleapis.com", "code.jquery.com",
]);
const HOST_SUFFIXES = [
  ".novelpia.com",
  ".googleusercontent.com", ".gstatic.com", ".googleapis.com",
  ".googlevideo.com", ".ggpht.com", ".google.com",
  ".youtube.com", ".ytimg.com", ".doubleclick.net",
];
function allowedHost(value) {
  if (typeof value !== "string") return false;
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) ||
      host.includes("..") || /^[0-9.]+$/.test(host) ||
      host === "localhost" || host.endsWith(".localhost")) return false;
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}
const PORTS = new Set([80, 443]);
const MAX_STREAMS = 5;
const MAX_QUEUED_BYTES = 256 * 1024;
const OPEN_TIMEOUT_MS = 12000;
const closeFrame = (id, reason = 2) => frame(4, id, Uint8Array.of(reason));

export function upgradeWisp(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response("Upgrade required", { status: 426 });
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return new Response("Forbidden", { status: 403 });

  const pair = new WebSocketPair();
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept();
  const streams = new Map();
  let ended = false;
  let handshakeComplete = !request.headers.has("Sec-WebSocket-Protocol");

  function send(data) {
    if (!ended && server.readyState === WebSocket.OPEN) server.send(data);
  }
  send(handshakeComplete ? continueFrame(0) : frame(5, 0, Uint8Array.of(2, 1)));

  function terminate(id, reason = 2, source = "unknown") {
    const state = streams.get(id);
    if (!state) return;
    streams.delete(id);
    if (state.timer) clearTimeout(state.timer);
    try { state.socket?.close(); } catch {}
    console.log("wisp stream closed", id, reason, source, "lifetime_ms", Date.now() - state.startedAt, "bytes_to_origin", state.bytesUp, "bytes_from_origin", state.bytesDown);
    send(closeFrame(id, reason));
  }

  async function pump(id, state) {
    const reader = state.socket.readable.getReader();
    try {
      while (streams.get(id) === state) {
        const { value, done } = await reader.read();
        if (done) break;
        state.bytesDown += value.byteLength;
        for (let off = 0; off < value.byteLength; off += 32768) {
          send(frame(2, id, value.subarray(off, off + 32768)));
        }
      }
    } catch (error) {
      console.warn("wisp tcp read failed", id, String(error));
    } finally {
      try { reader.releaseLock(); } catch {}
      terminate(id, 2, "origin_eof_or_read_failure");
    }
  }

  async function flush(id, state) {
    if (state.flushing || !state.writer) return;
    state.flushing = true;
    try {
      while (streams.get(id) === state && state.pending.length) {
        const chunk = state.pending.shift();
        await state.writer.write(chunk);
        state.queuedBytes -= chunk.byteLength;
        state.bytesUp += chunk.byteLength;
        send(continueFrame(id));
      }
    } catch (error) {
      console.warn("wisp tcp write failed", id, String(error));
      terminate(id, 3, "origin_write_failure");
    } finally {
      state.flushing = false;
    }
  }

  async function open(id, state, host, port) {
    console.log("wisp connect start", id, host, port);
    try {
      const socket = connect({ hostname: host, port }, { secureTransport: "off" });
      state.socket = socket;
      await Promise.race([
        socket.opened,
        new Promise((_, reject) => {
          state.timer = setTimeout(() => reject(new Error("TCP connect timeout")), OPEN_TIMEOUT_MS);
        })
      ]);
      clearTimeout(state.timer);
      state.timer = null;
      if (streams.get(id) !== state) { socket.close(); return; }
      state.writer = socket.writable.getWriter();
      console.log("wisp tcp opened", id, host, port);
      send(continueFrame(id));
      void pump(id, state);
      void flush(id, state);
    } catch (error) {
      console.warn("wisp tcp connect failed", id, host, port, String(error));
      terminate(id, 3, "tcp_connect_failure");
    }
  }

  server.addEventListener("message", event => {
    void (async () => {
      const payload = event.data instanceof ArrayBuffer
        ? event.data
        : event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : null;
      if (!payload) {
        console.warn("wisp ignored non-binary message");
        return;
      }
      let msg;
      try { msg = parseFrame(payload); } catch (error) {
        console.warn("wisp invalid frame", String(error));
        return;
      }
      const id = msg.streamId;
      if (!handshakeComplete) {
        if (msg.type === 5 && id === 0 && msg.data.byteLength >= 2) {
          handshakeComplete = true;
          send(continueFrame(0));
        } else { server.close(1002, "Invalid Wisp handshake"); }
        return;
      }
      if (id === 0) return;
      if (msg.type === 1) {
        const host = msg.host?.toLowerCase().replace(/\.$/, "");
        if (streams.has(id) || streams.size >= MAX_STREAMS ||
            msg.protocol !== 1 || !PORTS.has(msg.port) || !allowedHost(host)) {
          console.warn("wisp connect denied", id, host, msg.port);
          send(closeFrame(id, 2));
          return;
        }
        const state = { socket: null, writer: null, pending: [], queuedBytes: 0, flushing: false, timer: null, startedAt: Date.now(), bytesUp: 0, bytesDown: 0 };
        streams.set(id, state);
        void open(id, state, host, msg.port);
      } else if (msg.type === 2) {
        const state = streams.get(id);
        if (!state) return;
        if (state.queuedBytes + msg.data.byteLength > MAX_QUEUED_BYTES) {
          console.warn("wisp write buffer exceeded", id);
          terminate(id, 3, "write_buffer_full");
          return;
        }
        // Queue data even before socket.opened resolves. Preserve arrival order.
        state.pending.push(msg.data.slice());
        state.queuedBytes += msg.data.byteLength;
        void flush(id, state);
      } else if (msg.type === 4) {
        terminate(id, msg.data[0] ?? 2, "client_close");
      }
    })().catch(error => console.warn("wisp message error", String(error)));
  });
  const cleanup = () => {
    console.log("wisp websocket cleanup", "active_streams", streams.size);
    ended = true;
    for (const state of streams.values()) {
      if (state.timer) clearTimeout(state.timer);
      try { state.socket?.close(); } catch {}
    }
    streams.clear();
  };
  server.addEventListener("close", cleanup);
  server.addEventListener("error", cleanup);
  const protocol = request.headers.get("Sec-WebSocket-Protocol");
  const headers = protocol ? { "Sec-WebSocket-Protocol": protocol.split(",")[0].trim() } : {};
  return new Response(null, { status: 101, webSocket: pair[0], headers });
}
