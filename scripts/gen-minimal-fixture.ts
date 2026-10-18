/**
 * Writes shared/fixtures/pose/synthetic_minimal.json: a tiny valid pose.v1 (4 s at 30 Hz, one overhead swing of
 * the right arm peaking near t = 3 s on the clip timeline). Deterministic. The realistic generator
 * (VFR gaps, 20–30 T/s, reversals) is scripts/gen-synthetic-pose.ts from the engine milestone.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/gen-minimal-fixture.ts [--check]
 */
import { type Joint, JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { prettyJson, repoPath } from './_lib/json.ts';

const OUT = 'shared/fixtures/pose/synthetic_minimal.json';
const HZ = 30;
const FRAMES = 120;
const T0_US = 1_000_000; // segment starts after the 1 s export padding

/** Standing pose in CFS (x right, y down), player ≈ 60 % of frame height. */
const BASE: Record<Joint, [number, number]> = {
  nose: [500, 270],
  lEye: [508, 262],
  rEye: [492, 262],
  lEar: [518, 268],
  rEar: [482, 268],
  neck: [500, 320],
  lSho: [535, 330],
  rSho: [465, 330],
  lElb: [555, 400],
  rElb: [445, 400],
  lWri: [565, 465],
  rWri: [435, 465],
  root: [500, 520],
  lHip: [522, 520],
  rHip: [478, 520],
  lKne: [528, 670],
  rKne: [472, 670],
  lAnk: [533, 830],
  rAnk: [467, 830],
};

/** Small deterministic PRNG (mulberry32) for jitter. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Right-arm swing angle (radians from straight up, + = forward/left in image): back-scratch → forward-down. */
function armAngle(tSec: number): number {
  const contact = 2.0; // seconds after T0
  const s = 1 / (1 + Math.exp(-(tSec - contact) * 14));
  return -2.2 + s * 3.4; // from behind the head (−126°) to forward-down (+69°)
}

export function buildMinimalPose(): unknown {
  const rand = rng(42);
  const tUs: number[] = [];
  const kp: number[][] = [];
  const bbox: number[][] = [];
  const flags: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = T0_US + Math.round((i * 1e6) / HZ);
    tUs.push(t);
    const pos = { ...BASE };
    const a = armAngle((t - T0_US) / 1e6);
    const [sx, sy] = BASE.rSho;
    pos.rElb = [sx + Math.sin(a) * 60, sy - Math.cos(a) * 70];
    pos.rWri = [sx + Math.sin(a) * 120, sy - Math.cos(a) * 140];
    const row: number[] = [];
    let minX = 1000, minY = 1000, maxX = 0, maxY = 0;
    for (const j of JOINT_ORDER) {
      // lEar hidden for a few frames to exercise the 0,0,0 sentinel.
      if (j === 'lEar' && i >= 40 && i < 46) {
        row.push(0, 0, 0);
        continue;
      }
      const x = Math.round(Math.min(1000, Math.max(0, pos[j][0] + (rand() - 0.5) * 4)));
      const y = Math.round(Math.min(1000, Math.max(0, pos[j][1] + (rand() - 0.5) * 4)));
      const c = 80 + Math.floor(rand() * 18);
      row.push(x, y, c);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    kp.push(row);
    const m = 20;
    const bx = Math.max(0, minX - m);
    const by = Math.max(0, minY - m);
    bbox.push([bx, by, Math.min(1000, maxX + m) - bx, Math.min(1000, maxY + m) - by]);
    flags.push(i === 60 ? 1 : 0);
  }
  return {
    schema: 'pose.v1',
    analysisId: '0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d',
    client: {
      app: '0.0.0',
      build: '0',
      os: 'synthetic',
      device: 'synthetic',
      poseApi: 'synthetic',
      algo: 'gen-minimal-fixture-1',
    },
    session: {
      sport: 'badminton',
      skill: 'bd.clear_fh',
      handedness: 'right',
      level: 'beginner',
      cameraView: 'side',
      subject: 'self',
      subjectConsent: false,
      subjectMinor: false,
      language: 'vi',
    },
    video: {
      source: 'recorded',
      durationMs: 6000,
      segment: { startMs: 1000, endMs: 5000 },
      srcFps: 30,
      analysisHz: HZ,
      display: { w: 1920, h: 1080 },
      mirrored: false,
    },
    quality: {
      framesTotal: FRAMES,
      framesWithTarget: FRAMES,
      meanLimbConf: 0.88,
      playerHeightFrac: 0.6,
      trackResets: 0,
      ambiguousAtMs: [],
    },
    track: { jointOrder: [...JOINT_ORDER], tUs, kp, bbox, flags },
  };
}

async function main(): Promise<number> {
  const pose = buildMinimalPose();
  PoseV1.parse(pose); // never write an invalid fixture
  const text = prettyJson(pose);
  const path = repoPath(OUT);
  if (Deno.args.includes('--check')) {
    let current = '';
    try {
      current = await Deno.readTextFile(path);
    } catch { /* missing file → out of sync */ }
    if (current !== text) {
      console.error(`${OUT} is out of sync (run scripts/gen-minimal-fixture.ts)`);
      return 1;
    }
    console.log(`in sync    ${OUT}`);
    return 0;
  }
  await Deno.writeTextFile(path, text);
  console.log(`wrote      ${OUT}`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
