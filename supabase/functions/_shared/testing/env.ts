/** A complete `ServerEnv` with harmless values, for handler tests. */
import { DEFAULT_APPLE_DEVICECHECK_HOST, type ServerEnv } from '../env.ts';

/** 32 zero bytes, base64 (tests only). */
export const TEST_TOKEN_ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function testEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    supabaseUrl: 'http://supabase.test',
    serviceKey: 'sb_secret_test',
    anonKey: 'sb_publishable_test',
    jwks: null,
    anthropicApiKey: null,
    claudeMode: 'mock',
    internalSecret: 'internal-secret-test',
    cronSecret: 'cron-secret-test',
    tokenEncKey: TEST_TOKEN_ENC_KEY,
    auditPepper: 'pepper-test',
    logPepper: null,
    logLevel: 'debug',
    allowXcodeEnv: false,
    apple: {
      bundleId: 'app.racketcoach.test',
      appAppleId: '1234567890',
      teamId: 'TEAMID1234',
      iapKeyId: null,
      iapIssuerId: null,
      iapPrivateKey: null,
      siwaKeyId: null,
      siwaPrivateKey: null,
      siwaClientId: 'app.racketcoach.test',
      deviceCheckKeyId: null,
      deviceCheckPrivateKey: null,
      apiOrigin: { production: 'https://apple-prod.test', sandbox: 'https://apple-sandbox.test' },
      deviceCheckOrigin: `https://${DEFAULT_APPLE_DEVICECHECK_HOST}`,
    },
    ...overrides,
  };
}

/** An `EnvSource` over a plain object (for `loadEnv` tests). */
export function envSource(values: Record<string, string>): { get(name: string): string | undefined } {
  return { get: (name) => values[name] };
}
