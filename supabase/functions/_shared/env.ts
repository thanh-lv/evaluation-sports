/**
 * Typed environment for the Edge Functions.
 *
 * Supabase injects `SUPABASE_URL` and the API keys. Newer runtimes inject `SUPABASE_SECRET_KEYS` /
 * `SUPABASE_PUBLISHABLE_KEYS` as JSON maps (`{"default": "sb_…"}`) next to the legacy `SUPABASE_SERVICE_ROLE_KEY` /
 * `SUPABASE_ANON_KEY`; the new keys win. Our own secrets (supabase/functions/.env.example) must NOT start with
 * `SUPABASE_`: the runtime reserves that prefix and drops such user secrets.
 *
 * `loadEnv()` fails fast only on what every function needs (URL and keys) and on malformed values. Secrets used by
 * one function are optional here; read them with `requireConfig(value, NAME)` where they are needed, so a missing
 * Apple key does not take down `/analyze`.
 */
import { ConfigError } from './errors.ts';
import { type LogLevel, parseLogLevel } from './log.ts';

export type ClaudeMode = 'mock' | 'live';

export interface AppleEnv {
  bundleId: string | null;
  appAppleId: string | null;
  teamId: string | null;
  /** App Store Server API (In-App Purchase key). */
  iapKeyId: string | null;
  iapIssuerId: string | null;
  iapPrivateKey: string | null;
  /** Sign in with Apple (client secret for /auth/token and /auth/revoke). */
  siwaKeyId: string | null;
  siwaPrivateKey: string | null;
  /** SIWA client id (`sub` of the client secret); defaults to the bundle id (native flow). */
  siwaClientId: string | null;
  deviceCheckKeyId: string | null;
  deviceCheckPrivateKey: string | null;
  /** Origins (scheme + host) of the App Store Server API, overridable for tests / mocks. */
  apiOrigin: { production: string; sandbox: string };
  /** DeviceCheck origin (`APPLE_DEVICECHECK_HOST`). */
  deviceCheckOrigin: string;
}

export interface ServerEnv {
  supabaseUrl: string;
  /** Service-role / secret key (bypasses RLS). */
  serviceKey: string;
  /** Anon / publishable key (used to verify user JWTs). */
  anonKey: string;
  anthropicApiKey: string | null;
  claudeMode: ClaudeMode;
  internalSecret: string | null;
  cronSecret: string | null;
  /** Base64 32-byte AES-GCM key for stored Apple refresh tokens. */
  tokenEncKey: string | null;
  /** Pepper for `sha256(uid + pepper)` audit subjects (delete-account). */
  auditPepper: string | null;
  /** Salt for log user-id hashes (falls back to a fixed namespace). */
  logPepper: string | null;
  logLevel: LogLevel;
  allowXcodeEnv: boolean;
  apple: AppleEnv;
}

export type EnvSource = { get(name: string): string | undefined };

export const DEFAULT_APPLE_API_HOST_PROD = 'api.storekit.apple.com';
export const DEFAULT_APPLE_API_HOST_SANDBOX = 'api.storekit-sandbox.apple.com';
export const DEFAULT_APPLE_DEVICECHECK_HOST = 'api.devicecheck.apple.com';

function opt(src: EnvSource, name: string): string | null {
  const v = src.get(name);
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** First non-empty value of a JSON key map like `{"default": "sb_secret_…"}`. */
function fromKeyMap(src: EnvSource, name: string): string | null {
  const raw = opt(src, name);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map = parsed as Record<string, unknown>;
      const value = typeof map.default === 'string' ? map.default : Object.values(map).find((v) => typeof v === 'string');
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  } catch {
    throw new ConfigError(`${name} must be a JSON object of keys`);
  }
  return null;
}

function bool(src: EnvSource, name: string): boolean {
  const v = opt(src, name)?.toLowerCase() ?? null;
  if (v === null || v === 'false' || v === '0' || v === 'no') return false;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  throw new ConfigError(`${name} must be true or false`);
}

/** PEM keys pasted into a one-line secret often carry literal `\n`; restore real newlines. */
function pem(src: EnvSource, name: string): string | null {
  const v = opt(src, name);
  return v === null ? null : v.replace(/\\n/g, '\n');
}

