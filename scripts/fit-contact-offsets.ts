/**
 * Fits the per-skill contact offset (DESIGN.md D7, §6.2 step 7, M4b) from coach labels.
 *
 * Reads every shared/fixtures/labels/*.csv (format in shared/fixtures/labels/README.md: `clip,frame_tUs,label`),
 * runs the signal stages and segmentation with contactOffsetMs = 0 on the matching pose fixture
 * shared/fixtures/pose/<clip>.json, matches each `contact` label to the nearest speed peak within ±250 ms, and
 * reports per skill the median (label − peak) offset, recall / precision and the residual error.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/fit-contact-offsets.ts [--check] [--json]
 * --check: exit 1 when a skill's fitted offset differs from the rubric's contactOffsetMs by more than one frame
 * (at the fastest analysis rate among that skill's clips). Passes, with a notice, when no labels exist yet.
 * The rubric is never edited here: copy the suggested value into contactOffsetMs.
 */
import { type Handedness, PoseV1 } from '@shared/contracts/index.ts';
import { hampelFilter } from '@shared/engine/hampel.ts';
import { normalizePose } from '@shared/engine/normalize.ts';
import { resampleTrack } from '@shared/engine/resample.ts';
import { smoothTrack } from '@shared/engine/savgol.ts';
import { segmentStrokes } from '@shared/engine/segment.ts';
import { applyMirrorSwap, fixLimbSwaps } from '@shared/engine/swapfix.ts';
import type { AnalysisHz } from '@shared/engine/types.ts';
import { allRubricSkills, loadRubric } from '@shared/rubric/load.ts';
import { repoPath } from './_lib/json.ts';

export const MATCH_WINDOW_US = 250_000;
export const LABEL_DIR = 'shared/fixtures/labels/';

export interface LabelRow {
  file: string;
  line: number;
  clip: string;
  frameTUs: number;
  label: string;
}

/** Parses one labels CSV (header `clip,frame_tUs,label`; `#` comments and blank lines ignored). */
export function parseLabelsCsv(text: string, file = '<csv>'): LabelRow[] {
  const rows: LabelRow[] = [];
  const lines = text.split(/\r?\n/);
  let header = false;
  lines.forEach((raw, k) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(',').map((c) => c.trim());
    if (!header) {
      if (cells.join(',') !== 'clip,frame_tUs,label') {
        throw new Error(`${file}:${k + 1}: header must be clip,frame_tUs,label`);
      }
      header = true;
      return;
    }
    if (cells.length !== 3) throw new Error(`${file}:${k + 1}: expected 3 columns`);
    const frameTUs = Number(cells[1]);
    if (!Number.isInteger(frameTUs) || frameTUs < 0) {
      throw new Error(`${file}:${k + 1}: frame_tUs must be an integer µs`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(cells[0])) throw new Error(`${file}:${k + 1}: bad clip name`);
    rows.push({ file, line: k + 1, clip: cells[0], frameTUs, label: cells[2] });
  });
  return rows;
}

export interface SkillFit {
  skill: string;
  clips: number;
  labels: number;
  matched: number;
  strokes: number;
  /** Median (label − speed peak) in ms; null without matches. */
  offsetMs: number | null;
  rubricOffsetMs: number;
  /** Median |label − (peak + fitted offset)| in ms. */
  residualMs: number | null;
  /** One frame at the fastest analysis rate among the clips (ms). */
  frameMs: number;
  recall: number;
  precision: number;
}

function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const a = [...v].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Speed-peak times (µs) of a pose with the rubric's segmentation parameters and no contact offset. */
export function peakTimes(pose: PoseV1, handedness: Handedness = pose.session.handedness): number[] {
  const skill = loadRubric(pose.session.sport).skills.find((s) => s.id === pose.session.skill);
  if (!skill) throw new Error(`skill ${pose.session.skill} is not in the rubric`);
  const raw = hampelFilter(fixLimbSwaps(applyMirrorSwap(normalizePose(pose))).track).track;
  const track = smoothTrack(resampleTrack(raw, pose.video.analysisHz as AnalysisHz));
  const seg = segmentStrokes(track, handedness, { vmin: skill.vmin, nms: skill.nms, contactOffsetMs: 0 });
  return seg.ok ? seg.strokes.map((s) => s.tPeakUs) : [];
}

