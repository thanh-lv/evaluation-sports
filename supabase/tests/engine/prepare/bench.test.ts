/** M4d budget: prepare of a 30 s 60 Hz clip < 300 ms excluding JSON parse (median after warm-up). */
import { assert } from '@std/assert';
import { PREPARE_BUDGET_MS, runBench } from '../../../../scripts/bench-engine.ts';

Deno.test('bench: prepare a 30 s 60 Hz clip in < 300 ms (excluding parse)', () => {
  const r = runBench(5);
  assert(r.frames > 1700 && r.strokes === 12, `bench clip: ${r.frames} frames, ${r.strokes} strokes`);
  assert(r.payloadBytes > 1_190_000 && r.payloadBytes <= 1_200_000, `payload ${r.payloadBytes} bytes`);
  assert(r.prepareMs.median < PREPARE_BUDGET_MS, `prepare median ${r.prepareMs.median} ms`);
  console.log(`prepare median ${r.prepareMs.median} ms; parse + Zod (1.2 MB) median ${r.parseZodMs.median} ms`);
});
