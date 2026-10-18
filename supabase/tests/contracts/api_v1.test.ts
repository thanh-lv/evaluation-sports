import { assert } from '@std/assert';
import {
  CatalogResponseV1,
  DeleteAccountRequest,
  SubmitRequest,
  SubmitResponse,
  VerifySubscriptionRequest,
} from '@shared/contracts/index.ts';

const ID = '0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d';

Deno.test('catalog.v1 shape', () => {
  const ok = CatalogResponseV1.safeParse({
    schema: 'catalog.v1',
    skills: [{
      id: 'bd.clear_fh',
      sport: 'badminton',
      name: { vi: 'Phông cầu thuận tay', en: 'Forehand overhead clear' },
      views: { recommended: ['D'], allowed: ['D', 'B', 'S'] },
      viewCoverage: { D: 0.9, B: 0.8, S: 0.7 },
      solo: false,
    }],
    plans: [{ tier: 'free', periodType: 'calendar_month', totalLimit: 2, standardLimit: 0 }],
  });
  assert(ok.success, JSON.stringify(ok.error?.issues));
});

Deno.test('submit bodies', () => {
  assert(SubmitRequest.safeParse({ analysisId: ID }).success);
  assert(SubmitRequest.safeParse({ analysisId: ID, deviceCheckToken: null }).success);
  assert(!SubmitRequest.safeParse({ analysisId: ID.toUpperCase() }).success);
  assert(SubmitResponse.safeParse({ status: 'queued', pollAfterMs: 2000 }).success);
  assert(!SubmitResponse.safeParse({ status: 'failed', pollAfterMs: 2000 }).success);
});

Deno.test('account and subscription bodies', () => {
  assert(VerifySubscriptionRequest.safeParse({ signedTransaction: 'a.b.c', reason: 'restore' }).success);
  assert(!VerifySubscriptionRequest.safeParse({ signedTransaction: 'a.b.c', reason: 'other' }).success);
  assert(DeleteAccountRequest.safeParse({ confirm: true }).success);
  assert(!DeleteAccountRequest.safeParse({ confirm: false }).success);
});
