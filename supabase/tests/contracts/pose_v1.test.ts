import { assert, assertEquals } from '@std/assert';
import { frameModeForPose, KP_PER_FRAME, PoseV1, validatePoseAgainstCatalog } from '@shared/contracts/index.ts';
import { clone, loadFixture } from '../_helpers/fixtures.ts';

type Pose = PoseV1;
const valid = await loadFixture<Pose>('pose/synthetic_minimal.json');

/** Asserts the mutated payload fails with an issue whose path starts with `path` (dot-joined). */
function rejects(mutate: (p: Pose) => void, path: string): void {
  const p = clone(valid);
  mutate(p);
  const r = PoseV1.safeParse(p);
  assert(!r.success, `expected failure at ${path}`);
  const paths = r.error.issues.map((i) => i.path.join('.'));
  assert(paths.some((x) => x.startsWith(path)), `no issue at ${path}; got ${paths.join(' | ')}`);
}

Deno.test('synthetic_minimal fixture is a valid pose.v1', () => {
  const r = PoseV1.safeParse(valid);
  assert(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)));
  assertEquals(r.data.track.kp[0].length, KP_PER_FRAME);
  assertEquals(frameModeForPose(r.data), 'frames');
});

Deno.test('subject=other requires subjectConsent', () => {
  rejects((p) => {
    p.session.subject = 'other';
    p.session.subjectConsent = false;
  }, 'session.subjectConsent');
  const ok = clone(valid);
  ok.session.subject = 'other';
  ok.session.subjectConsent = true;
  assert(PoseV1.safeParse(ok).success);
});

Deno.test('subjectMinor requires subject=other and forces pose_only', () => {
  rejects((p) => {
    p.session.subjectMinor = true;
  }, 'session.subjectMinor');
  const minor = clone(valid);
  Object.assign(minor.session, { subject: 'other', subjectConsent: true, subjectMinor: true });
  const r = PoseV1.safeParse(minor);
  assert(r.success);
  assertEquals(frameModeForPose(r.data), 'pose_only');
});

Deno.test('analysisHz must be 30 or 60', () => {
  rejects((p) => {
    p.video.analysisHz = 50;
  }, 'video.analysisHz');
});

Deno.test('segment duration must be 3–32 s', () => {
  rejects((p) => {
    p.video.segment = { startMs: 1000, endMs: 3999 };
  }, 'video.segment');
  rejects((p) => {
    p.video.durationMs = 40_000;
    p.video.segment = { startMs: 0, endMs: 32_001 };
  }, 'video.segment');
});

Deno.test('tUs must be strictly increasing', () => {
  rejects((p) => {
    p.track.tUs[10] = p.track.tUs[9];
  }, 'track.tUs.10');
});

Deno.test('track arrays must have equal lengths', () => {
  rejects((p) => {
    p.track.flags.pop();
  }, 'track.flags');
  rejects((p) => {
    p.track.bbox.pop();
  }, 'track.bbox');
});

Deno.test('kp frames have 57 ints in range', () => {
  rejects((p) => {
    p.track.kp[3] = p.track.kp[3].slice(0, 56);
  }, 'track.kp.3');
  rejects((p) => {
    p.track.kp[4][2] = 101; // confidence > 100
  }, 'track.kp.4.2');
  rejects((p) => {
    p.track.kp[5][0] = 12.5;
  }, 'track.kp.5.0');
});

Deno.test('analysisId must be lowercase uuid', () => {
  rejects((p) => {
    p.analysisId = p.analysisId.toUpperCase();
  }, 'analysisId');
});

Deno.test('jointOrder must be the Vision order', () => {
  rejects((p) => {
    [p.track.jointOrder[0], p.track.jointOrder[1]] = [p.track.jointOrder[1], p.track.jointOrder[0]];
  }, 'track.jointOrder');
});

Deno.test('skill prefix must match sport', () => {
  rejects((p) => {
    p.session.skill = 'pb.serve';
  }, 'session.skill');
});

Deno.test('cameraView accepts auto; level may be omitted or null', () => {
  const p = clone(valid) as unknown as { session: Record<string, unknown> };
  p.session.cameraView = 'auto';
  delete p.session.level;
  assert(PoseV1.safeParse(p).success);
  p.session.level = null;
  assert(PoseV1.safeParse(p).success);
});

Deno.test('validatePoseAgainstCatalog checks enabled skill and sport', () => {
  const enabled = new Map([['bd.clear_fh', 'badminton' as const], ['pb.serve', 'pickleball' as const]]);
  assertEquals(validatePoseAgainstCatalog(valid, enabled), { ok: true });
  const disabled = validatePoseAgainstCatalog(valid, new Map([['pb.serve', 'pickleball' as const]]));
  assertEquals(disabled.ok, false);
  const wrongSport = validatePoseAgainstCatalog(valid, new Map([['bd.clear_fh', 'pickleball' as const]]));
  assert(!wrongSport.ok && wrongSport.code === 'skill_not_available');
});
