/**
 * WebCrypto helpers: AES-256-GCM for secrets at rest (the Apple refresh token in `private.apple_auth_tokens`),
 * SHA-256 hashes for audit subjects, constant-time comparison and base64url.
 *
 * Ciphertext format (text column friendly): `v1.<base64url iv(12)>.<base64url ciphertext+tag>`. An optional
 * associated-data string (e.g. the user id) binds the ciphertext to its row, so a value copied to another user's row
 * fails to decrypt.
 */
import { assertBase64Key } from './env.ts';

const VERSION = 'v1';
const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(std + '='.repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** Imports `TOKEN_ENC_KEY` (base64 or base64url of 32 random bytes) as a non-extractable AES-GCM key. */
export function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = assertBase64Key(base64Key, 'TOKEN_ENC_KEY');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** A fresh random key in the `TOKEN_ENC_KEY` format (for .env files and tests). */
export function generateAesKeyBase64(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

export async function encryptString(key: CryptoKey, plaintext: string, associatedData?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (associatedData !== undefined) params.additionalData = enc.encode(associatedData);
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, enc.encode(plaintext)));
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

/** Throws `Error('decrypt failed')` for a malformed, tampered or wrongly bound ciphertext. */
export async function decryptString(key: CryptoKey, payload: string, associatedData?: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error('decrypt failed: unknown format');
  try {
    const iv = fromBase64Url(parts[1]);
    if (iv.length !== IV_BYTES) throw new Error('bad iv');
    const params: AesGcmParams = { name: 'AES-GCM', iv };
    if (associatedData !== undefined) params.additionalData = enc.encode(associatedData);
    const pt = await crypto.subtle.decrypt(params, key, fromBase64Url(parts[2]));
    return dec.decode(pt);
  } catch {
    throw new Error('decrypt failed');
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256(uid + pepper)` for `private.audit_log.subject` (DESIGN §6.1 delete-account step 6). */
export function auditSubject(userId: string, pepper: string): Promise<string> {
  return sha256Hex(userId.toLowerCase() + pepper);
}

/** Constant-time string comparison (time depends only on the longer length). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
