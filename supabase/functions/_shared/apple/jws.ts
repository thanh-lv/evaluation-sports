/**
 * Apple JWS (StoreKit 2 transactions, renewal info, Server Notifications V2).
 *
 * - `decodeJws` reads header and payload WITHOUT trusting them (DESIGN §9.4 step 1, §9.5 step 1).
 * - `verifyJws` checks the `x5c` chain: exactly [leaf, intermediate, root]; the root must equal a trusted root (Apple
 *   Root CA G3); the intermediate is a CA signed by that root and carries OID 1.2.840.113635.100.6.2.1; the leaf is
 *   signed by the intermediate and carries OID 1.2.840.113635.100.6.11.1; every certificate is valid at the check date
 *   (the payload's `signedDate`, else now); the JWS signature (ES256) verifies with the leaf key.
 *
 * Trusted roots: Apple Root CA - G3 is embedded (`APPLE_ROOT_CA_G3_PEM`, SHA-256 fingerprint pinned in
 * `APPLE_ROOT_CA_G3_SHA256` and checked by the tests). `APPLE_ROOT_CA_G3_PEM` in the environment ADDS roots (e.g. after
 * an Apple rotation; docs/apple-setup.md). Tests pass their own roots. Revocation (OCSP) is not checked.
 */
import { fromBase64Url } from '../crypto.ts';
import {
  base64ToBytes,
  bytesEqual,
  ecdsaDerToRaw,
  OID,
  parseCertificate,
  type ParsedCertificate,
  pemCertificates,
} from './der.ts';

export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

/**
 * Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer). www.apple.com is blocked from the
 * build container, so the certificate was taken from Apple's own `@apple/app-store-server-library@3.1.0` (npm, author
 * Apple Inc.) and checked against the published SHA-256 fingerprint below (also pinned by `app-store-server-api`).
 * Valid 2014-04-30 – 2039-04-30.
 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** SHA-256 of the DER of Apple Root CA - G3 (hex, lowercase). */
export const APPLE_ROOT_CA_G3_SHA256 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';

export const EMBEDDED_APPLE_ROOTS_PEM: readonly string[] = [APPLE_ROOT_CA_G3_PEM];

export type JwsFailure =
  | 'malformed'
  | 'unsupported_alg'
  | 'bad_chain'
  | 'untrusted_root'
  | 'chain_signature'
  | 'missing_oid'
  | 'not_ca'
  | 'expired'
  | 'bad_signature'
  | 'no_trusted_roots';

export class JwsError extends Error {
  readonly reason: JwsFailure;
  constructor(reason: JwsFailure, detail?: string) {
    super(detail ? `jws ${reason}: ${detail}` : `jws ${reason}`);
    this.name = 'JwsError';
    this.reason = reason;
  }
}

export interface JwsHeader {
  alg?: string;
  x5c?: string[];
  kid?: string;
  [key: string]: unknown;
}

