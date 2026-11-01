/**
 * Experimental Cloudflare Workers entrypoint.
 *
 * NOTE: The Node.js proxy-bootstrap and Wisp TCP server are NOT available in
 * Workers. An upstream that explicitly permits proxying is required for
 * /bootstrap-init.js and /wisp/ until native Worker implementations are added.
 */
const SAFE_ASSET_METHODS = new Set(["GET", "HEAD"]);
const RESERVED = ["/wisp/", "/bootstrap-init.js", "/__unlock", "/__privacy/purge"];

function blockedResponse(message, status = 503) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function authorized(request, env) {
  if (!env.PROXY_ACCESS_KEY) return false; // fail closed
  return request.headers.get("Authorization") === `Bearer ${env.PROXY_ACCESS_KEY}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

    if (url.pathname === "/__health") {
      return new Response(JSON.stringify({ ok: true, mode: "workers-experimental", proxyReady: false }), {
        headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (RESERVED.some(path => url.pathname === path || (path.endsWith("/") && url.pathname.startsWith(path)))) {
      return blockedResponse("Proxy bootstrap and Wisp backend are not yet ported to Workers.", 501);
    }

    // Do not accidentally publish an unauthenticated open proxy or the static UI.
    if (!env.PROXY_ACCESS_KEY) {
      return blockedResponse("Configure PROXY_ACCESS_KEY as a Worker secret before deployment.");
    }
    if (!authorized(request, env)) {
      return new Response("Unauthorized: supply an Authorization Bearer token", {
        status: 401,
        headers: { ...headers, "cache-control": "no-store", "www-authenticate": 'Bearer realm="Scramjet Workers"' },
      });
    }
    if (!SAFE_ASSET_METHODS.has(request.method)) return blockedResponse("Method not allowed", 405);
    const result = await env.ASSETS.fetch(request);
    const response = new Response(result.body, result);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  },
};
