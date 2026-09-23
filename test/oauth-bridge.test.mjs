import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toPortableGoogleAuthUrl,
  isGoogleAuthUrl,
  decodeScramjetFrameUrl,
  parseNovelPiaCallback,
} from '../public/oauth-bridge.js';

test('converts a Google internal identifier URL back to a portable OAuth authorize URL', () => {
  const input = new URL('https://accounts.google.com/v3/signin/identifier');
  input.searchParams.set('dsh', 'transient-session');
  input.searchParams.set('rart', 'transient-token');
  input.searchParams.set('continue', 'https://accounts.google.com/signin/oauth/consent?internal=1');
  input.searchParams.set('client_id', 'client.apps.googleusercontent.com');
  input.searchParams.set('redirect_uri', 'https://novelpia.com/proc/login_google');
  input.searchParams.set('response_type', 'code');
  input.searchParams.set('scope', 'openid email profile');
  input.searchParams.set('access_type', 'online');
  input.searchParams.set('approval_prompt', 'auto');
  input.searchParams.set('state', 'novelpia-state');

  const output = new URL(toPortableGoogleAuthUrl(input.toString()));

  assert.equal(output.origin + output.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(output.searchParams.get('client_id'), 'client.apps.googleusercontent.com');
  assert.equal(output.searchParams.get('redirect_uri'), 'https://novelpia.com/proc/login_google');
  assert.equal(output.searchParams.get('response_type'), 'code');
  assert.equal(output.searchParams.get('scope'), 'openid email profile');
  assert.equal(output.searchParams.get('state'), 'novelpia-state');
  assert.equal(output.searchParams.has('dsh'), false);
  assert.equal(output.searchParams.has('rart'), false);
  assert.equal(output.searchParams.has('continue'), false);
});

test('leaves an existing Google OAuth authorize URL unchanged', () => {
  const input = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fnovelpia.com%2Fproc%2Flogin_google&response_type=code&scope=email';
  assert.equal(toPortableGoogleAuthUrl(input), input);
});

test('detects only Google Accounts auth URLs', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1'), true);
  assert.equal(isGoogleAuthUrl('https://support.google.com/accounts/answer/1'), false);
  assert.equal(isGoogleAuthUrl('not a url'), false);
});

test('decodes a Scramjet frame URL using its frame prefix and codec', () => {
  const original = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz#frag';
  const prefix = 'https://proxy.example/scramjet/frame-1/';
  const encodedBase = encodeURIComponent(original.replace('#frag', ''));
  const encodedHash = encodeURIComponent('frag');
  const frameUrl = `${prefix}${encodedBase}?scramjet-meta=1#${encodedHash}`;

  assert.equal(
    decodeScramjetFrameUrl(frameUrl, prefix, decodeURIComponent),
    original,
  );
});

test('accepts a secure NovelPia OAuth callback with code and state', () => {
  const result = parseNovelPiaCallback(
    'https://novelpia.com/oauth/google/callback?code=secret&state=session',
  );
  assert.equal(result.ok, true);
  assert.equal(result.url.hostname, 'novelpia.com');
});

test('rejects non-NovelPia or non-HTTPS callback URLs', () => {
  assert.equal(
    parseNovelPiaCallback('https://evil.example/callback?code=x&state=y').ok,
    false,
  );
  assert.equal(
    parseNovelPiaCallback('http://novelpia.com/callback?code=x&state=y').ok,
    false,
  );
});

test('rejects NovelPia URLs that do not look like OAuth callbacks', () => {
  const result = parseNovelPiaCallback('https://novelpia.com/novel/123');
  assert.equal(result.ok, false);
});
