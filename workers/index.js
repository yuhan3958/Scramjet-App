import { upgradeWisp } from "./wisp.js";
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(key) {
  const data = encoder.encode("scramjet-worker-session:v1:" + key);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

function htmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function loginPage(error = "") {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8">
<title>Scramjet Private Access</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui;background:#101014;color:white;min-height:100vh;display:grid;place-items:center}
form{display:grid;gap:12px;width:min(380px,90vw)}input,button{font:inherit;padding:12px;border-radius:8px}
input{background:#20202a;color:white;border:1px solid #666}button{cursor:pointer}</style>
<form method="post" action="/__unlock"><h1>Scramjet Access</h1>
<input type="password" name="key" autocomplete="current-password" required>
<button>Unlock</button><p role="alert">${htmlEscape(error)}</p></form></html>`, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

async function loggedIn(request, env) {
  if (!env.PROXY_ACCESS_KEY) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)__Host-sj_session=([0-9a-f]{64})(?:;|$)/);
  if (!match) return false;
  const expected = await fingerprint(env.PROXY_ACCESS_KEY);
  // Use subtle timing-safe comparison rather than ordinary string equality.
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(match[1]);
  return crypto.subtle.timingSafeEqual(expectedBytes, actualBytes);
}

function respondJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__health") {
      return respondJson({ ok: true, mode: "workers-experimental", proxyReady: false, transportImplemented: true, integrationTested: false });
    }
    if (!env.PROXY_ACCESS_KEY) {
      return respondJson({ error: "Set PROXY_ACCESS_KEY using wrangler secret put" }, 503);
    }
    if (url.pathname === "/__unlock" && request.method === "POST") {
      const type = request.headers.get("content-type") || "";
      if (!type.startsWith("application/x-www-form-urlencoded")) return respondJson({ error: "Unsupported form" }, 415);
      const form = await request.formData();
      const submitted = String(form.get("key") || "");
      const a = encoder.encode(submitted), b = encoder.encode(env.PROXY_ACCESS_KEY);
      if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return loginPage("잘못된 접근 키");
      const token = await fingerprint(env.PROXY_ACCESS_KEY);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `__Host-sj_session=${token}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`,
          "cache-control": "no-store"
        }
      });
    }
    if (url.pathname === "/__privacy/purge" && request.method === "POST") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (!(await loggedIn(request, env))) return loginPage();
    if (url.pathname === "/wisp/" || url.pathname.startsWith("/wisp/")) {
      return upgradeWisp(request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return respondJson({ error: "Method not allowed" }, 405);
    const assetResponse = await env.ASSETS.fetch(request);
    const response = new Response(assetResponse.body, assetResponse);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return response;
  }
};
