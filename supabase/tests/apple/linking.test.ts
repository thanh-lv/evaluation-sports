/** `_shared/apple/linking.ts`: the DESIGN §9.4 linking matrix as a pure function, plus owner resolution. */
import { assertEquals } from '@std/assert';
import {
  decideLink,
  type LinkDecision,
  normalizeToken,
  type OwnerLookup,
  resolveRowOwner,
  resolveTokenOwner,
  type RowOwner,
  type TokenOwner,
  type VerifyReason,
} from '@shared/apple/linking.ts';

const REASONS: VerifyReason[] = ['purchase', 'restore', 'launch', 'update'];
const LINK_VERIFIED: LinkDecision = { action: 'link', verifyChain: true, setToken: true };
const TRANSFER: LinkDecision = { action: 'transfer', verifyChain: true, setToken: true };
const REJECT: LinkDecision = { action: 'reject', code: 'linked_to_other_account' };

Deno.test('§9.4 table: token equals the caller → link (no chain check, no Set App Account Token)', () => {
  for (const reason of REASONS) {
    for (const rowOwner of ['none', 'caller', 'other_live'] as RowOwner[]) {
      assertEquals(decideLink({ reason, tokenOwner: 'caller', rowOwner }), {
        action: 'link',
        verifyChain: false,
        setToken: false,
      });
    }
  }
});

Deno.test('§9.4 table: null / deleted / merged-into-caller token → verify chain, link, Set App Account Token', () => {
  for (const reason of REASONS) {
    for (const tokenOwner of ['none', 'deleted', 'merged_into_caller'] as TokenOwner[]) {
      assertEquals(decideLink({ reason, tokenOwner, rowOwner: 'none' }), LINK_VERIFIED, `${reason} ${tokenOwner}`);
    }
  }
});

Deno.test('§9.4 table: another live user → transfer on restore, 409 otherwise', () => {
  for (const rowOwner of ['none', 'other_live'] as RowOwner[]) {
    assertEquals(decideLink({ reason: 'restore', tokenOwner: 'other_live', rowOwner }), TRANSFER);
    for (const reason of ['purchase', 'launch', 'update'] as VerifyReason[]) {
      assertEquals(decideLink({ reason, tokenOwner: 'other_live', rowOwner }), REJECT);
    }
  }
});

Deno.test('hardening: our row held by another live user beats a null/deleted token; our own row beats a stale token', () => {
  for (const tokenOwner of ['none', 'deleted', 'merged_into_caller'] as TokenOwner[]) {
    assertEquals(decideLink({ reason: 'restore', tokenOwner, rowOwner: 'other_live' }), TRANSFER);
    assertEquals(decideLink({ reason: 'launch', tokenOwner, rowOwner: 'other_live' }), REJECT);
  }
  // e.g. a transfer whose Set App Account Token failed: re-point, no chain needed (the link was already verified)
  for (const tokenOwner of ['none', 'deleted', 'other_live'] as TokenOwner[]) {
    assertEquals(decideLink({ reason: 'launch', tokenOwner, rowOwner: 'caller' }), {
      action: 'link',
      verifyChain: false,
      setToken: true,
    });
  }
});

const CALLER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const MERGED = '44444444-4444-4444-8444-444444444444';

const lookup: OwnerLookup = {
  getUser: (id) => Promise.resolve([CALLER, OTHER].includes(id) ? { id, isAnonymous: false } : null),
  wasMergedInto: (from, into) => Promise.resolve(from === MERGED && into === CALLER),
};

Deno.test('normalizeToken lower-cases uuids and drops anything else', () => {
  assertEquals(normalizeToken(CALLER.toUpperCase()), CALLER);
  assertEquals(normalizeToken(` ${CALLER} `), CALLER);
  for (const bad of [null, undefined, '', 'not-a-uuid', 42]) assertEquals(normalizeToken(bad), null);
});

Deno.test('resolveTokenOwner / resolveRowOwner classify every case', async () => {
  assertEquals(await resolveTokenOwner(null, CALLER, lookup), 'none');
  assertEquals(await resolveTokenOwner(CALLER, CALLER, lookup), 'caller');
  assertEquals(await resolveTokenOwner(OTHER, CALLER, lookup), 'other_live');
  assertEquals(await resolveTokenOwner(GONE, CALLER, lookup), 'deleted');
  assertEquals(await resolveTokenOwner(MERGED, CALLER, lookup), 'merged_into_caller');
  assertEquals(await resolveTokenOwner(MERGED, OTHER, lookup), 'deleted');
  assertEquals(await resolveRowOwner(null, CALLER, lookup), 'none');
  assertEquals(await resolveRowOwner(CALLER.toUpperCase(), CALLER, lookup), 'caller');
  assertEquals(await resolveRowOwner(OTHER, CALLER, lookup), 'other_live');
  assertEquals(await resolveRowOwner(GONE, CALLER, lookup), 'none');
});
