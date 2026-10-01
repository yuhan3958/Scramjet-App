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
const currentUrlBar = document.getElementById("current-url-bar");
const currentUrlInput = document.getElementById("current-url");
const currentUrlCopy = document.getElementById("current-url-copy");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  files: {
    wasm: "/scram/scramjet.wasm.wasm",
    all: "/scram/scramjet.all.js",
    sync: "/scram/scramjet.sync.js",
  },
  flags: {
    sourcemaps: false,
  },
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

let frame = null;
let proxyReadyPromise = null;
let lastGoogleAuthUrl = null;
let callbackPending = false;
let lastObservedNavigation = null;
let loginModalWaitTimer = null;
let loginModalWaitStartedAt = 0;

const LOGIN_MODAL_WAIT_INTERVAL_MS = 2000;
const LOGIN_MODAL_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

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

function updateCurrentUrl(url) {
  if (!url) return;
  currentUrlBar.hidden = false;
  currentUrlInput.value = url;
}

function recordObservedNavigation(kind, url) {
  if (!url) return;
  const value = String(url);
  lastObservedNavigation = value;

  if (isGoogleAuthUrl(value)) {
    lastGoogleAuthUrl = toPortableGoogleAuthUrl(value);
    oauthOpenGoogle.textContent = "Google에서 로그인";
    setBridgeVisible(true);
    setStatus(
      `${kind}에서 Google 로그인 URL을 감지했어요.`,
      "ready",
    );
  } else {
    setStatus(
      `${kind} 감지: ${value.length > 180 ? value.slice(0, 177) + "..." : value}`,
      "info",
    );
  }
}

function hookFrameWindowOpen(win) {
  try {
    if (!win || win.__novelpiaOauthOpenHooked) return;
    const originalOpen = win.open;
    if (typeof originalOpen !== "function") return;

    const wrappedOpen = function (...args) {
      if (args[0]) recordObservedNavigation("window.open", args[0]);
      return originalOpen.apply(this, args);
    };

    Object.defineProperty(win, "__novelpiaOauthOpenHooked", {
      value: true,
      configurable: true,
    });
    win.open = wrappedOpen;
  } catch {}
}

