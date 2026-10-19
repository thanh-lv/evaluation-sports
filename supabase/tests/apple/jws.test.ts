/**
 * `_shared/apple/jws.ts` + `der.ts`: decode without trust, x5c chain verification against the committed test chain
 * (scripts/gen-test-certs.sh) with every failure mode, and the real Apple chain (root embedded, fingerprint pinned).
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
  decodeJws,
  decodeJwsPayload,
  JwsError,
  type JwsFailure,
  parseChain,
  trustedRoots,
  verifyChain,
  verifyJws,
} from '@shared/apple/jws.ts';
import { parseCertificate, pemCertificates } from '@shared/apple/der.ts';
import { sha256Hex } from '@shared/crypto.ts';
import { certDer, fixtureText, NOW, signJws, TEST_ROOTS, transaction, unsignedJws } from './_apple.ts';

async function expectFailure(p: Promise<unknown>, reason: JwsFailure): Promise<void> {
  const err = await assertRejects(() => p, JwsError);
  assertEquals(err.reason, reason, err.message);
}

Deno.test('decodeJws reads header and payload without trusting them', async () => {
  const tx = transaction();
  const jws = await signJws(tx);
  const decoded = decodeJws<typeof tx>(jws);
  assertEquals(decoded.payload, tx);
  assertEquals(decoded.header.alg, 'ES256');
  assertEquals(decoded.header.x5c?.length, 3);
  assertEquals(decoded.signature.length, 64);
  assertEquals(decodeJwsPayload(unsignedJws({ a: 1 })), { a: 1 });
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '!!.e30.x', `${btoa('[1]')}.e30.x`, 'e30.bm90anNvbg.x']) {
    const err = assertThrows(() => decodeJws(bad), JwsError);
    assertEquals(err.reason, 'malformed', bad);
  }
});

Deno.test('verifyJws: the trusted test chain passes and returns the payload', async () => {
  const tx = transaction();
  assertEquals(await verifyJws<typeof tx>(await signJws(tx), { roots: TEST_ROOTS }), tx);
});

Deno.test('verifyJws: wrong root, mixed chain, missing OIDs, expired, bad signature fail closed', async () => {
  const tx = transaction();
  await expectFailure(verifyJws(await signJws(tx, { chain: 'rogue' }), { roots: TEST_ROOTS }), 'untrusted_root');
  // rogue leaf + intermediate presented with the real (test) root: the intermediate is not signed by it
  await expectFailure(verifyJws(await signJws(tx, { chain: 'mixed' }), { roots: TEST_ROOTS }), 'chain_signature');
  await expectFailure(verifyJws(await signJws(tx, { chain: 'leaf_no_oid' }), { roots: TEST_ROOTS }), 'missing_oid');
  await expectFailure(
    verifyJws(await signJws(tx, { chain: 'intermediate_no_oid' }), { roots: TEST_ROOTS }),
    'missing_oid',
  );
  // leaf_expired is valid 2020–2021 only; signedDate is 2026
  await expectFailure(verifyJws(await signJws(tx, { chain: 'leaf_expired' }), { roots: TEST_ROOTS }), 'expired');
  // a signedDate outside the chain's validity (2050+) is expired too
  await expectFailure(
    verifyJws(await signJws({ ...tx, signedDate: Date.parse('2051-01-01') }), { roots: TEST_ROOTS }),
    'expired',
  );
  // signed by a key that is not the leaf's
  await expectFailure(verifyJws(await signJws(tx, { keyFrom: 'rogue' }), { roots: TEST_ROOTS }), 'bad_signature');
  // payload swapped after signing
  const [h, , s] = (await signJws(tx)).split('.');
  const forged = `${h}.${unsignedJws({ ...tx, productId: 'x' }).split('.')[1]}.${s}`;
  await expectFailure(verifyJws(forged, { roots: TEST_ROOTS }), 'bad_signature');
});

Deno.test('verifyJws: header and configuration errors', async () => {
  const tx = transaction();
  await expectFailure(verifyJws(await signJws(tx), { roots: [] }), 'no_trusted_roots');
  await expectFailure(
    verifyJws(await signJws(tx, { header: { alg: 'none' } }), { roots: TEST_ROOTS }),
    'unsupported_alg',
  );
  await expectFailure(verifyJws(await signJws(tx, { header: { x5c: [] } }), { roots: TEST_ROOTS }), 'bad_chain');
  await expectFailure(
    verifyJws(await signJws(tx, { header: { x5c: ['AAAA', 'AAAA', 'AAAA'] } }), { roots: TEST_ROOTS }),
    'bad_chain',
  );
  await expectFailure(verifyJws(unsignedJws(tx), { roots: TEST_ROOTS }), 'bad_chain');
  // the check date can be pinned explicitly
  await expectFailure(verifyJws(await signJws(tx), { roots: TEST_ROOTS, at: new Date('2024-06-01') }), 'expired');
});

Deno.test('der: test certificates carry the Apple OIDs and CA flags', () => {
  const leaf = parseCertificate(certDer('leaf.crt.pem'));
  const intermediate = parseCertificate(certDer('intermediate.crt.pem'));
  assert(leaf.extensions.has(APPLE_LEAF_OID));
  assert(!leaf.isCA);
  assert(intermediate.extensions.has(APPLE_INTERMEDIATE_OID));
  assert(intermediate.isCA);
  assert(!parseCertificate(certDer('leaf_no_oid.crt.pem')).extensions.has(APPLE_LEAF_OID));
  assertThrows(() => parseCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01])));
});

Deno.test('embedded Apple Root CA - G3 matches the pinned SHA-256 fingerprint', async () => {
  const [der] = pemCertificates(APPLE_ROOT_CA_G3_PEM);
  const hex = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', der)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  assertEquals(hex, APPLE_ROOT_CA_G3_SHA256);
  assertEquals(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const root = parseCertificate(der);
  assert(root.isCA);
  assertEquals(root.notAfter.toISOString(), '2039-04-30T18:19:06.000Z');
  // the fixture copy is the same certificate
  assertEquals(pemCertificates(fixtureText('real/apple_root_ca_g3.crt.pem'))[0], der);
});

Deno.test('verifyChain: the real Apple chain (WWDR G6 → receipt signing leaf) verifies against the embedded root', async () => {
  const b64 = (name: string) => btoa(String.fromCharCode(...certDer(name)));
  const chain = parseChain([
    b64('real/apple_receipt_signing_leaf.crt.pem'),
    b64('real/apple_wwdr_g6.crt.pem'),
    b64('real/apple_root_ca_g3.crt.pem'),
  ]);
  const roots = trustedRoots(null);
  await verifyChain(chain, roots, new Date('2025-11-01T00:00:00Z'));
  // leaf valid until 2027-10-13
  await expectFailure(verifyChain(chain, roots, new Date('2028-01-01T00:00:00Z')), 'expired');
  // not trusted under the test root
  await expectFailure(verifyChain(chain, TEST_ROOTS, new Date('2025-11-01T00:00:00Z')), 'untrusted_root');
  // a test leaf under Apple's real intermediate: not signed by it
  const spliced = parseChain([
    btoa(String.fromCharCode(...certDer('leaf.crt.pem'))),
    b64('real/apple_wwdr_g6.crt.pem'),
    b64('real/apple_root_ca_g3.crt.pem'),
  ]);
  await expectFailure(verifyChain(spliced, roots, NOW), 'chain_signature');
});

Deno.test('trustedRoots: embedded root plus APPLE_ROOT_CA_G3_PEM (one-line \\n form accepted); garbage rejected', () => {
  assertEquals(trustedRoots(null).length, 1);
  const extra = fixtureText('root.crt.pem').replace(/\n/g, '\\n');
  const roots = trustedRoots(extra);
  assertEquals(roots.length, 2);
  assertEquals(roots[1], TEST_ROOTS[0]);
  assertThrows(() => trustedRoots('not a pem'));
  assertThrows(() => trustedRoots('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'));
});

const hasOpenssl = await new Deno.Command('openssl', { args: ['version'], stdout: 'null', stderr: 'null' }).output()
  .then((o) => o.success, () => false);

Deno.test({
  name: 'scripts/gen-test-certs.sh produces a chain that verifies (and its rogue root does not)',
  ignore: !hasOpenssl,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'rc-certs-' });
    try {
      const script = new URL('../../../scripts/gen-test-certs.sh', import.meta.url).pathname;
      const out = await new Deno.Command('bash', { args: [script, dir], stdout: 'null', stderr: 'piped' }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      const read = (n: string) => Deno.readTextFileSync(`${dir}/${n}`);
      const der = (n: string) => pemCertificates(read(n))[0];
      const b64 = (n: string) => btoa(String.fromCharCode(...der(n)));
      const keyDer = Uint8Array.from(
        atob(read('leaf.key.pem').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')),
        (c) => c.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey('pkcs8', keyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ]);
      const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const input = `${enc({ alg: 'ES256', x5c: ['leaf', 'intermediate', 'root'].map((n) => b64(`${n}.crt.pem`)) })}.${
        enc({ signedDate: NOW.getTime() })
      }`;
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)),
      );
      const jws = `${input}.${
        btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      }`;
      assertEquals(await verifyJws(jws, { roots: [der('root.crt.pem')] }), { signedDate: NOW.getTime() });
      await expectFailure(verifyJws(jws, { roots: [der('rogue_root.crt.pem')] }), 'untrusted_root');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('verifyJws (adversarial): alg must be exactly ES256; x5c must be exactly 3 base64 strings', async () => {
  const tx = transaction();
  for (const alg of ['HS256', 'ES384', 'RS256', 'es256', 'NONE', undefined, null, 1]) {
    await expectFailure(verifyJws(await signJws(tx, { header: { alg } }), { roots: TEST_ROOTS }), 'unsupported_alg');
  }
  const b64 = (name: string) => btoa(String.fromCharCode(...certDer(name)));
  const [leaf, intermediate, root] = ['leaf.crt.pem', 'intermediate.crt.pem', 'root.crt.pem'].map(b64);
  for (
    const x5c of [[leaf, intermediate], [leaf, intermediate, root, root], [leaf, intermediate, 7], 'x', null, undefined]
  ) {
    await expectFailure(verifyJws(await signJws(tx, { header: { x5c } }), { roots: TEST_ROOTS }), 'bad_chain');
  }
});

Deno.test('verifyJws (adversarial): CA as leaf, root as intermediate, DER signature, header swap', async () => {
  const tx = transaction();
  const b64 = (name: string) => btoa(String.fromCharCode(...certDer(name)));
  const [leaf, intermediate, root] = ['leaf.crt.pem', 'intermediate.crt.pem', 'root.crt.pem'].map(b64);
  // the intermediate presented as the leaf (a CA certificate must not sign payloads)
  await expectFailure(
    verifyJws(await signJws(tx, { header: { x5c: [intermediate, intermediate, root] } }), { roots: TEST_ROOTS }),
    'bad_chain',
  );
  // the trusted root presented as the intermediate: no WWDR OID
  await expectFailure(
    verifyJws(await signJws(tx, { header: { x5c: [leaf, root, root] } }), { roots: TEST_ROOTS }),
    'missing_oid',
  );
  // order swapped
  await expectFailure(
    verifyJws(await signJws(tx, { header: { x5c: [intermediate, leaf, root] } }), { roots: TEST_ROOTS }),
    'not_ca',
  );
  // a valid signature re-encoded as DER (ECDSA-Sig-Value) instead of JWS r||s is rejected
  const [h, p, s] = (await signJws(tx)).split('.');
  const raw = decodeJws(`${h}.${p}.${s}`).signature;
  const int = (b: Uint8Array) => {
    let v = Array.from(b);
    while (v.length > 1 && v[0] === 0) v = v.slice(1);
    if (v[0] & 0x80) v = [0, ...v];
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  const der = new Uint8Array([0x30, body.length, ...body]);
  const derSig = btoa(String.fromCharCode(...der)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await expectFailure(verifyJws(`${h}.${p}.${derSig}`, { roots: TEST_ROOTS }), 'bad_signature');
  // empty signature
  await expectFailure(verifyJws(`${h}.${p}.`, { roots: TEST_ROOTS }), 'bad_signature');
  // the signature covers the header too: a re-encoded header (same chain, extra field) breaks it
  const header2 = (await signJws(tx, { header: { kid: 'x' } })).split('.')[0];
  await expectFailure(verifyJws(`${header2}.${p}.${s}`, { roots: TEST_ROOTS }), 'bad_signature');
});
