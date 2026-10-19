/** `_shared/crypto.ts`: AES-GCM round trip with TOKEN_ENC_KEY, hashes, constant-time compare, base64url. */
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects, assertThrows } from '@std/assert';
import {
  auditSubject,
  decryptString,
  encryptString,
  fromBase64Url,
  generateAesKeyBase64,
  importAesKey,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
} from '@shared/crypto.ts';
import { ConfigError } from '@shared/errors.ts';
import { TEST_TOKEN_ENC_KEY } from '@shared/testing/index.ts';

Deno.test('AES-GCM round trip with a TOKEN_ENC_KEY; fresh IV per call', async () => {
  const key = await importAesKey(generateAesKeyBase64());
  const secret = 'r.apple-refresh-token.ÄÖ-漢字';
  const a = await encryptString(key, secret);
  const b = await encryptString(key, secret);
  assertMatch(a, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assertNotEquals(a, b);
  assert(!a.includes(secret));
  assertEquals(await decryptString(key, a), secret);
  assertEquals(await decryptString(key, b), secret);
  assertEquals(await decryptString(key, await encryptString(key, '')), '');
});

Deno.test('associated data binds the ciphertext to its row', async () => {
  const key = await importAesKey(TEST_TOKEN_ENC_KEY);
  const ct = await encryptString(key, 'token', 'user-a');
  assertEquals(await decryptString(key, ct, 'user-a'), 'token');
  await assertRejects(() => decryptString(key, ct, 'user-b'), Error, 'decrypt failed');
  await assertRejects(() => decryptString(key, ct), Error, 'decrypt failed');
});

Deno.test('wrong key, tampering and malformed payloads fail with one generic error', async () => {
  const key = await importAesKey(generateAesKeyBase64());
  const other = await importAesKey(generateAesKeyBase64());
  const ct = await encryptString(key, 'token');
  await assertRejects(() => decryptString(other, ct), Error, 'decrypt failed');
  const [v, iv, body] = ct.split('.');
  const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1);
  await assertRejects(() => decryptString(key, `${v}.${iv}.${flipped}`), Error, 'decrypt failed');
  await assertRejects(() => decryptString(key, `v2.${iv}.${body}`), Error, 'unknown format');
  await assertRejects(() => decryptString(key, 'garbage'), Error, 'decrypt failed');
  await assertRejects(() => decryptString(key, `v1.${iv.slice(2)}.${body}`), Error, 'decrypt failed');
  await assertRejects(() => decryptString(key, `v1.${iv}.***`), Error, 'decrypt failed');
});

Deno.test('importAesKey accepts base64 and base64url, rejects other lengths', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const k1 = await importAesKey(btoa(String.fromCharCode(...raw)));
  const k2 = await importAesKey(toBase64Url(raw));
  assertEquals(await decryptString(k2, await encryptString(k1, 'same key')), 'same key');
  assertThrows(() => importAesKey(btoa('16-bytes-only!!!')), ConfigError, '32 bytes');
});

Deno.test('sha256Hex and auditSubject (sha256(lowercase uid + pepper))', async () => {
  assertEquals(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const uid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assertEquals(await auditSubject(uid.toUpperCase(), 'pepper'), await sha256Hex(`${uid}pepper`));
});

Deno.test('timingSafeEqual', () => {
  assert(timingSafeEqual('secret', 'secret'));
  assert(!timingSafeEqual('secret', 'secreT'));
  assert(!timingSafeEqual('secret', 'secret1'));
  assert(!timingSafeEqual('', 'x'));
  assert(timingSafeEqual('', ''));
  assert(timingSafeEqual('ü', 'ü'));
});

Deno.test('base64url round trip and validation', () => {
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
  const text = toBase64Url(bytes);
  assertMatch(text, /^[A-Za-z0-9_-]+$/);
  assertEquals(fromBase64Url(text), bytes);
  assertThrows(() => fromBase64Url('a+b/'), Error, 'base64url');
});
