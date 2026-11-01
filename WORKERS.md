# Experimental Cloudflare Workers branch

This branch preserves the original Node.js application in `main` and adds
an isolated Cloudflare Workers entrypoint.

## Status

**Not a working Scramjet proxy yet.** The Worker serves the repository's
static files *only after* Bearer authentication. `/__health` reports
`proxyReady: false`. `/bootstrap-init.js` and `/wisp/` deliberately return
501 rather than silently exposing an unusable or unauthenticated proxy.

Reasons:
- `@mercuryworkshop/proxy-bootstrap` uses Node.js HTTP server hooks.
- `@mercuryworkshop/wisp-js/server` uses Node.js sockets.
- Workers cannot directly run either server implementation.
- The frontend requires working bootstrap/controller assets and a compatible
  Wisp transport before real navigation can work.
- The unrelated Rust framework named "Wisp" is **not** the MercuryWorkshop
  Wisp protocol implementation.

## Try the Worker skeleton

```sh
git switch feat/cloudflare-workers
npm install --no-save wrangler
npx wrangler secret put PROXY_ACCESS_KEY
npx wrangler dev
```

Test the health route:

```sh
curl http://localhost:8787/__health
```

Test a protected static file:

```sh
curl -H "Authorization: Bearer YOUR_SECRET" http://localhost:8787/index.css
```

To deploy (after reviewing Cloudflare policy and limits):

```sh
npx wrangler deploy
```

The displayed HTML is not yet a functional proxy. Do not paste access tokens
into query strings or publish a public proxy without rate limits.

## Porting work remaining

1. Build/pin a browser-compatible Scramjet bootstrap asset distribution.
2. Implement the MercuryWorkshop Wisp TCP protocol in a Worker-compatible
   runtime using Cloudflare `connect()`, with connection cleanup/backpressure.
3. Strictly deny private IPs, loopback, metadata endpoints, direct-IP SSRF,
   dangerous destination ports and abusive use; add per-client rate limits.
4. Implement secure cookie-based login (the Bearer header in this prototype
   is only suitable for diagnostics, not browser-based navigation).
5. Add integration tests for websocket upgrade (101), navigation, cookies,
   reconnect, streaming and free-plan quotas.

Cloudflare's free plan limits and the provider's proxy/TOS requirements must
be checked before production deployment.
