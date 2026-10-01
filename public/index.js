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

let controller = null;
let frame = null;
let initPromise = null;
let currentTargetUrl = null;
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

function updateCurrentUrl(url) {
  if (!url) return;
  currentTargetUrl = String(url);
  currentUrlBar.hidden = false;
  currentUrlInput.value = currentTargetUrl;
}

function recordObservedNavigation(kind, url) {
  if (!url) return;
  const value = String(url);
  lastObservedNavigation = value;

  if (isGoogleAuthUrl(value)) {
    stopLoginModalWait();
    lastGoogleAuthUrl = toPortableGoogleAuthUrl(value);
    oauthOpenGoogle.textContent = "Google에서 로그인";
    oauthFab.hidden = false;
    setBridgeVisible(true);
    setStatus(`${kind}에서 Google 로그인 URL을 감지했어요.`, "ready");
  }
}

function hookFrameWindowOpen(win) {
  try {
    if (!win || win.__novelpiaOauthOpenHooked) return;

    const originalOpen = win.open;
    if (typeof originalOpen !== "function") return;

    win.open = function (...args) {
      if (args[0]) recordObservedNavigation("window.open", args[0]);
      return originalOpen.apply(this, args);
    };

    Object.defineProperty(win, "__novelpiaOauthOpenHooked", {
      value: true,
      configurable: true,
    });
  } catch {}
}

function handleFrameUrl(value) {
  if (!value) return;
  const url = String(value);
  updateCurrentUrl(url);
  recordObservedNavigation("navigation", url);

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  const isNovelPia =
    parsed.hostname === "novelpia.com" ||
    parsed.hostname === "www.novelpia.com";

  if (isNovelPia && parsed.searchParams.get("login_req") === "1") {
    oauthOpenGoogle.textContent = "노벨피아 로그인 모달 열기";
    oauthFab.hidden = false;
    setBridgeVisible(true);
    setStatus(
      "노벨피아가 로그인 요청 상태예요. 아래 버튼을 누르면 로그인 DOM이 나타날 때까지 기다립니다.",
      "ready",
    );
  }

  if (isGoogleAuthUrl(url)) {
    return;
  }

  if (
    callbackPending &&
    isNovelPia &&
    parsed.pathname === "/proc/login_google" &&
    (parsed.searchParams.has("code") || parsed.searchParams.has("error"))
  ) {
    setStatus(
      "콜백 응답을 받았어요. 로그인 처리가 끝나면 노벨피아 홈으로 돌아갑니다.",
      "ready",
    );

    setTimeout(() => {
      if (callbackPending && frame) frame.go(NOVELPIA_HOME);
    }, 700);
    return;
  }

  if (
    callbackPending &&
    isNovelPia &&
    !parsed.searchParams.has("code") &&
    !parsed.searchParams.has("error")
  ) {
    callbackPending = false;
    setStatus("노벨피아로 돌아왔어요. 로그인 상태를 확인하세요.", "success");
    setTimeout(() => setBridgeVisible(false), 1200);
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
  const win = frame?.element?.contentWindow;
  if (!win) return false;

  try {
    const doc = win.document;
    const elements = [
      ...doc.querySelectorAll("img, a, button, div, span, section"),
    ];

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
      }

      current = current.parentElement;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    return true;
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
      setStatus("15분 동안 기다렸지만 로그인 DOM이 나타나지 않았어요.", "warning");
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
  if (currentTargetUrl) handleFrameUrl(currentTargetUrl);

  if (!lastGoogleAuthUrl) {
    setStatus(
      "아직 Google 로그인 주소를 찾지 못했어요. 노벨피아에서 Google 로그인을 누른 뒤 다시 시도하세요.",
      "warning",
    );
  }
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

async function ensureFrame() {
  if (initPromise) {
    await initPromise;
    return frame;
  }

  initPromise = (async () => {
    if (typeof initBootstrap !== "function") {
      throw new Error("Scramjet 2 bootstrap loader was not found.");
    }

    controller = await initBootstrap();
    if (typeof controller.wait === "function") {
      await controller.wait();
    }

    const frameElement = document.createElement("iframe");
    frameElement.id = "sj-frame";
    document.body.appendChild(frameElement);

    const cachePlugin = new $scramjetUtils.HttpCachePlugin();
    const urlWatcher = new $scramjetUtils.UrlWatcherPlugin((url) => {
      handleFrameUrl(url);
    });

    class OAuthCapturePlugin extends $scramjetUtils.ManagedPlugin {
      constructor() {
        super("novelpia-oauth-capture", []);
      }

      install(targetFrame) {
        super.install(targetFrame);
        this.tap(targetFrame.hooks.init.post, (context) => {
          if (!context.isTopLevel) return;
          hookFrameWindowOpen(context.window);
          handleFrameUrl(context.client.url.href);
        });
      }
    }

    frame = controller.createFrame(frameElement, {
      plugins: [cachePlugin, urlWatcher, new OAuthCapturePlugin()],
    });

    currentUrlBar.hidden = false;
    updateCurrentUrl("about:blank");
    oauthFab.hidden = false;
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }

  return frame;
}

async function navigate(url) {
  const currentFrame = await ensureFrame();
  currentFrame.go(url);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await navigate(resolveInput(address.value));
  } catch (err) {
    error.textContent = "페이지를 열지 못했습니다.";
    errorCode.textContent = err?.stack || String(err);
  }
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
      `마지막 이동 요청: ${
        lastObservedNavigation.length > 180
          ? lastObservedNavigation.slice(0, 177) + "..."
          : lastObservedNavigation
      }`,
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

oauthOpenGoogle.addEventListener("click", () => {
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

  try {
    const currentFrame = await ensureFrame();
    currentFrame.go(callbackUrl);
  } catch (err) {
    callbackPending = false;
    setStatus(`콜백 전달 실패: ${err?.message || err}`, "error");
  }
});

async function boot() {
  address.value = NOVELPIA_HOME;
  oauthOpenGoogle.textContent = "노벨피아 로그인 모달 열기";

  try {
    await navigate(NOVELPIA_HOME);
  } catch (err) {
    error.textContent = "노벨피아 프록시를 시작하지 못했습니다.";
    errorCode.textContent = err?.stack || String(err);
  }
}

boot();
