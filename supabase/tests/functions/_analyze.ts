/** Test rig for the `analyze` and `cron` handlers over the in-memory job backend. */
import { PoseV1 } from '@shared/contracts/index.ts';
import type { DeviceCheckClient, TwoBits } from '@shared/apple/devicecheck.ts';
import type { Logger } from '@shared/log.ts';
import { captureLogger, FakeClaimsVerifier, jsonRequest } from '@shared/testing/index.ts';
import { InFlightJobs } from '@shared/jobs/index.ts';
import { createAnalyzeHandler } from '../../functions/analyze/handler.ts';
import type { AnalyzeLimits } from '../../functions/analyze/deps.ts';
import { loadFixture } from '../_helpers/fixtures.ts';
import { type Backend, createBackend } from '../jobs/_backend.ts';
import { ScriptedClient } from '../jobs/_jobs.ts';

export const ALICE = 'a11ce000-0000-4000-8000-000000000001';
export const BOB = 'b0b00000-0000-4000-8000-000000000002';
export const INTERNAL = 'internal-secret-test';

export const LAUNCH_SKILLS = [
  ['bd.clear_fh', 'badminton'],
  ['bd.smash', 'badminton'],
  ['bd.serve_low', 'badminton'],
  ['pb.serve', 'pickleball'],
  ['pb.dink', 'pickleball'],
  ['pb.drop3', 'pickleball'],
] as const;

export class FakeDeviceCheck implements DeviceCheckClient {
  queries: string[] = [];
  updates: { token: string; bit0: boolean; bit1: boolean }[] = [];
  bits: TwoBits = { bit0: false, bit1: false, lastUpdateTime: null };
  fail: Error | null = null;
  queryTwoBits(token: string): Promise<TwoBits> {
    this.queries.push(token);
    return this.fail ? Promise.reject(this.fail) : Promise.resolve({ ...this.bits });
  }
  updateTwoBits(token: string, bits: { bit0: boolean; bit1: boolean }): Promise<void> {
    this.updates.push({ token, ...bits });
    return Promise.resolve();
  }
}

export interface Rig {
  b: Backend;
  verifier: FakeClaimsVerifier;
  client: ScriptedClient;
  deviceCheck: FakeDeviceCheck;
  tasks: Promise<unknown>[];
  lines: ReturnType<typeof captureLogger>['lines'];
  handler: (req: Request) => Promise<Response>;
  token(uid: string): string;
  post(path: string, body: unknown, uid?: string | null, headers?: Record<string, string>): Promise<Response>;
  get(path: string, uid?: string | null): Promise<Response>;
  /** Waits for every background job started so far. */
  drain(): Promise<void>;
}

export function rig(options: { deviceCheck?: boolean; limits?: Partial<AnalyzeLimits> } = {}): Rig {
  const b = createBackend();
  for (const [skill, sport] of LAUNCH_SKILLS) {
    b.db.table('public', 'enabled_skills').push({ skill, sport, enabled: true });
  }
  b.db.table('public', 'enabled_skills').push({ skill: 'bd.lift', sport: 'badminton', enabled: false });
  b.db.table('public', 'plan_limits').push(
    { tier: 'premium', period_type: 'subscription_month', total_limit: 15, standard_limit: 15 },
    { tier: 'free', period_type: 'calendar_month', total_limit: 2, standard_limit: 0 },
    { tier: 'trial', period_type: 'trial', total_limit: 10, standard_limit: 5 },
  );
  b.addUser(ALICE);
  b.addUser(BOB);
  const verifier = new FakeClaimsVerifier();
  const client = new ScriptedClient();
  const deviceCheck = new FakeDeviceCheck();
  const { log, lines } = captureLogger();
  const tasks: Promise<unknown>[] = [];
  const background = (task: Promise<unknown>, l: Logger) => {
    const guarded = task.then(() => {}, (err) => l.error('background task failed', { err: String(err) }));
    tasks.push(guarded);
    return guarded;
  };
  const handler = createAnalyzeHandler({
    db: b.db,
    storage: b.storage,
    verifier,
    internalSecret: INTERNAL,
    deviceCheck: options.deviceCheck === false ? null : deviceCheck,
    coachClient: client.factory,
    logger: log,
    inflight: new InFlightJobs(),
    now: b.now,
    limits: options.limits,
    background,
  });
  const tokens = new Map<string, string>();
  const token = (uid: string) => {
    let t = tokens.get(uid);
    if (!t) {
      t = verifier.issue({ userId: uid, anonymous: true });
      tokens.set(uid, t);
    }
    return t;
  };
  return {
    b,
    verifier,
    client,
    deviceCheck,
    tasks,
    lines,
    handler,
    token,
    post: (path, body, uid = ALICE, headers = {}) =>
      handler(jsonRequest(path, body, { token: uid ? token(uid) : undefined, headers })),
    get: (path, uid = ALICE) =>
      handler(
        new Request(`http://localhost/functions/v1/analyze${path}`, {
          headers: uid ? { authorization: `Bearer ${token(uid)}` } : {},
        }),
      ),
    drain: async () => {
      let n = -1;
      while (n !== tasks.length) {
        n = tasks.length;
        await Promise.all(tasks);
      }
    },
  };
}

/** A synthetic pose.v1 body (prepares to 2+ strokes) with a fresh analysis id. */
export async function poseBody(
  fixture = 'synthetic_bd_clear_fh_60',
  patch: { analysisId?: string; subjectMinor?: boolean } = {},
): Promise<PoseV1> {
  const pose = await loadFixture<PoseV1>(`pose/${fixture}.json`);
  pose.analysisId = patch.analysisId ?? crypto.randomUUID();
  if (patch.subjectMinor) {
    pose.session.subject = 'other';
    pose.session.subjectConsent = true;
    pose.session.subjectMinor = true;
  }
  return PoseV1.parse(pose);
}
