/**
 * `coach.v1` output schema per sport (DESIGN.md §7.4), built once per isolate from the bundled rubric. The schema
 * is part of the cached grammar, so it must be byte-stable: it depends only on the rubric (all skills, enabled or
 * not) and never on tier, user or language.
 */
import {
  buildCoachOutputSchema,
  type CoachSchemaCatalog,
  coachSchemaCatalogFromRubric,
  type JsonSchema,
  type Sport,
} from '../contracts/index.ts';
import { loadRubric } from '../rubric/load.ts';

const catalogs = new Map<Sport, CoachSchemaCatalog>();
const schemas = new Map<Sport, JsonSchema>();

export function coachSchemaCatalog(sport: Sport): CoachSchemaCatalog {
  let c = catalogs.get(sport);
  if (!c) {
    c = coachSchemaCatalogFromRubric(loadRubric(sport));
    catalogs.set(sport, c);
  }
  return c;
}

/** The JSON Schema sent as `output_config.format.schema`. Treat as read-only (shared across requests). */
export function coachOutputSchema(sport: Sport): JsonSchema {
  let s = schemas.get(sport);
  if (!s) {
    s = buildCoachOutputSchema(coachSchemaCatalog(sport));
    schemas.set(sport, s);
  }
  return s;
}
