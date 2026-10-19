/**
 * CLAUDE_MODE=mock: a deterministic coach.v1 output built from PreparedAnalysisV1 (candidates + visualToJudge) with
 * natural VI / EN text from the catalog, served through the same `CoachModelClient` → runOnce → postprocess →
 * compose path as the live model. Used locally, in e2e tests and by scripts/replay.ts --mock. No network, no cost.
 */
import { APIError } from '@anthropic-ai/sdk';
import {
  BEST_FRAME_BY_PHASE,
  COACH_SCHEMA_VERSION,
  type CoachOutputV1,
  type Language,
  type LocalizedText,
  NO_FAULT,
  OVERVIEW_FRAME_ID,
  type UploadFrameId,
} from '../contracts/index.ts';
import type { PreparedAnalysisV1 } from '../engine/prepared_state.ts';
import type { CheckpointDef, RubricBundle } from '../rubric/types.ts';
import type { CoachModelClient } from './client.ts';
import { fakeMessage } from './fake_message.ts';
import { sentence } from './text_clean.ts';

export interface MockSource {
  prepared: PreparedAnalysisV1;
  rubric: RubricBundle;
  language: Language;
  sentFrameIds: readonly UploadFrameId[];
}

const T = {
  keep: { vi: 'Hãy giữ thói quen này.', en: 'Keep it up.' },
  most: { vi: 'Ở phần lớn các cú đánh,', en: 'In most of your strokes,' },
  likely: { vi: 'Có thể', en: 'Likely,' },
  bestStroke: { vi: 'Ở cú đánh tốt nhất,', en: 'In your best stroke,' },
  evenBest: { vi: 'Ngay cả ở cú đánh tốt nhất,', en: 'Even in your best stroke,' },
  practise: {
    vi: 'Tập chậm trước để cảm nhận động tác, rồi tăng dần tốc độ.',
    en: 'Practise it slowly first to feel the movement, then build up speed.',
  },
  visualNote: { vi: 'Ước lượng từ khung hình.', en: 'Estimated from the frames.' },
  notVisible: { vi: 'Không thấy rõ trong khung hình.', en: 'Not clearly visible in the frames.' },
  warmup: {
    vi: 'Khởi động vai, cổ tay và gối vài phút trước khi tập.',
    en: 'Warm up your shoulders, wrists and knees for a few minutes before practice.',
  },
  capture: {
    vi: 'Quay gần hơn, đủ sáng và giữ điện thoại cố định.',
    en: 'Film closer, in good light, with the phone held steady.',
  },
  tipSteady: {
    vi: 'Đặt điện thoại cố định ngang hông và quay toàn thân.',
    en: 'Fix the phone at hip height and keep your whole body in the frame.',
  },
  tipReps: {
    vi: 'Quay nhiều cú đánh liên tiếp cùng một kỹ thuật.',
    en: 'Film several strokes of the same skill in a row.',
  },
  tipView: {
    vi: 'Thử quay từ góc được gợi ý cho kỹ thuật này.',
    en: 'Try filming from the angle recommended for this skill.',
  },
  tipFps: {
    vi: 'Bật chế độ quay nhiều khung hình mỗi giây nếu máy hỗ trợ.',
    en: 'Turn on a high frame rate if your phone supports it.',
  },
} as const satisfies Record<string, LocalizedText>;

function lower(text: string): string {
  return text ? text[0].toLocaleLowerCase('vi') + text.slice(1) : text;
}

function summaryOf(lang: Language, strength: string | null, weakness: string | null, partial: boolean): string {
  const parts: string[] = [];
  if (lang === 'vi') {
    parts.push(strength ? `Bạn đã làm tốt phần ${lower(strength)}.` : 'Cảm ơn bạn đã gửi video luyện tập.');
    parts.push(weakness ? `Điều nên sửa trước tiên: ${lower(weakness)}.` : 'Động tác của bạn khá ổn định.');
    parts.push(
      partial
        ? 'Video chưa cho thấy đủ chi tiết, hãy quay thêm vài cú đánh rõ hơn.'
        : 'Mỗi buổi tập trung vào một điểm và quay lại video sau vài buổi.',
    );
  } else {
    parts.push(strength ? `Nice work on ${lower(strength)}.` : 'Thanks for sending your practice clip.');
    parts.push(weakness ? `The first thing to fix: ${lower(weakness)}.` : 'Your stroke looks fairly consistent.');
    parts.push(
      partial
        ? 'The clip does not show enough detail yet, so film a few clearer strokes.'
        : 'Work on one point per session and film again after a few sessions.',
    );
  }
  return parts.join(' ');
}

