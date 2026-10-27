"use strict";

import {
  toPortableGoogleAuthUrl,
  isGoogleAuthUrl,
  parseNovelPiaCallback,
} from "./oauth-bridge.js";

const NOVELPIA_HOME = "https://novelpia.com/";

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");

const oauthFab = document.getElementById("oauth-fab");
const oauthBridge = document.getElementById("oauth-bridge");
const oauthClose = document.getElementById("oauth-close");
const oauthOpenGoogle = document.getElementById("oauth-open-google");
const oauthShowReturn = document.getElementById("oauth-show-return");
const oauthReturnPanel = document.getElementById("oauth-return-panel");
const oauthCallback = document.getElementById("oauth-callback");
const oauthSubmitCallback = document.getElementById("oauth-submit-callback");
const oauthRefresh = document.getElementById("oauth-refresh");
const oauthStatus = document.getElementById("oauth-status");
const currentUrlBar = document.getElementById("current-url-bar");
const currentUrlInput = document.getElementById("current-url");
const currentUrlCopy = document.getElementById("current-url-copy");
const frameElement = document.getElementById("sj-frame");
const perfFab = document.getElementById("perf-fab");
const perfPanel = document.getElementById("perf-panel");
const perfClose = document.getElementById("perf-close");
const perfClear = document.getElementById("perf-clear");
const perfSummary = document.getElementById("perf-summary");
const perfLog = document.getElementById("perf-log");

let controller = null;
let frame = null;
let lastGoogleAuthUrl = null;
let callbackPending = false;
let currentTargetUrl = null;
let performanceProfiler = null;
let rewrittenStaticCache = null;

const MAX_PARALLEL_CONNECTIONS = [256, 256, 256];
const REWRITTEN_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const REWRITTEN_CACHE_MAX_ENTRIES = 256;
const performanceEntries = [];

function setStatus(message, kind = "info") {
  oauthStatus.textContent = message;
  oauthStatus.dataset.kind = kind;
}

function setBridgeVisible(visible) {
  oauthBridge.hidden = !visible;
}

function redactSensitiveUrl(url) {
  try {
    const parsed = new URL(String(url));
    for (const key of ["code", "state", "access_token", "id_token"]) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}

function updateCurrentUrl(url) {
  if (!url) return;
  currentTargetUrl = String(url);
  currentUrlBar.hidden = false;
  currentUrlInput.value = redactSensitiveUrl(currentTargetUrl);
}

function isNovelPiaUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "novelpia.com" || url.hostname === "www.novelpia.com")
    );
  } catch {
    return false;
  }
}

