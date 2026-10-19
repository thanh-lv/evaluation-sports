/**
 * Apple JWS (StoreKit 2 transactions, renewal info, Server Notifications V2).
 *
 * - `decodeJws` reads header and payload WITHOUT trusting them (DESIGN §9.4 step 1, §9.5 step 1).
 * - `verifyJws` checks the `x5c` chain: exactly [leaf, intermediate, root]; the root must equal a trusted root (Apple
 *   Root CA G3); the intermediate is a CA signed by that root and carries OID 1.2.840.113635.100.6.2.1; the leaf is
 *   signed by the intermediate and carries OID 1.2.840.113635.100.6.11.1; every certificate is valid at the check date
 *   (the payload's `signedDate`, else now); the JWS signature (ES256) verifies with the leaf key.
 *
 * Trusted roots: none is embedded (www.apple.com was unreachable from the build container). Production reads
 * `APPLE_ROOT_CA_G3_PEM` (docs/apple-setup.md); tests pass their own root. No roots configured → `no_trusted_roots`.
 * Revocation (OCSP) is not checked.
 */
import { fromBase64Url } from '../crypto.ts';
import { base64ToBytes, bytesEqual, ecdsaDerToRaw, OID, type ParsedCertificate, parseCertificate, pemCertificates } from './der.ts';

export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

/** Embedded Apple Root CA G3 PEM: empty because it could not be downloaded here; see `trustedRootsFromEnv`. */
export const EMBEDDED_APPLE_ROOTS_PEM: readonly string[] = [];

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JwsError('malformed', `${what} not an object`);
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

/** Verifies `jws` against `roots` (see module doc) and returns the payload. Throws `JwsError`. */
export async function verifyJws<T = Record<string, unknown>>(jws: string, options: VerifyOptions): Promise<T> {
  if (options.roots.length === 0) throw new JwsError('no_trusted_roots');
  const decoded = decodeJws<T>(jws);
  if (decoded.header.alg !== 'ES256') throw new JwsError('unsupported_alg', String(decoded.header.alg));
  const [leaf, intermediate, root] = parseX5c(decoded.header.x5c);

  if (!options.roots.some((r) => bytesEqual(r, root.der))) throw new JwsError('untrusted_root');
  if (!intermediate.isCA) throw new JwsError('not_ca', 'intermediate');
  if (!intermediate.extensions.has(APPLE_INTERMEDIATE_OID)) throw new JwsError('missing_oid', 'intermediate');
  if (!leaf.extensions.has(APPLE_LEAF_OID)) throw new JwsError('missing_oid', 'leaf');

  const signedDate = (decoded.payload as { signedDate?: unknown }).signedDate;
  const at = options.at ??
    (typeof signedDate === 'number' && Number.isFinite(signedDate) ? new Date(signedDate) : (options.now?.() ?? new Date()));
  for (const cert of [leaf, intermediate, root]) {
    if (at < cert.notBefore || at > cert.notAfter) throw new JwsError('expired', at.toISOString());
  }

  if (!(await signedBy(intermediate, root))) throw new JwsError('chain_signature', 'intermediate');
  if (!(await signedBy(leaf, intermediate))) throw new JwsError('chain_signature', 'leaf');

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

/** Trusted roots: the embedded ones plus every certificate in `APPLE_ROOT_CA_G3_PEM`. */
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
