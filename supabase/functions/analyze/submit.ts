/**
 * POST /analyze/submit `{analysisId, deviceCheckToken?}` (DESIGN.md §6.1, §6.5, §8.7, D12, D18).
 *
 * Checks, in order: ownership → consents current (403 `consent_required`) → expected frames in Storage (422
 * `frames_missing`; 5, or 0 in pose_only) → daily budget guard (503 `busy_try_later`, nothing reserved) → DeviceCheck
 * bit0 for the free first-ever bonus → `reserve_for_submit` (402 `quota_exceeded` / 429 `in_flight` / ok) → 202 and
 * `runOnce` in the background. Idempotent: queued or processing → 202, succeeded → 200.
 */
import { SubmitRequest, type SubmitResponse, type Tier } from '@shared/contracts/index.ts';
import type { AuthedUser } from '@shared/auth.ts';
import { budgetDecision, loadBudgetStatus } from '@shared/budget.ts';
import { fromRpcFailure, httpError } from '@shared/errors.ts';
import { json, parseJson, type RouteContext } from '@shared/http.ts';
import { expectedFrameIds, JOB_LIMITS, runOnce, uploadedFrameIds } from '@shared/jobs/index.ts';
import { errorFields, type Logger } from '@shared/log.ts';
import { type AnalyzeDeps, backgroundOf, jobDepsOf } from './deps.ts';

interface SubmitRow {
  user_id: string;
  status: string;
  frame_mode: 'frames' | 'pose_only';
  prepared: unknown;
}

interface ReserveResult {
  ok: boolean;
  code?: string;
  status?: 'queued' | 'processing' | 'succeeded';
  kind?: string;
  bonus?: boolean;
  idempotent?: boolean;
}

function accepted(status: 'queued' | 'processing'): Response {
  const body: SubmitResponse = { status, pollAfterMs: JOB_LIMITS.pollAfterMs };
  return json(body, 202);
}

function done(): Response {
  const body: SubmitResponse = { status: 'succeeded', pollAfterMs: 0 };
  return json(body, 200);
}

/** Seconds until the next ICT midnight (when the daily budget resets). */
export function secondsToIctMidnight(now: Date): number {
  const ict = now.getTime() + 7 * 3600_000;
  const next = (Math.floor(ict / 86_400_000) + 1) * 86_400_000;
  return Math.max(60, Math.ceil((next - ict) / 1000));
}

function startJob(deps: AnalyzeDeps, analysisId: string, log: Logger): void {
  void backgroundOf(deps)(runOnce(analysisId, jobDepsOf(deps, log)), log);
}

/** DeviceCheck bit0 = this device already used the free first-ever bonus. Any failure → no bonus (logged). */
async function deviceBonusOk(deps: AnalyzeDeps, token: string, log: Logger): Promise<{ ok: boolean; bit1: boolean }> {
  if (!deps.deviceCheck) return { ok: false, bit1: false };
  try {
    const bits = await deps.deviceCheck.queryTwoBits(token);
    return { ok: !bits.bit0, bit1: bits.bit1 };
  } catch (err) {
    log.warn('devicecheck query failed; no first-ever bonus', errorFields(err));
    return { ok: false, bit1: false };
  }
}

export async function handleSubmit(
  req: Request,
  ctx: RouteContext,
  deps: AnalyzeDeps,
  user: AuthedUser,
): Promise<Response> {
  const body = await parseJson(req, SubmitRequest);
  const id = body.analysisId;
  const log = ctx.log.child({ analysisId: id });

  // 1. ownership
  const row = await deps.db.selectOne<SubmitRow>('public', 'analyses', 'user_id, status, frame_mode, prepared', { id });
  if (!row || row.user_id !== user.userId) throw httpError('analysis_not_found');
  if (row.status === 'queued' || row.status === 'processing') {
    startJob(deps, id, log); // harmless with fencing; picks up a job whose first run was lost
    return accepted(row.status);
  }
  if (row.status === 'succeeded') return done();
  if (row.status !== 'prepared') throw httpError('analysis_conflict', `analysis is ${row.status}`);

  // 2. consents
  if ((await deps.db.rpc<boolean>('private', 'consent_current', { p_user_id: user.userId })) !== true) {
    throw httpError('consent_required');
  }

  // 3. frames
  const expected = expectedFrameIds(row.prepared);
  if (expected.length > 0) {
    const present = await uploadedFrameIds(deps.storage, user.userId, id);
    const missing = expected.filter((f) => !present.has(f));
    if (missing.length) throw httpError('frames_missing', `missing ${missing.join(', ')}`);
  }

  // 4. budget guard (§8.7): before anything is reserved
  const quota = await deps.db.rpc<{ tier: Tier; bonusAvailable?: boolean }>('private', 'quota_status', {
    p_user_id: user.userId,
  });
  const profile = await deps.db.selectOne<{ is_reviewer: boolean }>('public', 'profiles', 'is_reviewer', {
    id: user.userId,
  });
  const budget = await loadBudgetStatus(deps.db);
  const decision = budgetDecision(budget, { tier: quota.tier, isReviewer: profile?.is_reviewer === true });
  const now = deps.now?.() ?? new Date();
  if (!decision.allow) {
    log.warn('submit refused by the budget guard', { level: decision.level, tier: quota.tier });
    throw httpError('busy_try_later', undefined, { headers: { 'retry-after': String(secondsToIctMidnight(now)) } });
  }

  // 5. DeviceCheck (first-ever bonus only; skipped when the budget downgrades free standard to basic)
  const token = body.deviceCheckToken ?? null;
  let bonus = { ok: false, bit1: false };
  if (token && quota.tier === 'free' && quota.bonusAvailable === true && !decision.downgradeFreeStandard) {
    bonus = await deviceBonusOk(deps, token, log);
  }

  // 6. reserve
  const res = await deps.db.rpc<ReserveResult>('private', 'reserve_for_submit', {
    p_user_id: user.userId,
    p_analysis_id: id,
    p_device_bonus_ok: bonus.ok,
  });
  if (!res?.ok) throw fromRpcFailure(res ?? {});
  if (res.status === 'succeeded') return done();
  if (res.bonus === true && token && deps.deviceCheck) {
    // The device token is not stored, so the bit is set at reservation (a refunded bonus stays used on the device).
    const dc = deps.deviceCheck;
    void backgroundOf(deps)(dc.updateTwoBits(token, { bit0: true, bit1: bonus.bit1 }), log);
  }
  log.info('submitted', { kind: res.kind, idempotent: res.idempotent === true, budget: decision.level });
  startJob(deps, id, log);
  return accepted(res.status === 'processing' ? 'processing' : 'queued');
}
