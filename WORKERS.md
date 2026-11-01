# Cloudflare Workers port (isolated branch)

The `main` branch remains the Node.js implementation. All Workers work is on
`feat/cloudflare-workers`; nothing is merged automatically.

## What is implemented

- Worker entrypoint, Cloudflare static assets binding, and cookie access gate.
- Same-origin WebSocket upgrade route at `/wisp/`.
- TCP-only Wisp framing and initial v1/v2 handshake using Cloudflare TCP sockets.
- Destination allowlist: `novelpia.com` and `www.novelpia.com`, TCP ports 80/443.
- Pinned Scramjet 2 browser asset staging (run at build time).
- GitHub Actions syntax, asset build and Wisp binary framing checks.

## What is **not yet verified**

**This is not a production-tested proxy.** Browser-side page navigation, service
worker registration, Wisp TLS, streaming backpressure, per-session limits and
Cloudflare Free quotas have NOT been tested end-to-end. The latest CI results
must be inspected before any deployment. The implementation is experimental.

## Local build and trial

Requires Node.js 22+, npm, a Cloudflare account, and CLI authentication.

```bash
git switch feat/cloudflare-workers
npm install --no-save --package-lock=false --ignore-scripts \
  @mercuryworkshop/proxy-bootstrap@0.0.5 \
  @mercuryworkshop/scramjet@2.0.67-alpha.2 \
  @mercuryworkshop/scramjet-controller@0.0.14 \
  @mercuryworkshop/scramjet-utils@0.0.3 \
  @mercuryworkshop/libcurl-transport@2.0.5
node scripts/stage-workers-assets.mjs
node --test test/workers-wisp.test.mjs
npx --yes wrangler@4 login
npx --yes wrangler@4 secret put PROXY_ACCESS_KEY
npx --yes wrangler@4 dev
```

If `secret put` does not apply to local development, use a locally created
`.dev.vars` containing `PROXY_ACCESS_KEY=...` and keep it untracked.
Do not commit the secret.

Open the local Worker URL, log in, and then test navigation. Browser devtools
should show `/wisp/` switching protocols (101), and a successful full load
of the NovelPia home page. **Do not consider a healthy /__health response
proof of working proxying.**

## Cloud deployment

```bash
npx --yes wrangler@4 deploy
```

Re-run asset staging before deployment if `public/` has been rebuilt.

A session token is derived from the access key. Rotate `PROXY_ACCESS_KEY` to
invalidate all existing sessions. Free Workers request/CPU/connectivity
limits still apply and the proxy provider's terms must be respected.

## Caveats and implementation checklist

- This is deliberately restricted to two NovelPia hostnames (not an open proxy).
- No UDP and no arbitrary TCP ports. Third-party login resources may fail.
- The current implementation has no distributed rate limiter.
- Cloudflare's `connect()` performs destination resolution; independently
  verifiable DNS/SSRF filtering is not implemented.
- Monitor Wisp stream lifecycle, backpressure, socket caps and memory.
- Test Wisp v1 and v2 handshake, binary data, closes, client reconnection,
  streaming, service workers, and session cookies on an actual Worker.
- `/__health` indicates Worker responsiveness only, not end-to-end readiness.
