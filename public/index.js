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

let controller = null;
let frame = null;
let lastGoogleAuthUrl = null;
let callbackPending = false;
let currentTargetUrl = null;

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

  const cachePlugin = new $scramjetUtils.HttpCachePlugin();
  const urlWatcher = new $scramjetUtils.UrlWatcherPlugin((url) => {
    handleUrl(url);
  });
  const catchEscapedLinks = new $scramjetUtils.CatchEscapedLinksPlugin(
    (url) => new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin),
  );

  frame = controller.createFrame(frameElement, {
    plugins: [cachePlugin, urlWatcher, catchEscapedLinks],
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
