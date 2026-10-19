/**
 * Request layout (DESIGN.md §8.2):
 *   system  = [BASE_SYSTEM_V2, RUBRIC_TEXT[sport] + cache_control]   (one cached prefix per model × sport)
 *   user    = [F1..F5: label text + base64 JPEG (none in pose_only)] + userText (last line "Output language: …")
 *   output_config = {effort, format: json_schema coach.v1[sport]}
 * Request rules (§8.1): no sampling parameters, no `thinking` (adaptive default), no prefill, no tool_choice;
 * `fallbacks: "default"` + its beta only when the route asks for it and the model supports it (never Haiku 5.5).
 */
import { type Language, UPLOAD_FRAME_IDS, type UploadFrameId } from '../contracts/common.ts';
import type { PreparedAnalysisV1 } from '../engine/prepared_state.ts';
import type { RubricBundle } from '../rubric/types.ts';
import type { CoachRequestParams } from './client.ts';
import { BASE_SYSTEM_V2 } from './prompts/base_system.ts';
import { rubricText } from './prompts/rubric_text.ts';
import { buildUserText, frameLabel } from './prompts/user_text.ts';
import { coachOutputSchema } from './schema_per_sport.ts';
import { FALLBACK_BETA, type FrameImage, type ModelRoute } from './types.ts';

export interface CoachRequestInput {
  prepared: PreparedAnalysisV1;
  rubric: RubricBundle;
  /** Narrative language (`analyses.language`). */
  language: Language;
  route: ModelRoute;
  /** Uploaded frames that exist in Storage; ignored in pose_only mode. */
  frames: readonly FrameImage[];
  /** `analyses.max_tokens_mult` (1.5 after a max_tokens stop). */
  maxTokensMult?: number;
}

export interface BuiltCoachRequest {
  params: CoachRequestParams;
  /** Frame ids actually attached, in order (postprocess drops any other frame id). */
  sentFrameIds: UploadFrameId[];
}

/**
 * Models documented to accept `fallbacks: "default"` (claude-api skill). Anything else (Haiku 5.5, Sonnet 5, a model
 * id typed into `model_routes`) gets neither the parameter nor its beta: an allowlist, so a new id fails closed.
 */
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
]);

export function supportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model);
}

/** The two system blocks; identical for every request of a sport (cache prefix). */
export function systemBlocks(sport: PreparedAnalysisV1['sport']): CoachRequestParams['system'] {
  return [
    { type: 'text', text: BASE_SYSTEM_V2 },
    { type: 'text', text: rubricText(sport), cache_control: { type: 'ephemeral' } },
  ];
}

export function buildCoachRequest(input: CoachRequestInput): BuiltCoachRequest {
  const { prepared: p, route } = input;
  const mult = input.maxTokensMult && input.maxTokensMult > 0 ? input.maxTokensMult : 1;

  const content: Exclude<CoachRequestParams['messages'][number]['content'], string> = [];
  const sentFrameIds: UploadFrameId[] = [];
  if (p.frameMode === 'frames') {
    const images = new Map(input.frames.map((f) => [f.frameId, f]));
    const roles = new Map(p.strokes.map((s) => [s.id, s.role]));
    for (const id of UPLOAD_FRAME_IDS) {
      const req = p.frameRequests.find((r) => r.frameId === id && r.upload);
      const img = images.get(id);
      if (!req || !img) continue;
      content.push({ type: 'text', text: frameLabel(req, (sid) => roles.get(sid) ?? null) });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.jpegBase64 } });
      sentFrameIds.push(id);
    }
  }
  content.push({ type: 'text', text: buildUserText(p, input.rubric, input.language, new Set(sentFrameIds)) });

  const params: CoachRequestParams = {
    model: route.model,
    max_tokens: Math.round(route.maxTokens * mult),
    system: systemBlocks(p.sport),
    messages: [{ role: 'user', content }],
    output_config: { effort: route.effort, format: { type: 'json_schema', schema: coachOutputSchema(p.sport) } },
  };
  const fallback = route.fallbacks === 'default' && supportsServerFallback(route.model);
  const betas = route.betas.filter((b) => b !== FALLBACK_BETA || fallback);
  if (fallback && !betas.includes(FALLBACK_BETA)) betas.push(FALLBACK_BETA);
  if (betas.length) params.betas = betas;
  if (fallback) params.fallbacks = 'default';
  return { params, sentFrameIds };
}