/** Deterministic coach.v1 output for a prepared analysis (passes postprocess unchanged). */
export function mockCoachOutput(src: MockSource): CoachOutputV1 {
  const { prepared: p, rubric, language: lang } = src;
  const t = (x: LocalizedText) => x[lang];
  const defs = new Map(rubric.checkpoints.map((c) => [c.id, c]));
  const faults = new Map(rubric.faults.map((f) => [f.id, f]));
  const sent = new Set(src.sentFrameIds);
  const noFrames = p.frameMode === 'pose_only' || sent.size === 0;
  const best = p.strokes.find((s) => s.role === 'best' && !s.excluded) ?? p.strokes.find((s) => !s.excluded)!;
  const frameFor = (def: CheckpointDef | undefined): string => {
    if (!def) return '';
    const phase = def.phase === 'contact+0.2' || def.phase === 'recovery'
      ? 'ftStop'
      : def.phase === 'window'
      ? null
      : def.phase;
    const id = phase ? BEST_FRAME_BY_PHASE[phase] : OVERVIEW_FRAME_ID;
    return sent.has(id) ? id : '';
  };
  const evidence = (id: string, observation: string) => [{
    stroke_id: best.id,
    frame_id: frameFor(defs.get(id)),
    metric_key: id,
    observation,
  }];

  const preview = new Map(p.subScoresPreview.map((s) => [s.key, s.score]));
  const visual = p.visualToJudge.map((v) => {
    const frames = v.frameIds.filter((f) => sent.has(f));
    if (noFrames || !frames.length) {
      return { checkpoint_id: v.checkpointId, level: -1, confidence: 'low', frame_ids: [], note: t(T.notVisible) };
    }
    const sub = defs.get(v.checkpointId)?.subscore;
    const score = (sub && preview.get(sub)) ?? 50;
    const level = Math.max(0, Math.min(4, Math.round(score / 25)));
    return { checkpoint_id: v.checkpointId, level, confidence: 'medium', frame_ids: frames, note: t(T.visualNote) };
  });

  const strengths = p.candidates.strengths.slice(0, 2).map((s) => {
    const def = defs.get(s.checkpointId)!;
    const obs = `${t(T.bestStroke)} ${lower(t(s.plain))}.`;
    const detail = `${sentence(t(s.plain))} ${t(T.keep)}`;
    return { checkpoint_id: s.checkpointId, title: t(def.name), detail, evidence: evidence(s.checkpointId, obs) };
  });
  if (!strengths.length) {
    const v = visual.find((x) => x.level >= 3);
    const def = v && defs.get(v.checkpoint_id);
    if (v && def) {
      const obs = `${t(T.bestStroke)} ${lower(def.plain[lang].ok)}.`;
      strengths.push({
        checkpoint_id: v.checkpoint_id,
        title: t(def.name),
        detail: obs,
        evidence: [{ stroke_id: best.id, frame_id: v.frame_ids[0], metric_key: '', observation: obs }],
      });
    }
  }

  const weakSources = p.candidates.weaknesses.slice(0, 2).map((w) => ({
    id: w.checkpointId,
    faultId: w.faultId,
    plain: t(w.plain),
    c: w.c,
    frame: '',
  }));
  if (!weakSources.length) {
    const v = visual.find((x) => x.level >= 0 && x.level <= 1);
    const def = v && defs.get(v.checkpoint_id);
    if (v && def) {
      const fault = rubric.faults.find((f) =>
        f.checkpoint === v.checkpoint_id && (f.when === 'low' || f.when === 'false')
      );
      weakSources.push({
        id: v.checkpoint_id,
        faultId: fault?.id ?? null,
        plain: def.plain[lang].low,
        c: 0.7,
        frame: v.frame_ids[0],
      });
    }
  }
  const weaknesses = weakSources.map((w, i) => {
    const fault = w.faultId ? faults.get(w.faultId) : undefined;
    const def = defs.get(w.id)!;
    const obs = `${t(w.c < 0.5 ? T.likely : T.evenBest)} ${lower(w.plain)}.`;
    return {
      checkpoint_id: w.id,
      fault_id: w.faultId ?? NO_FAULT,
      severity: i === 0 ? 'high' : 'medium',
      title: t(fault?.title ?? def.name),
      detail: `${t(T.most)} ${lower(w.plain)}.`,
      why_it_matters: fault ? t(fault.why) : sentence(t({ vi: def.plain.vi.ok, en: def.plain.en.ok })),
      evidence: w.frame
        ? [{ stroke_id: best.id, frame_id: w.frame, metric_key: '', observation: obs }]
        : evidence(w.id, obs),
    };
  });
  const improvements = weaknesses.map((w, i) => {
    const fault = w.fault_id !== NO_FAULT ? faults.get(w.fault_id) : undefined;
    const def = defs.get(w.checkpoint_id)!;
    const cue = fault ? t(fault.cue) : sentence(def.plain[lang].ok);
    return {
      priority: i + 1,
      fault_id: w.fault_id,
      title: cue,
      how_to_fix: `${sentence(cue)} ${t(T.practise)}`,
      cues: [cue],
      drill_ids: fault ? [fault.defaultDrill] : [],
      goal: sentence(def.plain[lang].ok),
    };
  });

  const naRows = p.checkpointTable.filter((r) => r.status === 'not_assessable').slice(0, 2);
  const tips = [t(T.tipSteady)];
  if (p.warnings.includes('view_not_recommended') || p.warnings.includes('view_mismatch')) tips.push(t(T.tipView));
  if (p.warnings.includes('fps_low')) tips.push(t(T.tipFps));
  if (p.warnings.includes('few_strokes')) tips.push(t(T.tipReps));
  const issues: string[] = [];
  if (p.warnings.includes('player_small')) issues.push('too_far');
  if (p.warnings.includes('view_not_recommended')) issues.push('camera_angle_limits');

  return {
    schema_version: COACH_SCHEMA_VERSION,
    language: lang,
    input_check: {
      is_assessable: true,
      sport_matches: true,
      skill_matches: true,
      subject_visibility: p.inputQuality.meanLimbConf >= 0.7 ? 'good' : 'partial',
      issues,
      note: '',
    },
    visual_checkpoints: visual,
    summary: summaryOf(lang, strengths[0]?.title ?? null, weaknesses[0]?.title ?? null, p.coverage < 0.5),
    strengths,
    weaknesses,
    improvements,
    safety_notes: [{ kind: 'warmup', message: t(T.warmup) }],
    not_assessable: naRows.map((r) => ({ aspect: t(defs.get(r.id)!.name), how_to_capture: t(T.capture) })),
    recording_tips: tips.slice(0, 3),
  };
}

