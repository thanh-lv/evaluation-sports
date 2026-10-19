/**
 * DeviceCheck two bits (DESIGN §9.3 / D18: the free first-ever analysis bonus). `bit0 = true` means this device
 * already used the bonus. Used by `/analyze/submit` (query) and after the bonus is committed (update).
 *
 * Endpoints: `POST {origin}/v1/query_two_bits` and `/v1/update_two_bits`; the origin is `APPLE_DEVICECHECK_HOST`
 * (production `api.devicecheck.apple.com`; development builds use `api.development.devicecheck.apple.com`).
 */
import type { AppleEnv } from '../env.ts';
import { ConfigError } from '../errors.ts';
import { fetchWithTimeout, type FetchLike } from '../http.ts';
import { cachedToken, DEVICECHECK_TOKEN_REUSE_SEC, deviceCheckToken, type TokenProvider } from './jwt.ts';

export const DEVICECHECK_TIMEOUT_MS = 5_000;

export interface TwoBits {
  bit0: boolean;
  bit1: boolean;
  /** `YYYY-MM` of the last update, or null when the bits were never set. */
  lastUpdateTime: string | null;
}

export class DeviceCheckError extends Error {
  readonly status: number;
  /** 400 (bad device token) is the client's fault; network/429/5xx are transient. */
  readonly kind: 'invalid_token' | 'transient' | 'config';
  constructor(message: string, status: number, kind: DeviceCheckError['kind'], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DeviceCheckError';
    this.status = status;
    this.kind = kind;
  }
}

export interface DeviceCheckClient {
  queryTwoBits(deviceToken: string): Promise<TwoBits>;
  updateTwoBits(deviceToken: string, bits: { bit0: boolean; bit1: boolean }): Promise<void>;
}

export interface DeviceCheckConfig {
  origin: string;
  token: TokenProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export function createDeviceCheckClient(config: DeviceCheckConfig): DeviceCheckClient {
  const doFetch = fetchWithTimeout(config.timeoutMs ?? DEVICECHECK_TIMEOUT_MS, config.fetch ?? fetch);
  const now = config.now ?? (() => new Date());

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    const jwt = await config.token();
    let res: Response;
    try {
      res = await doFetch(`${config.origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, transaction_id: crypto.randomUUID(), timestamp: now().getTime() }),
      });
    } catch (err) {
      throw new DeviceCheckError(`devicecheck ${path} failed`, 0, 'transient', err);
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => {});
    const kind = res.status === 400 ? 'invalid_token' : res.status === 401 || res.status === 403 ? 'config' : 'transient';
    throw new DeviceCheckError(`devicecheck ${path} ${res.status}`, res.status, kind);
  }

  return {
    async queryTwoBits(deviceToken) {
      const res = await post('/v1/query_two_bits', { device_token: deviceToken });
      const text = await res.text();
      // "Failed to find bit state" (200, plain text) means the bits were never set
      if (!text.trim().startsWith('{')) return { bit0: false, bit1: false, lastUpdateTime: null };
      try {
        const parsed = JSON.parse(text) as { bit0?: unknown; bit1?: unknown; last_update_time?: unknown };
        return {
          bit0: parsed.bit0 === true,
          bit1: parsed.bit1 === true,
          lastUpdateTime: typeof parsed.last_update_time === 'string' ? parsed.last_update_time : null,
        };
      } catch (err) {
        throw new DeviceCheckError('devicecheck returned invalid JSON', res.status, 'transient', err);
      }
    },
    async updateTwoBits(deviceToken, bits) {
      const res = await post('/v1/update_two_bits', { device_token: deviceToken, bit0: bits.bit0, bit1: bits.bit1 });
      await res.body?.cancel().catch(() => {});
    },
  };
}

/** The real client from env (`APPLE_TEAM_ID`, `APPLE_DEVICECHECK_KEY_ID`, `APPLE_DEVICECHECK_PRIVATE_KEY`). */
export function createDeviceCheckClientFromEnv(apple: AppleEnv, fetchImpl?: FetchLike): DeviceCheckClient {
  const sign = (now: Date) => {
    if (!apple.teamId || !apple.deviceCheckKeyId || !apple.deviceCheckPrivateKey) {
      return Promise.reject(
        new ConfigError('missing environment: APPLE_TEAM_ID, APPLE_DEVICECHECK_KEY_ID, APPLE_DEVICECHECK_PRIVATE_KEY'),
      );
    }
    return deviceCheckToken({ teamId: apple.teamId, keyId: apple.deviceCheckKeyId, privateKey: apple.deviceCheckPrivateKey }, now);
  };
  return createDeviceCheckClient({
    origin: apple.deviceCheckOrigin,
    token: cachedToken(sign, DEVICECHECK_TOKEN_REUSE_SEC),
    fetch: fetchImpl,
  });
}
