import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGoogleAuthUrl,
  decodeScramjetFrameUrl,
  parseNovelPiaCallback,
} from '../public/oauth-bridge.js';

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
