export function isGoogleAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

export function decodeScramjetFrameUrl(frameUrl, framePrefix, codecDecode) {
  try {
    const current = new URL(frameUrl);
    const prefix = new URL(framePrefix);

    if (current.origin !== prefix.origin || !current.href.startsWith(prefix.href)) {
      return null;
    }

    const decodedHash = current.hash
      ? codecDecode(current.hash.slice(1))
      : '';

    current.hash = '';
    current.search = '';

    const encoded = current.href.slice(prefix.href.length);
    if (!encoded) return null;

    const decoded = codecDecode(encoded);
    return decoded + (decodedHash ? `#${decodedHash}` : '');
  } catch {
    return null;
  }
}

export function parseNovelPiaCallback(value) {
  try {
    const url = new URL(String(value).trim());
    const validHost =
      url.hostname === 'novelpia.com' || url.hostname === 'www.novelpia.com';
    const callbackLike = url.searchParams.has('code') || url.searchParams.has('error');

    if (url.protocol !== 'https:' || !validHost || !callbackLike) {
      return { ok: false, error: '노벨피아 OAuth 콜백 URL이 아닙니다.' };
    }

    return { ok: true, url };
  } catch {
    return { ok: false, error: '올바른 URL 형식이 아닙니다.' };
  }
}
