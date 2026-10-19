/**
 * Builds SDK-shaped `BetaMessage` objects for the mock client and tests (no network).
 */
import type { CoachMessage } from './client.ts';
import type { UsageMeters } from './types.ts';

export interface FakeMessageOptions {
  model: string;
  /** Text of a single text block (omitted → no content, e.g. a refusal before output). */
  text?: string;
  stopReason?: CoachMessage['stop_reason'];
  refusalCategory?: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;
  usage?: Partial<UsageMeters>;
  /** Prepend an (empty, omitted-display) thinking block, as adaptive thinking does. */
  withThinking?: boolean;
  id?: string;
}

export function fakeMessage(o: FakeMessageOptions): CoachMessage {
  const content: CoachMessage['content'] = [];
  if (o.withThinking) content.push({ type: 'thinking', thinking: '', signature: 'sig' });
  if (o.text !== undefined) content.push({ type: 'text', text: o.text, citations: null });
  const stopReason = o.stopReason ?? 'end_turn';
  const u = o.usage ?? {};
  return {
    id: o.id ?? 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: o.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === 'refusal'
      ? { type: 'refusal', category: o.refusalCategory ?? null, explanation: 'declined (fake)' }
      : null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: u.inputTokens ?? 0,
      output_tokens: u.outputTokens ?? 0,
      cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: (u.cacheCreationInputTokens ?? 0) - (u.cacheCreation1hInputTokens ?? 0),
        ephemeral_1h_input_tokens: u.cacheCreation1hInputTokens ?? 0,
      },
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  } as CoachMessage;
}