function handleFrameUrl(url) {
  if (!url) return;
  updateCurrentUrl(url);

  try {
    const parsedUrl = new URL(url);
    const loginRequested =
      (parsedUrl.hostname === "novelpia.com" ||
        parsedUrl.hostname === "www.novelpia.com") &&
      parsedUrl.searchParams.get("login_req") === "1";

    if (loginRequested) {
      oauthOpenGoogle.textContent = "노벨피아 로그인 모달 열기";
      oauthFab.hidden = false;
      setBridgeVisible(true);
      setStatus(
        "노벨피아가 로그인 요청 상태예요. 아래 버튼을 누르면 숨겨진 로그인 모달을 표시합니다.",
        "ready",
      );
    }
  } catch {}

  if (isGoogleAuthUrl(url)) {
    stopLoginModalWait();
    lastGoogleAuthUrl = toPortableGoogleAuthUrl(url);
    oauthOpenGoogle.textContent = "Google에서 로그인";
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

function stopLoginModalWait() {
  if (loginModalWaitTimer) {
    clearInterval(loginModalWaitTimer);
    loginModalWaitTimer = null;
  }
  loginModalWaitStartedAt = 0;
}

function revealNovelPiaLoginModal() {
  if (!frame?.frame?.contentWindow) return false;

  try {
    const win = frame.frame.contentWindow;
    const doc = win.document;
    const elements = [...doc.querySelectorAll("img, a, button, div, span, section")];

    const target = elements.find((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const alt = (element.getAttribute("alt") || "").trim();
      const title = (element.getAttribute("title") || "").trim();
      const combined = `${text} ${alt} ${title}`;
      return (
        combined.includes("구글로 로그인") ||
        combined.includes("SNS 계정 으로 간편하게 로그인")
      );
    });

    if (!target) return false;

    let current = target;
    let revealed = false;

    while (current && current !== doc.body) {
      const style = win.getComputedStyle(current);
      const marker = `${current.id || ""} ${current.className || ""}`.toLowerCase();
      const looksLikeLoginLayer =
        /login|signin|modal|popup|layer|member|sns|social/.test(marker);

      const hidden =
        current.hidden ||
        current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0";

      if (hidden || looksLikeLoginLayer) {
        current.hidden = false;
        current.removeAttribute("aria-hidden");
        current.style.setProperty("display", "block", "important");
        current.style.setProperty("visibility", "visible", "important");
        current.style.setProperty("opacity", "1", "important");
        current.style.setProperty("pointer-events", "auto", "important");
        revealed = true;
      }

      current = current.parentElement;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    return revealed || true;
  } catch {
    return false;
  }
}
function waitForNovelPiaLoginModal() {
  stopLoginModalWait();
  loginModalWaitStartedAt = Date.now();

  const tryReveal = () => {
    if (revealNovelPiaLoginModal()) {
      stopLoginModalWait();
      setStatus(
        "로그인 DOM이 나타났어요. 모달을 표시했습니다. 안의 구글 로그인 버튼을 직접 눌러주세요.",
        "success",
      );
      return;
    }

    const elapsed = Date.now() - loginModalWaitStartedAt;
    if (elapsed >= LOGIN_MODAL_WAIT_TIMEOUT_MS) {
      stopLoginModalWait();
      setStatus(
        "15분 동안 기다렸지만 로그인 DOM이 나타나지 않았어요.",
        "warning",
      );
      return;
    }

    setStatus(
      `로그인 DOM을 기다리는 중… ${Math.floor(elapsed / 1000)}초`,
      "info",
    );
  };

  tryReveal();
  if (!loginModalWaitTimer) {
    loginModalWaitTimer = setInterval(tryReveal, LOGIN_MODAL_WAIT_INTERVAL_MS);
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
  await navigator.serviceWorker.ready;
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

    // BareMux can retain the selected transport name while its actual
    // transport client has been lost (for example after a worker restart).
    // Always recreate the libcurl transport before Scramjet starts fetching.
    await connection.setTransport("/libcurl/index.mjs", [
      {
        websocket: wispUrl,
        connections: [96, 80, 16],
      },
    ]);
  })();

  return proxyReadyPromise;
}

async function ensureFrame() {
  await ensureProxyReady();
  if (frame) return frame;

  frame = scramjet.createFrame();
  frame.frame.id = "sj-frame";
  document.body.appendChild(frame.frame);
  currentUrlBar.hidden = false;
  updateCurrentUrl("about:blank");

  oauthFab.hidden = false;

  if (typeof frame.addEventListener === "function") {
    frame.addEventListener("navigate", (event) => {
      const url =
        typeof event === "string"
          ? event
          : event?.url || event?.detail?.url;
      recordObservedNavigation("navigate", url);
    });

    frame.addEventListener("contextInit", (event) => {
      hookFrameWindowOpen(event?.window || frame?.frame?.contentWindow);
    });

    frame.addEventListener("urlchange", (event) => {
      const url =
        typeof event === "string"
          ? event
          : event?.url || event?.detail?.url || frame.url;
      handleFrameUrl(url);
    });
  }

  frame.frame.addEventListener("load", () => {
    hookFrameWindowOpen(frame.frame?.contentWindow);
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

  if (lastObservedNavigation) {
    setStatus(
      `마지막 이동 요청: ${lastObservedNavigation.length > 180
        ? lastObservedNavigation.slice(0, 177) + "..."
        : lastObservedNavigation}`,
      "info",
    );
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

oauthOpenGoogle.addEventListener("click", async () => {
  refreshOAuthState();

  if (!lastGoogleAuthUrl || !isGoogleAuthUrl(lastGoogleAuthUrl)) {
    waitForNovelPiaLoginModal();
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
  oauthOpenGoogle.textContent = "노벨피아 로그인 모달 열기";

  try {
    await navigate(NOVELPIA_HOME);
  } catch (err) {
    error.textContent = "노벨피아 프록시를 시작하지 못했습니다.";
    errorCode.textContent = err.toString();
  }
}

boot();