export type MockScenario = 'ok' | 'refusal' | 'max_tokens' | 'overloaded' | 'invalid_json';

/** A `CoachModelClient` that answers with `body()` (or a failure scenario) without touching the network. */
export function staticCoachClient(body: () => unknown, scenario: MockScenario = 'ok', name = 'mock'): CoachModelClient {
  return {
    name,
    create(params) {
      switch (scenario) {
        case 'refusal':
          return Promise.resolve(
            fakeMessage({ model: params.model, stopReason: 'refusal', refusalCategory: 'general_harms' }),
          );
        case 'max_tokens':
          return Promise.resolve(
            fakeMessage({ model: params.model, stopReason: 'max_tokens', text: '{"schema_version":' }),
          );
        case 'overloaded':
          return Promise.reject(
            new APIError(
              529,
              { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
              'Overloaded',
              new Headers(),
            ),
          );
        case 'invalid_json':
          return Promise.resolve(fakeMessage({ model: params.model, text: '{"schema_version": "coach.v1", ' }));
        case 'ok':
          return Promise.resolve(
            fakeMessage({ model: params.model, text: JSON.stringify(body()), withThinking: true }),
          );
      }
    },
  };
}

/** CLAUDE_MODE=mock client for one analysis. */
export function mockCoachClient(src: MockSource, scenario: MockScenario = 'ok'): CoachModelClient {
  return staticCoachClient(() => mockCoachOutput(src), scenario, 'mock');
}
