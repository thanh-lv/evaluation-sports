/**
 * Public API of the analysis engine (DESIGN.md §6.2, §6.4). Handlers and the Claude module import from here;
 * the signal-stage modules stay importable directly for tests and tools.
 */
export {
  cleanTrackPath,
  collectWarnings,
  prepare,
  PREPARE_GATES,
  reprepare,
  visualToJudge,
  withQuota,
} from './prepare.ts';
export type {
  PrepareOptions,
  PrepareOutcome,
  PrepareRejection,
  PrepareResponseCore,
  PrepareSuccess,
} from './prepare.ts';
export * from './prepared_state.ts';
export {
  aggregateStrokes,
  checkpointConfidence,
  composeScores,
  displayScore,
  levelFor,
  previewSubScores,
  readingOf,
  SCORE_CONSTANTS,
  scoreMetric,
  VISUAL_CONFIDENCE,
} from './score.ts';
export type {
  ComposedCheckpoint,
  ComposedOverall,
  ComposedScores,
  ComposedSubScore,
  VisualJudgmentInput,
} from './score.ts';
export { buildCandidates, CANDIDATE_CONSTANTS, faultFor } from './candidates.ts';
export { evaluateCheckpoints, formatValue, MIN_STROKE_QUALITY, mirrorJoints, targetText } from './checkpoints.ts';
export { buildMetricContext, evaluateMetric, METRIC_CONSTANTS } from './metrics.ts';
export type { MetricContext, MetricValue } from './metrics.ts';
export { rankStrokes, strokeQuality, strokeScores } from './rank.ts';
export { planFrames, RACKET_LENGTH_T, snapCrop, strokeCrop } from './frameplan.ts';
export { guessView, VIEW_CONSTANTS } from './viewcheck.ts';
export type { ViewGuess } from './viewcheck.ts';
export { exportCleanTrack } from './clean_track_export.ts';
export { METRIC_CATALOG, METRIC_KEYS } from './metric_catalog.ts';
export type { MetricKey } from './metric_catalog.ts';
export { EngineRejection } from './types.ts';
