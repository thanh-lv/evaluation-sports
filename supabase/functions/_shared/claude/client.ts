/**
 * Thin SDK wrapper (DESIGN.md §8.1 request rules): one call per invocation, `maxRetries: 0` (the job runner owns
 * retries), timeout from `model_routes.timeout_ms` as an AbortSignal. Everything else talks to `CoachModelClient`,
 * so tests, the mock mode and the replay tool inject their own implementation.
 */
import Anthropic from '@anthropic-ai/sdk';

export type CoachRequestParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type CoachMessage = Anthropic.Beta.Messages.BetaMessage;
export type CountTokensParams = Anthropic.Beta.Messages.MessageCountTokensParams;

export interface CallOptions {
  timeoutMs: number;
  /** Extra cancellation (e.g. the function's own deadline); combined with the timeout. */
  signal?: AbortSignal;
}

export interface CoachModelClient {
  /** Label for logs (`anthropic`, `mock`, `fixture`, …). */
  readonly name: string;
  create(params: CoachRequestParams, opts: CallOptions): Promise<CoachMessage>;
  /** Real token count of a request (live client only; used by scripts/smoke-claude.ts). */
  countTokens?(params: CountTokensParams): Promise<number>;
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** Overrides the API origin (tests against a local stub). */
  baseURL?: string;
}

export function anthropicCoachClient(opts: AnthropicClientOptions): CoachModelClient {
  const sdk = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  return {
    name: 'anthropic',
    create(params, call) {
      const timeout = AbortSignal.timeout(call.timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      // Passing `timeout` explicitly also stops the SDK from demanding streaming for large max_tokens.
      return sdk.beta.messages.create(params, { signal, timeout: call.timeoutMs, maxRetries: 0 });
    },
    async countTokens(params) {
      const r = await sdk.beta.messages.countTokens(params, { maxRetries: 0 });
      return r.input_tokens;
    },
  };
}

/** Request id the SDK attaches (non-enumerable `_request_id`) to every parsed response. */
export function requestIdOf(message: unknown): string | null {
  const id = (message as { _request_id?: unknown } | null)?._request_id;
  return typeof id === 'string' ? id : null;
}