export interface DecodedJws<T> {
  header: JwsHeader;
  payload: T;
  /** `header.payload` bytes (what the signature covers). */
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

const dec = new TextDecoder();
const COMPACT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function parseJsonObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(dec.decode(bytes));
  } catch {
    throw new JwsError('malformed', `${what} is not JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JwsError('malformed', `${what} not an object`);
  }
  return value as Record<string, unknown>;
}

/** Decodes a compact JWS without any verification. Throws `JwsError('malformed')`. */
export function decodeJws<T = Record<string, unknown>>(jws: string): DecodedJws<T> {
  if (typeof jws !== 'string' || !COMPACT_RE.test(jws)) throw new JwsError('malformed', 'not a compact JWS');
  const [h, p, s] = jws.split('.');
  try {
    const header = parseJsonObject(fromBase64Url(h), 'header') as JwsHeader;
    const payload = parseJsonObject(fromBase64Url(p), 'payload') as T;
    return {
      header,
      payload,
      signingInput: new TextEncoder().encode(`${h}.${p}`),
      signature: fromBase64Url(s),
    };
  } catch (err) {
    if (err instanceof JwsError) throw err;
    throw new JwsError('malformed', 'bad base64url');
  }
}

/** Payload only, without verification. */
export function decodeJwsPayload<T = Record<string, unknown>>(jws: string): T {
  return decodeJws<T>(jws).payload;
}

export interface VerifyOptions {
  /** Trusted root certificates (DER). */
  roots: readonly Uint8Array[];
  /** Validity check date; default: the payload's `signedDate` (ms), else now. */
  at?: Date;
  now?: () => Date;
}

const CURVES: Record<string, { name: string; size: number }> = {
  [OID.p256]: { name: 'P-256', size: 32 },
  [OID.p384]: { name: 'P-384', size: 48 },
};
const HASHES: Record<string, string> = { [OID.ecdsaSha256]: 'SHA-256', [OID.ecdsaSha384]: 'SHA-384' };

function importEcKey(cert: ParsedCertificate): Promise<CryptoKey> {
  const curve = cert.curve ? CURVES[cert.curve] : undefined;
  if (cert.keyAlgorithm !== OID.ecPublicKey || !curve) throw new JwsError('bad_chain', 'unsupported key type');
  return crypto.subtle.importKey('spki', cert.spki.slice(), { name: 'ECDSA', namedCurve: curve.name }, false, [
    'verify',
  ]);
}

/** True when `issuer`'s key signed `cert`. */
async function signedBy(cert: ParsedCertificate, issuer: ParsedCertificate): Promise<boolean> {
  const hash = HASHES[cert.signatureAlgorithm];
  const curve = issuer.curve ? CURVES[issuer.curve] : undefined;
  if (!hash || !curve) return false;
  if (!bytesEqual(cert.issuer, issuer.subject)) return false;
  try {
    const key = await importEcKey(issuer);
    const raw = ecdsaDerToRaw(cert.signature, curve.size);
    return await crypto.subtle.verify({ name: 'ECDSA', hash }, key, raw, cert.tbs.slice());
  } catch {
    return false;
  }
}

function parseX5c(x5c: unknown): ParsedCertificate[] {
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string')) {
    throw new JwsError('bad_chain', 'x5c must hold 3 certificates');
  }
  try {
    return x5c.map((c) => parseCertificate(base64ToBytes(c)));
  } catch (err) {
    throw new JwsError('bad_chain', (err as Error).message);
  }
}

/**
 * Checks a parsed [leaf, intermediate, root] chain against `roots` at `at`: trusted root, intermediate is a CA with
 * the WWDR OID and signed by the root, leaf carries the receipt-signing OID and is signed by the intermediate, every
 * certificate valid at `at`. Throws `JwsError`.
 */
export async function verifyChain(
  chain: readonly ParsedCertificate[],
  roots: readonly Uint8Array[],
  at: Date,
): Promise<void> {
  if (roots.length === 0) throw new JwsError('no_trusted_roots');
  if (chain.length !== 3) throw new JwsError('bad_chain', 'x5c must hold 3 certificates');
  const [leaf, intermediate, root] = chain;
  if (!roots.some((r) => bytesEqual(r, root.der))) throw new JwsError('untrusted_root');
  if (!intermediate.isCA) throw new JwsError('not_ca', 'intermediate');
  if (leaf.isCA) throw new JwsError('bad_chain', 'leaf is a CA');
  if (!intermediate.extensions.has(APPLE_INTERMEDIATE_OID)) throw new JwsError('missing_oid', 'intermediate');
  if (!leaf.extensions.has(APPLE_LEAF_OID)) throw new JwsError('missing_oid', 'leaf');
  for (const cert of chain) {
    if (at < cert.notBefore || at > cert.notAfter) throw new JwsError('expired', at.toISOString());
  }
  if (!(await signedBy(intermediate, root))) throw new JwsError('chain_signature', 'intermediate');
  if (!(await signedBy(leaf, intermediate))) throw new JwsError('chain_signature', 'leaf');
}

/** Parses base64 DER certificates (an `x5c` array) for `verifyChain`. */
export function parseChain(x5c: unknown): ParsedCertificate[] {
  return parseX5c(x5c);
}

/** Verifies `jws` against `roots` (see module doc) and returns the payload. Throws `JwsError`. */
export async function verifyJws<T = Record<string, unknown>>(jws: string, options: VerifyOptions): Promise<T> {
  if (options.roots.length === 0) throw new JwsError('no_trusted_roots');
  const decoded = decodeJws<T>(jws);
  if (decoded.header.alg !== 'ES256') throw new JwsError('unsupported_alg', String(decoded.header.alg));
  const chain = parseX5c(decoded.header.x5c);

  const signedDate = (decoded.payload as { signedDate?: unknown }).signedDate;
  const at = options.at ??
    (typeof signedDate === 'number' && Number.isFinite(signedDate)
      ? new Date(signedDate)
      : (options.now?.() ?? new Date()));
  await verifyChain(chain, options.roots, at);

  const leaf = chain[0];
  if (leaf.curve !== OID.p256) throw new JwsError('unsupported_alg', 'leaf key is not P-256');
  const key = await importEcKey(leaf);
  if (decoded.signature.length !== 64) throw new JwsError('bad_signature', 'ES256 signature must be 64 bytes');
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    decoded.signature,
    decoded.signingInput,
  );
  if (!ok) throw new JwsError('bad_signature');
  return decoded.payload;
}

/** Trusted roots: the embedded Apple Root CA - G3 plus every certificate in `APPLE_ROOT_CA_G3_PEM` (env). */
export function trustedRoots(pem: string | null | undefined): Uint8Array<ArrayBuffer>[] {
  const out = EMBEDDED_APPLE_ROOTS_PEM.flatMap((p) => pemCertificates(p));
  if (pem) {
    const extra = pemCertificates(pem);
    if (extra.length === 0) throw new Error('holds no PEM certificate');
    for (const der of extra) parseCertificate(der); // fail fast on a pasted-wrong value
    out.push(...extra);
  }
  return out;
}
