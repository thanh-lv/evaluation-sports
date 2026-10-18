import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  auditCoachOutputSchema,
  buildCoachOutputSchema,
  CoachOutputV1,
  type CoachSchemaCatalog,
  coachSchemaCatalogFromRubric,
  type JsonSchema,
} from '@shared/contracts/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';

const catalog: CoachSchemaCatalog = {
  sport: 'badminton',
  checkpointIds: ['bd.clear_fh.C1', 'bd.clear_fh.C3', 'bd.ready.R7'],
  visualCheckpointIds: ['bd.ready.R7'],
  faultIds: ['bd.clear_fh.low_elbow'],
};

Deno.test('built schemas pass the audit for both sports', () => {
  for (const sport of ['badminton', 'pickleball'] as const) {
    const schema = buildCoachOutputSchema(coachSchemaCatalogFromRubric(loadRubric(sport)));
    assertEquals(auditCoachOutputSchema(schema), []);
  }
  assertEquals(auditCoachOutputSchema(buildCoachOutputSchema(catalog)), []);
});

Deno.test('enums are defined once in $defs; FaultId includes none', () => {
  const s = buildCoachOutputSchema(catalog);
  assertEquals(s.$defs?.FaultId.enum, ['bd.clear_fh.low_elbow', 'none']);
  assertEquals(s.$defs?.FrameId.enum, ['F1', 'F2', 'F3', 'F4', 'F5']);
  // Evidence: the only numeric field the model writes is stroke_id (DESIGN.md §7.4).
  const ev = s.$defs!.Evidence;
  assertEquals(ev.required, ['stroke_id', 'frame_id', 'metric_key', 'observation']);
  const numeric = Object.entries(ev.properties!).filter(([, p]) => p.type === 'integer' || p.type === 'number');
  assertEquals(numeric.map(([k]) => k), ['stroke_id']);
  assertEquals(s.required, [
    'schema_version',
    'language',
    'input_check',
    'visual_checkpoints',
    'summary',
    'strengths',
    'weaknesses',
    'improvements',
    'safety_notes',
    'not_assessable',
    'recording_tips',
  ]);
  assert(!('stroke_notes' in (s.properties ?? {})));
  const enumCount = JSON.stringify(s).split('"enum"').length - 1;
  assertEquals(enumCount, Object.values(s.$defs ?? {}).filter((d) => d.enum).length);
});

Deno.test('builder is deterministic and validates its catalog', () => {
  assertEquals(JSON.stringify(buildCoachOutputSchema(catalog)), JSON.stringify(buildCoachOutputSchema(catalog)));
  assertThrows(() => buildCoachOutputSchema({ ...catalog, visualCheckpointIds: [] }));
  assertThrows(() => buildCoachOutputSchema({ ...catalog, faultIds: ['x', 'x'] }));
  assertThrows(() => buildCoachOutputSchema({ ...catalog, visualCheckpointIds: ['bd.unknown'] }));
});

function withMutation(mutate: (s: JsonSchema) => void): string[] {
  const s = structuredClone(buildCoachOutputSchema(catalog));
  mutate(s);
  return auditCoachOutputSchema(s);
}

