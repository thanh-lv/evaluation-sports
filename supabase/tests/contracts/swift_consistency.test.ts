/**
 * The CoachCore Swift enums mirror the TS contract enums (wire raw values). The Swift side is parsed as text, so this
 * runs on Linux without a Swift toolchain; Codable key names are covered by the CoachCore fixture round-trip tests.
 */
import { assert, assertEquals } from '@std/assert';
import {
  ANALYSIS_KINDS,
  ANALYSIS_STATUSES,
  API_ERROR_CODES,
  API_ERROR_STATUS,
  CAMERA_VIEWS,
  CONFIDENCE,
  CONFIRMED_CAMERA_VIEWS,
  FRAME_IDS,
  FRAME_MODES,
  FRAME_PHASES,
  HANDEDNESS,
  LANGUAGES,
  LEVELS,
  PREPARE_WARNINGS,
  RESULT_REJECTION_CODES,
  SAFETY_KINDS,
  SEVERITY,
  SPORTS,
  STROKE_PHASES,
  SUB_SCORE_KEYS,
  SUBJECTS,
  TIERS,
  TIP_KEYS,
  VIEW_CODES,
} from '@shared/contracts/index.ts';
import { ASSESS_TAGS } from '@shared/rubric/types.ts';

const SRC = new URL('../../../ios/Packages/CoachCore/Sources/CoachCore/', import.meta.url);
const swift = (path: string) => Deno.readTextFileSync(new URL(path, SRC));
const ENUMS = swift('Model/ContractEnums.swift');
const API = swift('Payload/ApiV1.swift');
const RESULT = swift('Payload/CoachResultV1.swift');
const PREPARE = swift('Payload/PrepareResponseV1.swift');

/** `[case name, raw value]` pairs of `enum <name>: String …` in declaration order. */
function swiftEnum(source: string, name: string): Array<[string, string]> {
  const start = source.search(new RegExp(`enum ${name}: String\\b`));
  assert(start >= 0, `Swift enum ${name} not found`);
  const body = source.slice(source.indexOf('{', start) + 1);
  const out: Array<[string, string]> = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t === '}' || /^(public |static |func |var |init)/.test(t)) break;
    if (!t.startsWith('case ')) continue;
    for (const part of t.slice(5).split(',')) {
      const m = part.trim().match(/^`?(\w+)`?(?:\s*=\s*"([^"]*)")?$/);
      assert(m, `${name}: cannot parse "${part}"`);
      out.push([m[1], m[2] ?? m[1]]);
    }
  }
  return out;
}

const raw = (source: string, name: string) => swiftEnum(source, name).map(([, v]) => v);

Deno.test('CoachCore enums carry the same wire values as the TS contracts', () => {
  const cases: Array<[string, string, readonly string[]]> = [
    [ENUMS, 'Sport', SPORTS],
    [ENUMS, 'Handedness', HANDEDNESS],
    [ENUMS, 'Level', LEVELS],
    [ENUMS, 'CameraView', CAMERA_VIEWS],
    [ENUMS, 'ConfirmedCameraView', CONFIRMED_CAMERA_VIEWS],
    [ENUMS, 'ViewCode', VIEW_CODES],
    [ENUMS, 'Language', LANGUAGES],
    [ENUMS, 'Subject', SUBJECTS],
    [ENUMS, 'FrameMode', FRAME_MODES],
    [ENUMS, 'Tier', TIERS],
    [ENUMS, 'AnalysisKind', ANALYSIS_KINDS],
    [ENUMS, 'AnalysisStatus', ANALYSIS_STATUSES],
    [ENUMS, 'SubScoreKey', SUB_SCORE_KEYS],
    [ENUMS, 'StrokePhase', STROKE_PHASES],
    [ENUMS, 'FramePhase', FRAME_PHASES],
    [ENUMS, 'FrameId', FRAME_IDS],
    [ENUMS, 'StrokeRole', ['best', 'worst']],
    [ENUMS, 'Severity', SEVERITY],
    [ENUMS, 'Confidence', CONFIDENCE],
    [ENUMS, 'SafetyKind', SAFETY_KINDS],
    [ENUMS, 'AssessTag', ASSESS_TAGS],
    [ENUMS, 'TipKey', TIP_KEYS],
    [API, 'ApiErrorCode', API_ERROR_CODES],
    [RESULT, 'RejectionCode', RESULT_REJECTION_CODES],
  ];
  for (const [source, name, expected] of cases) {
    assertEquals([...raw(source, name)].sort(), [...expected].sort(), `Swift ${name}`);
  }
});

Deno.test('CoachCore ApiErrorCode.httpStatus matches API_ERROR_STATUS', () => {
  const byCase = new Map(swiftEnum(API, 'ApiErrorCode'));
  const body = API.slice(API.indexOf('var httpStatus'));
  const status = new Map<string, number>();
  for (const m of body.matchAll(/case ([^:]+):\s*return (\d+)/g)) {
    for (const c of m[1].split(',')) {
      const caseName = c.trim().replace(/^\./, '').replace(/`/g, '');
      const wire = byCase.get(caseName);
      assert(wire, `httpStatus: unknown case ${caseName}`);
      status.set(wire, Number(m[2]));
    }
  }
  assertEquals(Object.fromEntries([...status].sort()), Object.fromEntries(Object.entries(API_ERROR_STATUS).sort()));
});

Deno.test('CoachCore PrepareWarning constants cover PREPARE_WARNINGS', () => {
  const known = [...PREPARE.matchAll(/static let \w+ = PrepareWarning\(rawValue: "([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals(known.sort(), [...PREPARE_WARNINGS].sort());
});
