/**
 * Price table (USD per million tokens) and per-call cost (DESIGN.md §8.3: "cost comes from the four usage meters at
 * the price of model_served"; prices from DESIGN-v1.0 §8.7). Cache writes default to the 5-minute TTL (1.25× input);
 * 1-hour writes are 2× input.
 */
import type { UsageMeters } from './types.ts';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Prompts above this many input tokens use `longContext` (Haiku 5.5's second rate card). */
  longContextAbove?: number;
  longContext?: Omit<ModelPrice, 'longContextAbove' | 'longContext'>;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    longContextAbove: 100_000,
    longContext: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  // Server-side fallback targets that may serve a Sonnet 5.5 request.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
};

/** Unknown models are priced at the most expensive known card so spend guards err on the safe side. */
const FALLBACK_PRICE = MODEL_PRICES['claude-opus-5-5'];

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? FALLBACK_PRICE;
}

/** USD cost of one call, rounded to 6 decimals (the `llm_calls.cost_usd` scale). */
export function costUsd(model: string, u: UsageMeters): number {
  const base = priceFor(model);
  const promptTokens = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
  const p = base.longContext && base.longContextAbove !== undefined && promptTokens > base.longContextAbove
    ? base.longContext
    : base;
  const write1h = Math.min(u.cacheCreation1hInputTokens, u.cacheCreationInputTokens);
  const write5m = u.cacheCreationInputTokens - write1h;
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadInputTokens * p.cacheRead +
    write5m * p.cacheWrite5m + write1h * p.cacheWrite1h) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