/** `host`, `host:port` or a full `http(s)://host` → origin without a trailing slash. */
export function toOrigin(value: string, name: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConfigError(`${name} is not a valid host or URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`${name} must be http(s)`);
  if (url.pathname !== '/' || url.search || url.hash) throw new ConfigError(`${name} must be a bare host or origin`);
  return url.origin;
}

export function loadEnv(src: EnvSource = Deno.env): ServerEnv {
  const missing: string[] = [];
  const supabaseUrl = opt(src, 'SUPABASE_URL');
  if (supabaseUrl === null) missing.push('SUPABASE_URL');
  const serviceKey = opt(src, 'SUPABASE_SECRET_KEY') ?? fromKeyMap(src, 'SUPABASE_SECRET_KEYS') ??
    opt(src, 'SUPABASE_SERVICE_ROLE_KEY');
  if (serviceKey === null) missing.push('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = opt(src, 'SUPABASE_PUBLISHABLE_KEY') ?? fromKeyMap(src, 'SUPABASE_PUBLISHABLE_KEYS') ??
    opt(src, 'SUPABASE_ANON_KEY');
  if (anonKey === null) missing.push('SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY');
  if (missing.length) throw new ConfigError(`missing environment: ${missing.join(', ')}`);

  try {
    new URL(supabaseUrl!);
  } catch {
    throw new ConfigError('SUPABASE_URL is not a valid URL');
  }

  const anthropicApiKey = opt(src, 'ANTHROPIC_API_KEY');
  const modeRaw = opt(src, 'CLAUDE_MODE')?.toLowerCase() ?? null;
  if (modeRaw !== null && modeRaw !== 'mock' && modeRaw !== 'live') {
    throw new ConfigError('CLAUDE_MODE must be mock or live');
  }
  const claudeMode: ClaudeMode = (modeRaw as ClaudeMode | null) ?? (anthropicApiKey ? 'live' : 'mock');
  if (claudeMode === 'live' && !anthropicApiKey) throw new ConfigError('CLAUDE_MODE=live needs ANTHROPIC_API_KEY');

  const tokenEncKey = opt(src, 'TOKEN_ENC_KEY');
  if (tokenEncKey !== null) assertBase64Key(tokenEncKey, 'TOKEN_ENC_KEY');

  const bundleId = opt(src, 'APPLE_BUNDLE_ID');
  const apple: AppleEnv = {
    bundleId,
    appAppleId: opt(src, 'APPLE_APP_APPLE_ID'),
    teamId: opt(src, 'APPLE_TEAM_ID') ?? opt(src, 'APPLE_SIWA_TEAM_ID'),
    iapKeyId: opt(src, 'APPLE_IAP_KEY_ID'),
    iapIssuerId: opt(src, 'APPLE_IAP_ISSUER_ID'),
    iapPrivateKey: pem(src, 'APPLE_IAP_PRIVATE_KEY'),
    siwaKeyId: opt(src, 'APPLE_SIWA_KEY_ID'),
    siwaPrivateKey: pem(src, 'APPLE_SIWA_PRIVATE_KEY'),
    siwaClientId: opt(src, 'APPLE_SIWA_CLIENT_ID') ?? bundleId,
    deviceCheckKeyId: opt(src, 'APPLE_DEVICECHECK_KEY_ID'),
    deviceCheckPrivateKey: pem(src, 'APPLE_DEVICECHECK_PRIVATE_KEY'),
    apiOrigin: {
      production: toOrigin(opt(src, 'APPLE_API_HOST_PROD') ?? DEFAULT_APPLE_API_HOST_PROD, 'APPLE_API_HOST_PROD'),
      sandbox: toOrigin(
        opt(src, 'APPLE_API_HOST_SANDBOX') ?? DEFAULT_APPLE_API_HOST_SANDBOX,
        'APPLE_API_HOST_SANDBOX',
      ),
    },
    deviceCheckOrigin: toOrigin(
      opt(src, 'APPLE_DEVICECHECK_HOST') ?? DEFAULT_APPLE_DEVICECHECK_HOST,
      'APPLE_DEVICECHECK_HOST',
    ),
  };

  return {
    supabaseUrl: supabaseUrl!.replace(/\/+$/, ''),
    serviceKey: serviceKey!,
    anonKey: anonKey!,
    anthropicApiKey,
    claudeMode,
    internalSecret: opt(src, 'INTERNAL_SECRET'),
    cronSecret: opt(src, 'CRON_SECRET'),
    tokenEncKey,
    auditPepper: opt(src, 'AUDIT_PEPPER'),
    logPepper: opt(src, 'LOG_PEPPER'),
    logLevel: parseLogLevel(opt(src, 'LOG_LEVEL')),
    allowXcodeEnv: bool(src, 'ALLOW_XCODE_ENV'),
    apple,
  };
}

/** Decodes standard or URL-safe base64 and checks the length (32 bytes = AES-256). */
export function assertBase64Key(value: string, name: string, bytes = 32): Uint8Array {
  let decoded: Uint8Array;
  try {
    const std = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    decoded = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    throw new ConfigError(`${name} must be base64`);
  }
  if (decoded.length !== bytes) throw new ConfigError(`${name} must decode to ${bytes} bytes`);
  return decoded;
}

/** Returns `value` or throws a ConfigError naming the variable (→ 500 `internal`, logged with the name). */
export function requireConfig<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined || (typeof value === 'string' && value === '')) {
    throw new ConfigError(`missing environment: ${name}`);
  }
  return value;
}

let cached: ServerEnv | null = null;

/** Process-wide env, loaded once from `Deno.env`. */
export function getEnv(): ServerEnv {
  cached ??= loadEnv();
  return cached;
}

/** Test hook: forget the cached env. */
export function resetEnvCache(): void {
  cached = null;
}
