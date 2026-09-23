"use strict";

import {
  decodeScramjetFrameUrl,
  toPortableGoogleAuthUrl,
  isGoogleAuthUrl,
  parseNovelPiaCallback,
} from "./oauth-bridge.js";

const NOVELPIA_HOME = "https://novelpia.com/";

/** @type {HTMLFormElement} */
const form = document.getElementById("sj-form");
/** @type {HTMLInputElement} */
const address = document.getElementById("sj-address");
/** @type {HTMLInputElement} */
const searchEngine = document.getElementById("sj-search-engine");
/** @type {HTMLParagraphElement} */
const error = document.getElementById("sj-error");
/** @type {HTMLPreElement} */
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

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  files: {
    wasm: "/scram/scramjet.wasm.wasm",
    all: "/scram/scramjet.all.js",
    sync: "/scram/scramjet.sync.js",
  },
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

let frame = null;
let proxyReadyPromise = null;
let lastGoogleAuthUrl = null;
let callbackPending = false;

function setStatus(message, kind = "info") {
  oauthStatus.textContent = message;
  oauthStatus.dataset.kind = kind;
}

function setBridgeVisible(visible) {
  oauthBridge.hidden = !visible;
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

function getCurrentFrameUrl() {
  if (!frame) return null;

  if (typeof frame.url === "string" && frame.url) {
    return frame.url;
  }

  try {
    const raw = frame.frame?.contentWindow?.location?.href || frame.frame?.src || null;
    if (!raw) return null;

    const decoded =
      frame.prefix && frame.controller?.config?.codec?.decode
        ? decodeScramjetFrameUrl(
            raw,
            new URL(frame.prefix, location.href).href,
            frame.controller.config.codec.decode,
          )
        : null;

    return decoded || raw;
  } catch {
    return frame.frame?.src || null;
  }
}

function handleFrameUrl(url) {
  if (!url) return;

  if (isGoogleAuthUrl(url)) {
    lastGoogleAuthUrl = toPortableGoogleAuthUrl(url);
    oauthFab.hidden = false;
    setBridgeVisible(true);
    setStatus(
      "Google 로그인 주소를 감지했어요. 아래 버튼으로 Google을 프록시 밖에서 여세요.",
      "ready",
    );
    return;
  }

  if (callbackPending && isNovelPiaUrl(url)) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {}

    if (parsed && !parsed.searchParams.has("code") && !parsed.searchParams.has("error")) {
      callbackPending = false;
      setStatus("노벨피아로 돌아왔어요. 로그인 상태를 확인하세요.", "success");
      setTimeout(() => setBridgeVisible(false), 1200);
    }
  }
}

function refreshOAuthState() {
  const url = getCurrentFrameUrl();
  if (url) handleFrameUrl(url);

  if (!lastGoogleAuthUrl) {
    setStatus(
      "아직 Google 로그인 주소를 찾지 못했어요. 노벨피아에서 Google 로그인을 누른 뒤 다시 시도하세요.",
      "warning",
    );
  }
}

async function registerServiceWorker() {
  if (!navigator.serviceWorker) {
    throw new Error("이 브라우저는 Service Worker를 지원하지 않습니다.");
  }

  if (
    location.protocol !== "https:" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1"
  ) {
    throw new Error("Service Worker는 HTTPS에서만 사용할 수 있습니다.");
  }

  await navigator.serviceWorker.register("./sw.js");
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

async function ensureProxyReady() {
  if (proxyReadyPromise) return proxyReadyPromise;

  proxyReadyPromise = (async () => {
    try {
      await registerServiceWorker();
    } catch (err) {
      error.textContent = "Failed to register service worker.";
      errorCode.textContent = err.toString();
      throw err;
    }

    const wispUrl =
      (location.protocol === "https:" ? "wss" : "ws") +
      "://" +
      location.host +
      "/wisp/";

    if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
      await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
    }
  })();

  return proxyReadyPromise;
}

async function ensureFrame() {
  await ensureProxyReady();
  if (frame) return frame;

  frame = scramjet.createFrame();
  frame.frame.id = "sj-frame";
  document.body.appendChild(frame.frame);

  oauthFab.hidden = false;

  if (typeof frame.addEventListener === "function") {
    frame.addEventListener("urlchange", (event) => {
      const url =
        typeof event === "string"
          ? event
          : event?.url || event?.detail?.url || frame.url;
      handleFrameUrl(url);
    });
  }

  frame.frame.addEventListener("load", () => {
    const currentUrl = getCurrentFrameUrl();
    handleFrameUrl(currentUrl);

    if (!callbackPending || !currentUrl) return;

    try {
      const loaded = new URL(currentUrl);
      const isNovelPiaCallback =
        (loaded.hostname === "novelpia.com" ||
          loaded.hostname === "www.novelpia.com") &&
        loaded.pathname === "/proc/login_google" &&
        (loaded.searchParams.has("code") || loaded.searchParams.has("error"));

      if (isNovelPiaCallback) {
        setStatus(
          "콜백 응답을 받았어요. 로그인 상태를 확인하기 위해 노벨피아 홈으로 돌아갑니다.",
          "ready",
        );

        setTimeout(() => {
          if (callbackPending && frame) {
            frame.go(NOVELPIA_HOME);
          }
        }, 500);
      }
    } catch {}
  });

  setInterval(() => {
    if (frame) handleFrameUrl(getCurrentFrameUrl());
  }, 1000);

  return frame;
}

async function navigate(url) {
  const currentFrame = await ensureFrame();
  currentFrame.go(url);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = resolveInput(address.value);
  await navigate(url);
});

oauthFab.addEventListener("click", () => {
  setBridgeVisible(oauthBridge.hidden);
  if (!oauthBridge.hidden) refreshOAuthState();
});

oauthClose.addEventListener("click", () => {
  setBridgeVisible(false);
});

oauthRefresh.addEventListener("click", () => {
  refreshOAuthState();
});

oauthOpenGoogle.addEventListener("click", () => {
  refreshOAuthState();

  if (!lastGoogleAuthUrl || !isGoogleAuthUrl(lastGoogleAuthUrl)) {
    setStatus("Google 로그인 주소를 먼저 감지해야 해요.", "warning");
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
    "새 탭에서 Google 로그인을 마친 뒤, novelpia.com으로 돌아가다 실패한 주소 전체를 복사해서 아래에 붙여넣으세요.",
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
  setStatus("콜백을 Scramjet의 기존 노벨피아 세션으로 전달하는 중…", "ready");

  const currentFrame = await ensureFrame();
  currentFrame.go(callbackUrl);

  setTimeout(() => {
    if (callbackPending) {
      setStatus(
        "로그인 상태 확인 중이에요. 노벨피아 홈으로 이동되지 않았다면 OAuth 버튼의 '현재 주소 다시 확인'을 눌러주세요.",
        "warning",
      );
    }
  }, 5000);
});

async function boot() {
  address.value = NOVELPIA_HOME;

  try {
    await navigate(NOVELPIA_HOME);
  } catch (err) {
    error.textContent = "노벨피아 프록시를 시작하지 못했습니다.";
    errorCode.textContent = err.toString();
  }
}

boot();
