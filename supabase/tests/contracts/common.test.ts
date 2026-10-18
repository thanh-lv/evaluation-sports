import { assert, assertEquals } from '@std/assert';
import {
  API_ERROR_STATUS,
  ApiError,
  apiError,
  httpStatusFor,
  isPrepareRejection,
  JOINT_INDEX,
  JOINT_ORDER,
  KP_PER_FRAME,
  LowerUuid,
  PREPARE_REJECTION_CODES,
  REJECTION_TIPS,
  TIP_KEYS,
  viewFactorColumn,
} from '@shared/contracts/index.ts';

Deno.test('joint order is the 19 Vision joints', () => {
  assertEquals(JOINT_ORDER.length, 19);
  assertEquals(KP_PER_FRAME, 57);
  assertEquals(JOINT_INDEX.root, 12);
  assertEquals(JOINT_INDEX.rAnk, 18);
});

Deno.test('error catalog statuses', () => {
  assertEquals(httpStatusFor('invalid_payload'), 422);
  assertEquals(httpStatusFor('transfer_rate_limited'), 429);
  assertEquals(httpStatusFor('quota_exceeded'), 402);
  assertEquals(httpStatusFor('consent_required'), 403);
  assertEquals(httpStatusFor('analysis_conflict'), 409);
  assertEquals(httpStatusFor('linked_to_other_account'), 409);
  assertEquals(httpStatusFor('in_flight'), 429);
  assertEquals(httpStatusFor('busy_try_later'), 503);
  for (const code of PREPARE_REJECTION_CODES) {
    assertEquals(API_ERROR_STATUS[code], 422);
    assert(isPrepareRejection(code));
    assert(REJECTION_TIPS[code].length > 0);
  }
  assert(!isPrepareRejection('quota_exceeded'));
});

Deno.test('rejection tips are catalog keys', () => {
  for (const tips of Object.values(REJECTION_TIPS)) {
    for (const t of tips) assert((TIP_KEYS as readonly string[]).includes(t), t);
  }
});

Deno.test('ApiError body', () => {
  const body = apiError('player_too_small', undefined, REJECTION_TIPS.player_too_small);
  assert(ApiError.safeParse(body).success);
  assertEquals(Object.keys(body), ['code', 'tips']);
  assert(!ApiError.safeParse({ code: 'nope' }).success);
  const quota = apiError('quota_exceeded', undefined, undefined, { limit: 2, used: 2, resetsAt: null });
  assert(ApiError.safeParse(quota).success);
  assertEquals(quota.limit, 2);
});

Deno.test('lowercase uuid', () => {
  assert(LowerUuid.safeParse('0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d').success);
  assert(!LowerUuid.safeParse('0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D').success);
});

Deno.test('front view uses B factors mirrored', () => {
  assertEquals(viewFactorColumn('front'), { column: 'B', mirrorLateral: true });
  assertEquals(viewFactorColumn('diagonal'), { column: 'D', mirrorLateral: false });
  assertEquals(viewFactorColumn('S'), { column: 'S', mirrorLateral: false });
});