function performanceLabel(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.hostname}${parsed.pathname}${parsed.search ? "?…" : ""}`;
  } catch {
    return String(url).slice(0, 120);
  }
}

function bodySize(body, headers) {
  const contentLength = Number(headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength >= 0) return contentLength;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return 0;
}

async function bodyToArrayBuffer(body) {
  if (body == null) return new ArrayBuffer(0);
  if (typeof body === "string") return new TextEncoder().encode(body).buffer;
  if (body instanceof ArrayBuffer) return body.slice(0);
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (body instanceof Blob) return body.arrayBuffer();
  if (body instanceof ReadableStream) return new Response(body).arrayBuffer();
  return new Response(body).arrayBuffer();
}

function renderPerformancePanel() {
  if (!perfSummary || !perfLog) return;

  const total = performanceEntries.length;
  const hits = performanceEntries.filter((entry) => entry.cache === "rewritten").length;
  const avg = total
    ? performanceEntries.reduce((sum, entry) => sum + entry.totalMs, 0) / total
    : 0;
  const avgRewriteEntries = performanceEntries.filter(
    (entry) => Number.isFinite(entry.rewriteMs),
  );
  const avgRewrite = avgRewriteEntries.length
    ? avgRewriteEntries.reduce((sum, entry) => sum + entry.rewriteMs, 0) /
      avgRewriteEntries.length
    : 0;

  perfSummary.textContent =
    `요청 ${total} · rewrite-cache hit ${hits} · 평균 ${avg.toFixed(0)}ms · 평균 rewrite ${avgRewrite.toFixed(0)}ms`;

  perfLog.textContent = performanceEntries
    .slice(0, 30)
    .map((entry) => {
      const fetchPart = Number.isFinite(entry.fetchMs)
        ? `fetch ${entry.fetchMs.toFixed(0)}ms`
        : "fetch —";
      const rewritePart = Number.isFinite(entry.rewriteMs)
        ? `rewrite ${entry.rewriteMs.toFixed(0)}ms`
        : "rewrite —";
      const sizePart = entry.bytes
        ? `${(entry.bytes / 1024).toFixed(entry.bytes >= 1024 * 1024 ? 0 : 1)}KB`
        : "size —";
      return `${entry.cache === "rewritten" ? "HIT " : "    "}${entry.destination.padEnd(7)} ${entry.totalMs.toFixed(0).padStart(5)}ms · ${fetchPart} · ${rewritePart} · ${sizePart} · ${entry.url}`;
    })
    .join("\n");
}

function addPerformanceEntry(entry) {
  performanceEntries.unshift(entry);
  if (performanceEntries.length > 100) performanceEntries.length = 100;
  renderPerformancePanel();
}

function maximizeTransportParallelism(transport) {
  if (!transport) return;
  transport.connections = [...MAX_PARALLEL_CONNECTIONS];

  if (transport.session?.set_connections) {
    transport.session.set_connections(...MAX_PARALLEL_CONNECTIONS);
  }
}

function createPerformanceProfilerPlugin() {
  const Base = $scramjetUtils.ManagedPlugin;

  return new (class PerformanceProfilerPlugin extends Base {
    constructor() {
      super("local-performance-profiler", []);
      this.started = new WeakMap();
      this.fetchStarted = new WeakMap();
      this.fetchFinished = new WeakMap();
    }

    install(targetFrame) {
      super.install(targetFrame);

      this.tap(targetFrame.hooks.fetch.intercept, (ctx) => {
        this.started.set(ctx.request, performance.now());
      });

      this.tap(targetFrame.hooks.fetch.request, (ctx) => {
        if (!this.started.has(ctx.request)) {
          this.started.set(ctx.request, performance.now());
        }
        this.fetchStarted.set(ctx.request, performance.now());
      });

      this.tap(targetFrame.hooks.fetch.preresponse, (ctx) => {
        this.fetchFinished.set(ctx.request, performance.now());
      });

      this.tap(targetFrame.hooks.fetch.response, (ctx, props) => {
        const end = performance.now();
        const start = this.started.get(ctx.request) ?? end;
        const fetchStart = this.fetchStarted.get(ctx.request);
        const fetchEnd = this.fetchFinished.get(ctx.request);

        addPerformanceEntry({
          cache: "pipeline",
          url: performanceLabel(ctx.parsed.url.href),
          destination: String(ctx.parsed.destination || "other"),
          totalMs: end - start,
          fetchMs:
            Number.isFinite(fetchStart) && Number.isFinite(fetchEnd)
              ? fetchEnd - fetchStart
              : NaN,
          rewriteMs: Number.isFinite(fetchEnd) ? end - fetchEnd : NaN,
          bytes: bodySize(props.response.body, props.response.headers),
        });
      });
    }

    recordRewriteCacheHit(ctx, bytes, start) {
      addPerformanceEntry({
        cache: "rewritten",
        url: performanceLabel(ctx.parsed.url.href),
        destination: String(ctx.parsed.destination || "other"),
        totalMs: performance.now() - start,
        fetchMs: 0,
        rewriteMs: 0,
        bytes,
      });
    }
  })();
}

function createRewrittenStaticCachePlugin(profiler) {
  const Base = $scramjetUtils.ManagedPlugin;

  return new (class RewrittenStaticCachePlugin extends Base {
    constructor() {
      super("rewritten-static-cache", []);
      this.entries = new Map();
      this.totalBytes = 0;
    }

    keyFor(ctx) {
      const headers = ctx.request.initialHeaders;
      return [
        ctx.parsed.url.href,
        ctx.parsed.destination || "",
        ctx.parsed.isModule ? "module" : "classic",
        headers.get("accept") || "",
        headers.get("accept-language") || "",
      ].join("\n");
    }

    eligibleRequest(ctx) {
      if (ctx.request.method !== "GET") return false;
      if (!["script", "style"].includes(ctx.parsed.destination)) return false;

      try {
        const url = new URL(ctx.parsed.url.href);
        if (url.protocol !== "https:") return false;
        if (/\/(?:proc|api|oauth|login)(?:\/|$)/i.test(url.pathname)) return false;
        for (const key of ["code", "state", "access_token", "id_token"]) {
          if (url.searchParams.has(key)) return false;
        }
      } catch {
        return false;
      }

      return true;
    }

    storableResponse(ctx, response) {
      if (!this.eligibleRequest(ctx) || response.status !== 200) return false;

      const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
      if (/\b(?:no-store|no-cache|private)\b/.test(cacheControl)) return false;

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      return (
        ctx.parsed.destination === "script"
          ? /javascript|ecmascript/.test(contentType)
          : contentType.includes("text/css")
      );
    }

    touch(key, entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    evict() {
      while (
        this.entries.size > REWRITTEN_CACHE_MAX_ENTRIES ||
        this.totalBytes > REWRITTEN_CACHE_MAX_BYTES
      ) {
        const oldestKey = this.entries.keys().next().value;
        if (!oldestKey) break;
        const oldest = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        this.totalBytes -= oldest?.bytes || 0;
      }
    }

    install(targetFrame) {
      super.install(targetFrame);

      this.tap(targetFrame.hooks.fetch.intercept, (ctx, props) => {
        if (!this.eligibleRequest(ctx)) return;

        const started = performance.now();
        const key = this.keyFor(ctx);
        const cached = this.entries.get(key);
        if (!cached) return;

        this.touch(key, cached);

        props.response = {
          body: cached.body.slice(0),
          headers: cached.headers.clone(),
          status: cached.status,
          statusText: cached.statusText,
        };

        profiler?.recordRewriteCacheHit(ctx, cached.bytes, started);
      });

      this.tap(targetFrame.hooks.fetch.response, async (ctx, props) => {
        if (!this.storableResponse(ctx, props.response)) return;
        if (props.response.body instanceof ReadableStream) return;

        const buffer = await bodyToArrayBuffer(props.response.body);
        props.response.body = buffer.slice(0);

        const key = this.keyFor(ctx);
        const previous = this.entries.get(key);
        if (previous) this.totalBytes -= previous.bytes;

        const cachedHeaders = props.response.headers.clone();
        cachedHeaders.delete("set-cookie");

        const entry = {
          body: buffer.slice(0),
          headers: cachedHeaders,
          status: props.response.status,
          statusText: props.response.statusText,
          bytes: buffer.byteLength,
        };

        this.entries.set(key, entry);
        this.totalBytes += entry.bytes;
        this.evict();
      });
    }

    clear() {
      this.entries.clear();
      this.totalBytes = 0;
    }
  })();
}

function handleUrl(url) {
  if (!url) return;
  const value = String(url);
  updateCurrentUrl(value);

  if (isGoogleAuthUrl(value)) {
    lastGoogleAuthUrl = toPortableGoogleAuthUrl(value);
    oauthOpenGoogle.textContent = "Google에서 로그인";
    oauthFab.hidden = false;
    setBridgeVisible(true);
    setStatus(
      "Google 로그인 주소를 감지했어요. 아래 버튼으로 Google을 프록시 밖에서 여세요.",
      "ready",
    );
    return;
  }

  try {
    const parsed = new URL(value);
    const loginRequested =
      isNovelPiaUrl(value) && parsed.searchParams.get("login_req") === "1";

    if (loginRequested) {
      oauthOpenGoogle.textContent = "노벨피아 로그인 열기";
      oauthFab.hidden = false;
      setBridgeVisible(true);
      setStatus(
        "노벨피아 로그인 요청 상태예요. 페이지의 로그인 버튼을 눌러 Google URL을 감지하세요.",
        "ready",
      );
    }
  } catch {}

  if (callbackPending && isNovelPiaUrl(value)) {
    try {
      const parsed = new URL(value);
      if (!parsed.searchParams.has("code") && !parsed.searchParams.has("error")) {
        callbackPending = false;
        setStatus("노벨피아로 돌아왔어요. 로그인 상태를 확인하세요.", "success");
      }
    } catch {}
  }
}

async function ensureFrame() {
  if (frame) return frame;

  controller = await initBootstrap();
  maximizeTransportParallelism(controller.transport);

  performanceProfiler = createPerformanceProfilerPlugin();
  rewrittenStaticCache = createRewrittenStaticCachePlugin(performanceProfiler);

  const cachePlugin = new $scramjetUtils.HttpCachePlugin();
  const urlWatcher = new $scramjetUtils.UrlWatcherPlugin((url) => {
    handleUrl(url);
  });
  const catchEscapedLinks = new $scramjetUtils.CatchEscapedLinksPlugin(
    (url) => new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin),
  );

  frame = controller.createFrame(frameElement, {
    plugins: [
      performanceProfiler,
      rewrittenStaticCache,
      cachePlugin,
      urlWatcher,
      catchEscapedLinks,
    ],
  });

  await controller.wait();

  oauthFab.hidden = false;
  return frame;
}

async function navigate(url) {
  const currentFrame = await ensureFrame();
  updateCurrentUrl(url);
  currentFrame.go(url);
}

function resolveInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return NOVELPIA_HOME;

  try {
    return new URL(raw).toString();
  } catch {}

  try {
    return new URL(`https://${raw}`).toString();
  } catch {
    return NOVELPIA_HOME;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await navigate(resolveInput(address.value));
  } catch (err) {
    error.textContent = "노벨피아 프록시 이동에 실패했습니다.";
    errorCode.textContent = err?.stack || err?.toString() || String(err);
  }
});

