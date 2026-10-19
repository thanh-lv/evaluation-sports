/**
 * Minimal DER reader for X.509 certificates: just what jws.ts needs (TBS bytes, signature, names, validity, SPKI,
 * curve and extensions). Strict: definite lengths only, no trailing bytes, so a malformed certificate fails closed.
 */

export interface DerNode {
  tag: number;
  /** The whole TLV. */
  bytes: Uint8Array;
  /** The content octets. */
  value: Uint8Array;
}

export class DerError extends Error {
  constructor(message: string) {
    super(`der: ${message}`);
    this.name = 'DerError';
  }
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
} as const;

/** Reads one TLV at `offset`; returns it and the offset after it. */
export function readNode(buf: Uint8Array, offset = 0): { node: DerNode; next: number } {
  if (offset + 2 > buf.length) throw new DerError('truncated header');
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError('multi-byte tags are not supported');
  let len = buf[offset + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError('unsupported length encoding');
    if (offset + 2 + n > buf.length) throw new DerError('truncated length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new DerError('truncated value');
  return {
    node: { tag, bytes: buf.subarray(offset, end), value: buf.subarray(offset + header, end) },
    next: end,
  };
}

/** Parses a buffer that must hold exactly one TLV. */
export function parseOne(buf: Uint8Array): DerNode {
  const { node, next } = readNode(buf, 0);
  if (next !== buf.length) throw new DerError('trailing bytes');
  return node;
}

/** The children of a constructed node. */
export function children(node: DerNode): DerNode[] {
  if ((node.tag & 0x20) === 0) throw new DerError(`tag 0x${node.tag.toString(16)} is not constructed`);
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < node.value.length) {
    const { node: child, next } = readNode(node.value, offset);
    out.push(child);
    offset = next;
  }
  return out;
}

function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (!node || node.tag !== tag) throw new DerError(`expected ${what}`);
  return node;
}

export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) throw new DerError('empty OID');
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < value.length; i++) {
    acc = acc * 128 + (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      if (parts.length === 0) {
        const first = acc < 40 ? 0 : acc < 80 ? 1 : 2;
        parts.push(first, acc - first * 40);
      } else {
        parts.push(acc);
      }
      acc = 0;
    }
  }
  if (value[value.length - 1] & 0x80) throw new DerError('truncated OID');
  return parts.join('.');
}

function decodeTime(node: DerNode): Date {
  const text = new TextDecoder().decode(node.value);
  let m: RegExpExecArray | null;
  if (node.tag === TAG.UTC_TIME && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text))) {
    const yy = Number(m[1]);
    return new Date(Date.UTC(yy < 50 ? 2000 + yy : 1900 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (node.tag === TAG.GENERALIZED_TIME && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text))) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  throw new DerError('unsupported time');
}

export interface CertExtension {
  critical: boolean;
  /** extnValue content (the DER inside the OCTET STRING). */
  value: Uint8Array;
}

export interface ParsedCertificate {
  der: Uint8Array;
  /** tbsCertificate TLV: the signed bytes. */
  tbs: Uint8Array;
  /** OID of the outer signatureAlgorithm. */
  signatureAlgorithm: string;
  /** BIT STRING content without the unused-bits octet (an ECDSA DER signature). */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** SubjectPublicKeyInfo TLV (WebCrypto `spki`). */
  spki: Uint8Array;
  keyAlgorithm: string;
  /** namedCurve OID for EC keys, else null. */
  curve: string | null;
  extensions: Map<string, CertExtension>;
  /** basicConstraints cA (false when the extension is absent). */
  isCA: boolean;
}

export const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  p256: '1.2.840.10045.3.1.7',
  p384: '1.3.132.0.34',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  basicConstraints: '2.5.29.19',
} as const;

