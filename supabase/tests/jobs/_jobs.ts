/** Helpers for the job tests: a prepared job in the fake backend, frames in Storage, scripted model clients. */
import type { FrameMode } from '@shared/contracts/index.ts';
import {
  type CoachModelClient,
  type CoachRequestParams,
  mockCoachClient,
  type MockScenario,
  type MockSource,
} from '@shared/claude/index.ts';
import type { PreparedAnalysisV1 } from '@shared/engine/index.ts';
import { InFlightJobs, type JobDeps } from '@shared/jobs/index.ts';
import { BUCKET_INPUTS, framePath } from '@shared/storage.ts';
import { captureLogger } from '@shared/testing/index.ts';
import { preparedFixture } from '../claude/_claude.ts';
import { type Backend, createBackend } from './_backend.ts';

export const UID = '5f8e2c1a-9b7d-4e3f-8a6c-2d1e0f9b8a7c';
/** A small valid JPEG header (the mock never decodes images). */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

/** A client that answers with a scripted scenario per call (default the mock generator) and counts calls. */
export class ScriptedClient {
  calls: CoachRequestParams[] = [];
  /** Scenario for call n (0-based); missing entries use 'ok'. */
  constructor(public scenarios: MockScenario[] = [], public onCall?: () => void) {}

  factory = (src: MockSource): CoachModelClient => {
    return {
      name: 'scripted',
      create: async (params, opts) => {
        const n = this.calls.length;
        this.calls.push(params);
        this.onCall?.();
        const msg = await mockCoachClient(src, this.scenarios[n] ?? 'ok').create(params, opts);
        // realistic meters (§8.7) so cost accounting has something to add up
        Object.assign(msg.usage, { input_tokens: 6400, output_tokens: 2500, cache_read_input_tokens: 7000 });
        return msg;
      },
    };
  };
}

export interface JobFixture {
  backend: Backend;
  id: string;
  prepared: PreparedAnalysisV1;
  client: ScriptedClient;
  deps: JobDeps;
  inflight: InFlightJobs;
  lines: ReturnType<typeof captureLogger>['lines'];
}

export function putFrames(backend: Backend, uid: string, id: string, prepared: PreparedAnalysisV1): void {
  for (const f of prepared.frameRequests.filter((r) => r.upload)) {
    backend.memory.put(BUCKET_INPUTS, framePath(uid, id, f.frameId), JPEG, 'image/jpeg');
  }
}

export async function jobFixture(
  options: { fixture?: string; frameMode?: FrameMode; scenarios?: MockScenario[]; frames?: boolean; row?: object } = {},
): Promise<JobFixture> {
  const backend = createBackend();
  backend.addUser(UID);
  const { prepared } = structuredClone(
    await preparedFixture(options.fixture ?? 'synthetic_bd_clear_fh_60', options.frameMode),
  );
  const id = prepared.analysisId;
  backend.seedJob({
    id,
    user_id: UID,
    sport: prepared.sport,
    skill: prepared.skill,
    frame_mode: prepared.frameMode,
    prepared,
    ...(options.row ?? {}),
  });
  if (options.frames !== false) putFrames(backend, UID, id, prepared);
  const client = new ScriptedClient(options.scenarios ?? []);
  const { log, lines } = captureLogger();
  const inflight = new InFlightJobs();
  const deps: JobDeps = {
    db: backend.db,
    storage: backend.storage,
    coachClient: client.factory,
    log,
    now: backend.now,
    inflight,
  };
  return { backend, id, prepared, client, deps, inflight, lines };
}

export function framesLeft(backend: Backend, id: string): string[] {
  return backend.memory.paths(BUCKET_INPUTS).filter((p) => p.includes(`/${id}/frames/`));
}