/** Fits offsets for every skill that has labels. `loadPose(clip)` returns the parsed pose fixture. */
export async function fitOffsets(rows: LabelRow[], loadPose: (clip: string) => Promise<PoseV1>): Promise<SkillFit[]> {
  const byClip = new Map<string, number[]>();
  for (const r of rows) {
    if (r.label !== 'contact') continue;
    byClip.set(r.clip, [...(byClip.get(r.clip) ?? []), r.frameTUs]);
  }
  const acc = new Map<string, { clips: number; labels: number; strokes: number; diffs: number[]; hz: number }>();
  const skills = allRubricSkills();
  for (const [clip, labels] of byClip) {
    const pose = await loadPose(clip);
    if (!skills.has(pose.session.skill)) throw new Error(`${clip}: unknown skill ${pose.session.skill}`);
    const sampled = new Set(pose.track.tUs);
    for (const t of labels) {
      if (!sampled.has(t)) console.warn(`warning: ${clip}: label ${t} µs is not a sampled frame PTS`);
    }
    const peaks = peakTimes(pose);
    const a = acc.get(pose.session.skill) ?? { clips: 0, labels: 0, strokes: 0, diffs: [], hz: 30 };
    a.clips++;
    a.labels += labels.length;
    a.strokes += peaks.length;
    a.hz = Math.max(a.hz, pose.video.analysisHz);
    // Greedy one-to-one matching, closest pairs first.
    const pairs = labels.flatMap((l) => peaks.map((p) => ({ l, p, d: Math.abs(l - p) })))
      .filter((x) => x.d <= MATCH_WINDOW_US)
      .sort((x, y) => x.d - y.d);
    const usedL = new Set<number>(), usedP = new Set<number>();
    for (const x of pairs) {
      if (usedL.has(x.l) || usedP.has(x.p)) continue;
      usedL.add(x.l);
      usedP.add(x.p);
      a.diffs.push((x.l - x.p) / 1000);
    }
    acc.set(pose.session.skill, a);
  }
  return [...acc.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([skill, a]) => {
    const def = loadRubric(skill.startsWith('bd.') ? 'badminton' : 'pickleball').skills.find((s) => s.id === skill)!;
    const offset = median(a.diffs);
    const residual = offset === null ? null : median(a.diffs.map((d) => Math.abs(d - offset)));
    return {
      skill,
      clips: a.clips,
      labels: a.labels,
      matched: a.diffs.length,
      strokes: a.strokes,
      offsetMs: offset === null ? null : Math.round(offset * 10) / 10,
      rubricOffsetMs: def.contactOffsetMs,
      residualMs: residual === null ? null : Math.round(residual * 10) / 10,
      frameMs: 1000 / a.hz,
      recall: a.labels ? a.diffs.length / a.labels : 0,
      precision: a.strokes ? a.diffs.length / a.strokes : 0,
    };
  });
}

/** --check verdict: the rubric offset is within one frame of the fit. */
export function checkFit(f: SkillFit): boolean {
  return f.offsetMs !== null && Math.abs(f.offsetMs - f.rubricOffsetMs) <= f.frameMs + 1e-9;
}

async function readLabelRows(): Promise<LabelRow[]> {
  const rows: LabelRow[] = [];
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(repoPath(LABEL_DIR))];
  } catch { /* no directory: no labels */ }
  for (
    const e of entries.filter((x) => x.isFile && x.name.endsWith('.csv')).sort((a, b) => (a.name < b.name ? -1 : 1))
  ) {
    rows.push(...parseLabelsCsv(await Deno.readTextFile(repoPath(LABEL_DIR + e.name)), e.name));
  }
  return rows;
}

async function main(): Promise<number> {
  const check = Deno.args.includes('--check');
  const rows = await readLabelRows();
  if (rows.filter((r) => r.label === 'contact').length === 0) {
    console.log(`notice: no contact labels in ${LABEL_DIR}*.csv yet (M3/M4b); nothing to fit, check passes trivially`);
    return 0;
  }
  const fits = await fitOffsets(
    rows,
    async (clip) => PoseV1.parse(JSON.parse(await Deno.readTextFile(repoPath(`shared/fixtures/pose/${clip}.json`)))),
  );
  if (Deno.args.includes('--json')) console.log(JSON.stringify(fits, null, 2));
  let failed = 0;
  for (const f of fits) {
    const ok = checkFit(f);
    if (!ok) failed++;
    console.log(
      `${f.skill.padEnd(14)} clips ${f.clips}  labels ${f.labels}  matched ${f.matched}  recall ${
        (f.recall * 100).toFixed(0)
      }%  precision ${(f.precision * 100).toFixed(0)}%  fitted ${
        f.offsetMs ?? '—'
      } ms  rubric ${f.rubricOffsetMs} ms  residual ${f.residualMs ?? '—'} ms  ${
        check ? (ok ? 'OK' : `MISMATCH (> 1 frame = ${f.frameMs.toFixed(1)} ms)`) : ''
      }`,
    );
  }
  return check && failed ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());