function parseExtensions(node: DerNode): Map<string, CertExtension> {
  const out = new Map<string, CertExtension>();
  const seq = expectTag(children(node)[0], TAG.SEQUENCE, 'extensions');
  for (const ext of children(seq)) {
    const parts = children(expectTag(ext, TAG.SEQUENCE, 'extension'));
    const oid = decodeOid(expectTag(parts[0], TAG.OID, 'extnID').value);
    let i = 1;
    let critical = false;
    if (parts[i]?.tag === TAG.BOOLEAN) {
      critical = parts[i].value[0] !== 0;
      i++;
    }
    const value = expectTag(parts[i], TAG.OCTET_STRING, 'extnValue').value;
    if (out.has(oid)) throw new DerError(`duplicate extension ${oid}`);
    out.set(oid, { critical, value });
  }
  return out;
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const cert = children(expectTag(parseOne(der), TAG.SEQUENCE, 'Certificate'));
  if (cert.length !== 3) throw new DerError('Certificate must have 3 parts');
  const tbsNode = expectTag(cert[0], TAG.SEQUENCE, 'tbsCertificate');
  const sigAlg = children(expectTag(cert[1], TAG.SEQUENCE, 'signatureAlgorithm'));
  const signatureAlgorithm = decodeOid(expectTag(sigAlg[0], TAG.OID, 'algorithm').value);
  const sigBits = expectTag(cert[2], TAG.BIT_STRING, 'signatureValue').value;
  if (sigBits.length < 2 || sigBits[0] !== 0) throw new DerError('bad signature bit string');

  const tbs = children(tbsNode);
  let i = 0;
  if (tbs[i]?.tag === 0xa0) i++; // [0] version
  expectTag(tbs[i++], TAG.INTEGER, 'serialNumber');
  const innerAlg = children(expectTag(tbs[i++], TAG.SEQUENCE, 'signature'));
  if (decodeOid(expectTag(innerAlg[0], TAG.OID, 'algorithm').value) !== signatureAlgorithm) {
    throw new DerError('signature algorithm mismatch');
  }
  const issuer = expectTag(tbs[i++], TAG.SEQUENCE, 'issuer').bytes;
  const validity = children(expectTag(tbs[i++], TAG.SEQUENCE, 'validity'));
  if (validity.length !== 2) throw new DerError('bad validity');
  const subject = expectTag(tbs[i++], TAG.SEQUENCE, 'subject').bytes;
  const spkiNode = expectTag(tbs[i++], TAG.SEQUENCE, 'subjectPublicKeyInfo');
  const keyAlg = children(expectTag(children(spkiNode)[0], TAG.SEQUENCE, 'algorithm'));
  const keyAlgorithm = decodeOid(expectTag(keyAlg[0], TAG.OID, 'algorithm').value);
  const curve = keyAlg[1]?.tag === TAG.OID ? decodeOid(keyAlg[1].value) : null;

  let extensions = new Map<string, CertExtension>();
  for (; i < tbs.length; i++) {
    if (tbs[i].tag === 0xa3) extensions = parseExtensions(tbs[i]);
  }
  let isCA = false;
  const bc = extensions.get(OID.basicConstraints);
  if (bc) {
    const first = children(expectTag(parseOne(bc.value), TAG.SEQUENCE, 'basicConstraints'))[0];
    isCA = first?.tag === TAG.BOOLEAN && first.value[0] !== 0;
  }

  return {
    der,
    tbs: tbsNode.bytes,
    signatureAlgorithm,
    signature: sigBits.subarray(1),
    issuer,
    subject,
    notBefore: decodeTime(validity[0]),
    notAfter: decodeTime(validity[1]),
    spki: spkiNode.bytes,
    keyAlgorithm,
    curve,
    extensions,
    isCA,
  };
}

/** ECDSA-Sig-Value (DER SEQUENCE {r, s}) → the fixed-size `r || s` WebCrypto expects. */
export function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const parts = children(expectTag(parseOne(sig), TAG.SEQUENCE, 'ECDSA-Sig-Value'));
  if (parts.length !== 2) throw new DerError('bad ECDSA signature');
  const out = new Uint8Array(size * 2);
  parts.forEach((p, idx) => {
    let v = expectTag(p, TAG.INTEGER, 'ECDSA integer').value;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new DerError('ECDSA integer too long');
    out.set(v, idx * size + (size - v.length));
  });
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Every `-----BEGIN CERTIFICATE-----` block in `text` as DER. Literal `\n` (one-line env secrets) are accepted. */
export function pemCertificates(text: string): Uint8Array<ArrayBuffer>[] {
  const normalized = text.replace(/\\n/g, '\n');
  const out: Uint8Array<ArrayBuffer>[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(normalized); m; m = re.exec(normalized)) {
    out.push(base64ToBytes(m[1].replace(/\s+/g, '')));
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new DerError('invalid base64');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
