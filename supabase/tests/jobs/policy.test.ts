/** Outcome → action table (DESIGN.md §8.3) and the retry ceiling. */
import { assertEquals } from '@std/assert';
import { backoffSeconds, decideAction, JOB_LIMITS } from '@shared/jobs/index.ts';

const base = { attempt: 1, maxTokensMult: 1, priorParseErrors: 0 };

Deno.test('policy: ok finalizes, refusal and 400 fail (400 with an alert)', () => {
  assertEquals(decideAction('ok', base), { type: 'finalize' });
  assertEquals(decideAction('refusal', base), { type: 'fail', code: 'model_refusal', alert: false });
  assertEquals(decideAction('bad_request', base), { type: 'fail', code: 'bad_request', alert: true });
});

Deno.test('policy: max_tokens requeues once with ×1.5, then bad_output', () => {
  assertEquals(decideAction('max_tokens', base), {
    type: 'requeue',
    delayS: 0,
    code: 'max_tokens',
    maxTokensMult: 1.5,
  });
  assertEquals(decideAction('max_tokens', { ...base, attempt: 2, maxTokensMult: 1.5 }), {
    type: 'fail',
    code: 'bad_output',
    alert: false,
  });
});

Deno.test('policy: parse error requeues once, then bad_output', () => {
  assertEquals(decideAction('parse_error', base), { type: 'requeue', delayS: 0, code: 'parse_error' });
  assertEquals(decideAction('parse_error', { ...base, attempt: 2, priorParseErrors: 1 }), {
    type: 'fail',
    code: 'bad_output',
    alert: false,
  });
});

Deno.test('policy: retryable backs off 30 s·2^attempt and fails upstream_unavailable at attempt 3', () => {
  assertEquals(backoffSeconds(1), 60);
  assertEquals(backoffSeconds(2), 120);
  assertEquals(decideAction('retryable', { ...base, retryReason: 'overloaded' }), {
    type: 'requeue',
    delayS: 60,
    code: 'retry_overloaded',
  });
  assertEquals(decideAction('retryable', { ...base, attempt: 2 }).type, 'requeue');
  assertEquals(decideAction('retryable', { ...base, attempt: JOB_LIMITS.maxAttempts }), {
    type: 'fail',
    code: 'upstream_unavailable',
    alert: false,
  });
});

Deno.test('policy: our own I/O errors use the same ceiling and fail internal with an alert', () => {
  assertEquals(decideAction('internal_error', base), { type: 'requeue', delayS: 60, code: 'internal_error' });
  assertEquals(decideAction('internal_error', { ...base, attempt: 3 }), {
    type: 'fail',
    code: 'internal',
    alert: true,
  });
});

Deno.test('policy: requeue codes satisfy the analyses.last_error_code CHECK', () => {
  const re = /^[a-z0-9_.:-]{1,64}$/;
  for (const reason of ['rate_limited', 'overloaded', 'server_error', 'timeout', 'network']) {
    const a = decideAction('retryable', { ...base, retryReason: reason });
    if (a.type === 'requeue') assertEquals(re.test(a.code), true, a.code);
  }
});