Deno.test('audit catches every forbidden construct', () => {
  const defs = (s: JsonSchema) => s.$defs!;
  const cases: Array<[string, (s: JsonSchema) => void, string]> = [
    ['minimum', (s) => (defs(s).VisualJudgment.properties!.level.minimum = -1), 'forbidden keyword "minimum"'],
    ['maximum', (s) => (defs(s).VisualJudgment.properties!.level.maximum = 4), 'forbidden keyword "maximum"'],
    ['exclusiveMinimum', (s) => (defs(s).Improvement.properties!.priority.exclusiveMinimum = 0), 'exclusiveMinimum'],
    ['minLength', (s) => (s.properties!.summary.minLength = 1), 'forbidden keyword "minLength"'],
    ['maxLength', (s) => (s.properties!.summary.maxLength = 500), 'forbidden keyword "maxLength"'],
    ['maxItems', (s) => (s.properties!.strengths.maxItems = 3), 'forbidden keyword "maxItems"'],
    ['minItems>1', (s) => (s.properties!.strengths.minItems = 2), 'minItems > 1'],
    ['pattern', (s) => (defs(s).Evidence.properties!.frame_id.pattern = '^F[1-5]$'), 'forbidden keyword "pattern"'],
    ['format', (s) => (s.properties!.summary.format = 'date-time'), 'forbidden keyword "format"'],
    ['nested $schema', (s) => (defs(s).Evidence.$schema = 'x'), 'nested "$schema"'],
    ['additionalProperties', (s) => (defs(s).Strength.additionalProperties = true), 'additionalProperties'],
    ['missing required', (s) => defs(s).Weakness.required!.pop(), 'not required'],
    ['inline enum', (s) => (s.properties!.language = { type: 'string', enum: ['vi', 'en'] }), 'enum outside $defs'],
    ['recursion', (s) => (defs(s).Evidence.properties!.child = { $ref: '#/$defs/Strength' }), 'recursive $ref'],
    [
      'self recursion',
      (s) => (defs(s).Strength.properties!.evidence.items = { $ref: '#/$defs/Strength' }),
      'recursive',
    ],
    [
      'enum inside anyOf',
      (s) => (defs(s).Evidence.properties!.frame_id = { anyOf: [{ type: 'string', enum: ['F1'] }] }),
      'enum outside $defs',
    ],
    ['duplicated per-sport enum', (s) => (defs(s).Weakness.properties!.checkpoint_id = {
      type: 'string',
      enum: defs(s).CheckpointId.enum,
    }), 'enum outside $defs'],
    ['const', (s) => (s.properties!.schema_version = { type: 'string', const: 'coach.v1' }), '"const"'],
    ['oneOf', (s) => (s.properties!.summary = { oneOf: [{ type: 'string' }] }), 'forbidden keyword "oneOf"'],
    ['uniqueItems', (s) => (s.properties!.recording_tips.uniqueItems = true), 'forbidden keyword "uniqueItems"'],
    ['dangling $ref', (s) => (s.properties!.summary = { $ref: '#/$defs/Nope' }), 'dangling $ref'],
    ['external $ref', (s) => (s.properties!.summary = { $ref: 'https://x/y.json' }), 'unsupported $ref'],
    ['nested $defs', (s) => (defs(s).Evidence.$defs = {}), 'nested $defs'],
    ['root not object', (s) => (s.type = 'array'), 'root must be type "object"'],
  ];
  for (const [name, mutate, expected] of cases) {
    const problems = withMutation(mutate);
    assert(problems.some((p) => p.includes(expected)), `${name}: ${problems.join(' | ') || 'no problems'}`);
  }
});

Deno.test('lenient output parser accepts any casing; strips unknown keys', () => {
  const out = {
    schema_version: 'coach.v1',
    language: 'VI',
    input_check: {
      is_assessable: true,
      sport_matches: true,
      skill_matches: true,
      subject_visibility: 'Good',
      issues: [],
      note: '',
    },
    visual_checkpoints: [{ checkpoint_id: 'BD.READY.R7', level: 3, confidence: 'HIGH', frame_ids: ['F1'], note: '' }],
    summary: 'Tốt.',
    strengths: [],
    weaknesses: [{
      checkpoint_id: 'bd.clear_fh.C3',
      fault_id: 'Bd.Clear_fh.Low_Elbow',
      severity: 'High',
      title: 't',
      detail: 'd',
      why_it_matters: 'w',
      evidence: [{ stroke_id: 2, frame_id: 'F2', metric_key: '', observation: 'o' }],
    }],
    improvements: [],
    safety_notes: [],
    not_assessable: [],
    recording_tips: [],
    stroke_notes: [],
  };
  const r = CoachOutputV1.safeParse(out);
  assert(r.success);
  assert(!('stroke_notes' in r.data));
});