oauthFab.addEventListener("click", () => {
  setBridgeVisible(oauthBridge.hidden);
});

perfFab?.addEventListener("click", () => {
  perfPanel.hidden = !perfPanel.hidden;
  renderPerformancePanel();
});

perfClose?.addEventListener("click", () => {
  perfPanel.hidden = true;
});

perfClear?.addEventListener("click", () => {
  performanceEntries.length = 0;
  rewrittenStaticCache?.clear();
  renderPerformancePanel();
});

oauthClose.addEventListener("click", () => setBridgeVisible(false));

oauthRefresh.addEventListener("click", () => {
  if (currentTargetUrl) {
    handleUrl(currentTargetUrl);
  } else {
    setStatus("아직 프록시 URL을 감지하지 못했어요.", "warning");
  }
});

currentUrlCopy.addEventListener("click", async () => {
  const value = currentUrlInput.value;
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    currentUrlCopy.textContent = "복사됨";
    setTimeout(() => {
      currentUrlCopy.textContent = "복사";
    }, 1200);
  } catch {
    currentUrlInput.focus();
    currentUrlInput.select();
  }
});

oauthOpenGoogle.addEventListener("click", () => {
  if (!lastGoogleAuthUrl || !isGoogleAuthUrl(lastGoogleAuthUrl)) {
    setStatus(
      "아직 Google 로그인 URL을 감지하지 못했어요. 노벨피아에서 Google 로그인을 눌러주세요.",
      "warning",
    );
    return;
  }

  const link = document.createElement("a");
  link.href = lastGoogleAuthUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();

  oauthReturnPanel.hidden = false;
  setStatus(
    "Google 로그인 후 novelpia.com 콜백 주소를 복사해서 아래에 붙여넣으세요.",
    "ready",
  );
});

oauthShowReturn.addEventListener("click", () => {
  oauthReturnPanel.hidden = !oauthReturnPanel.hidden;
});

oauthSubmitCallback.addEventListener("click", async () => {
  const parsed = parseNovelPiaCallback(oauthCallback.value);

  if (!parsed.ok) {
    setStatus(parsed.error, "error");
    return;
  }

  callbackPending = true;
  const callbackUrl = parsed.url.toString();
  oauthCallback.value = "";

  setStatus("콜백을 Scramjet 세션으로 전달하는 중…", "ready");

  try {
    await navigate(callbackUrl);
  } catch (err) {
    callbackPending = false;
    setStatus(err?.message || String(err), "error");
  }
});

async function boot() {
  address.value = NOVELPIA_HOME;

  try {
    await navigate(NOVELPIA_HOME);
  } catch (err) {
    error.textContent = "Scramjet 2 프록시를 시작하지 못했습니다.";
    errorCode.textContent = err?.stack || err?.toString() || String(err);
  }
}

boot();
