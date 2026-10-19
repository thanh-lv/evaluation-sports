#!/usr/bin/env bash
# Test-only X.509 chains for supabase/functions/_shared/apple/jws.ts (DESIGN.md §4, §9.4).
#
# Mirrors Apple's StoreKit signing chain: a P-384 root (stand-in for Apple Root CA G3) signs a P-384 intermediate
# carrying OID 1.2.840.113635.100.6.2.1 (WWDR), which signs a P-256 leaf carrying OID 1.2.840.113635.100.6.11.1
# (receipt signing). JWS test payloads are signed with the leaf key at test time (supabase/tests/apple/_jws.ts).
#
# Also writes the negative cases: an expired leaf, a leaf and an intermediate without their Apple OIDs, a rogue chain
# (its own root) and a P-256 ".p8" key for the ES256 JWT tests. None of these keys is used outside tests.
#
#   bash scripts/gen-test-certs.sh [out_dir]      # default: shared/fixtures/apple (committed)
#
# Works with OpenSSL 3.x and LibreSSL (macOS). Output is random (new keys, serials) on every run; the committed files
# are what the tests use, so only re-run it when a certificate needs to change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/shared/fixtures/apple}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

START=20250101000000Z # back-dated so fixed test dates fall inside the validity
END=20500101000000Z   # the committed fixtures stay valid until 2050
LEAF_OID=1.2.840.113635.100.6.11.1
INTERMEDIATE_OID=1.2.840.113635.100.6.2.1

cat >"$WORK/ext.cnf" <<CNF
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
$INTERMEDIATE_OID = ASN1:NULL

[intermediate_no_oid]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid

[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
$LEAF_OID = ASN1:NULL

[leaf_no_oid]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid

[ca]
default_ca = test_ca

[test_ca]
dir = $WORK/ca
database = $WORK/ca/index.txt
new_certs_dir = $WORK/ca
serial = $WORK/ca/serial
default_md = sha384
policy = any_policy
unique_subject = no
copy_extensions = none

[any_policy]
commonName = supplied
organizationName = optional
CNF

# key <name> <curve>: PKCS#8 private key (WebCrypto imports PKCS#8)
key() {
  openssl ecparam -name "$2" -genkey -noout -out "$WORK/$1.sec1.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$WORK/$1.sec1.pem" -out "$OUT/$1.key.pem"
}

# csr <cert name> <key name> <cn>
csr() {
  openssl req -new -sha256 -key "$OUT/$2.key.pem" -subj "/CN=$3/O=RacketCoach Test" -out "$WORK/$1.csr" \
    -config "$WORK/ext.cnf" 2>/dev/null
}

# issue <cert name> <issuer name|self> <ext section> [start] [end]: `openssl ca` is the portable way to set explicit
# (back-dated) validity, so a JWS signedDate in the past still falls inside it.
issue() {
  local start="${4:-$START}" end="${5:-$END}"
  local signer=(-cert "$OUT/$2.crt.pem" -keyfile "$OUT/$2.key.pem")
  if [ "$2" = self ]; then signer=(-selfsign -keyfile "$OUT/$1.key.pem"); fi
  openssl ca -batch -config "$WORK/ext.cnf" -name test_ca "${signer[@]}" -in "$WORK/$1.csr" -startdate "$start" \
    -enddate "$end" -extfile "$WORK/ext.cnf" -extensions "$3" -notext -out "$OUT/$1.crt.pem" 2>/dev/null
}

mkdir -p "$WORK/ca"
: >"$WORK/ca/index.txt"
openssl rand -hex 8 >"$WORK/ca/serial"

# Trusted test chain
key root secp384r1
csr root root 'Test Apple Root CA - G3'
issue root self root
key intermediate secp384r1
csr intermediate intermediate 'Test Apple Worldwide Developer Relations CA - G6'
issue intermediate root intermediate
key leaf prime256v1
csr leaf leaf 'Test Prod ECC Mac App Store and iTunes Store Receipt Signing'
issue leaf intermediate leaf

# Negative cases (same keys, so only the property under test differs)
csr leaf_no_oid leaf 'Test Leaf Without OID'
issue leaf_no_oid intermediate leaf_no_oid
csr intermediate_no_oid intermediate 'Test Apple Worldwide Developer Relations CA - G6'
issue intermediate_no_oid root intermediate_no_oid
csr leaf_expired leaf 'Test Expired Leaf'
issue leaf_expired intermediate leaf 20200101000000Z 20210101000000Z

# Rogue chain: same names and OIDs, different root
key rogue_root secp384r1
csr rogue_root rogue_root 'Test Apple Root CA - G3'
issue rogue_root self root
key rogue_intermediate secp384r1
csr rogue_intermediate rogue_intermediate 'Test Apple Worldwide Developer Relations CA - G6'
issue rogue_intermediate rogue_root intermediate
key rogue_leaf prime256v1
csr rogue_leaf rogue_leaf 'Test Prod ECC Mac App Store and iTunes Store Receipt Signing'
issue rogue_leaf rogue_intermediate leaf

# ES256 key in the App Store Connect ".p8" format (PKCS#8 P-256) for the JWT tests
key test_p8 prime256v1

# Sanity: the trusted chain verifies with OpenSSL
openssl verify -CAfile "$OUT/root.crt.pem" -untrusted "$OUT/intermediate.crt.pem" "$OUT/leaf.crt.pem" >/dev/null
echo "gen-test-certs: wrote $(find "$OUT" -name '*.pem' | wc -l | tr -d ' ') PEM files to $OUT"
