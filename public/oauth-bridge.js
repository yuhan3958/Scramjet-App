const PORTABLE_GOOGLE_OAUTH_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'access_type',
  'state',
  'prompt',
  'approval_prompt',
  'include_granted_scopes',
  'login_hint',
  'hd',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'response_mode',
];

export function toPortableGoogleAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
      return value;
    }

    if (url.pathname.startsWith('/o/oauth2/') && url.pathname.endsWith('/auth')) {
      return url.toString();
    }

    const required = ['client_id', 'redirect_uri', 'response_type'];
    if (!required.every((name) => url.searchParams.has(name))) {
      return url.toString();
    }

    const portable = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const name of PORTABLE_GOOGLE_OAUTH_PARAMS) {
      for (const item of url.searchParams.getAll(name)) {
        portable.searchParams.append(name, item);
      }
    }

    return portable.toString();
  } catch {
    return value;
  }
}

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
