/**
 * Default Apple dependencies for the Edge Functions, built from env (handlers receive them injected, so tests pass
 * fakes), plus the DB-backed owner lookup used by the linking policy.
 */
import type { AuthAdmin, Db } from '../db.ts';
import type { ServerEnv } from '../env.ts';
import { ConfigError } from '../errors.ts';
import type { FetchLike } from '../http.ts';
import { type AppStoreApi, createAppStoreApiFromEnv } from './api.ts';
import { createDeviceCheckClientFromEnv, type DeviceCheckClient } from './devicecheck.ts';
import { trustedRoots } from './jws.ts';
import type { OwnerLookup } from './linking.ts';
import { createSiwaClientFromEnv, type SiwaClient } from './siwa.ts';

export interface AppleServices {
  api: AppStoreApi;
  siwa: SiwaClient;
  deviceCheck: DeviceCheckClient;
  /** Trusted roots for JWS chains (DER); throws a ConfigError when `APPLE_ROOT_CA_G3_PEM` is malformed. */
  roots(): readonly Uint8Array[];
}

export function appleServicesFromEnv(env: Pick<ServerEnv, 'apple'>, fetchImpl?: FetchLike): AppleServices {
  let roots: readonly Uint8Array[] | null = null;
  return {
    api: createAppStoreApiFromEnv(env.apple, fetchImpl),
    siwa: createSiwaClientFromEnv(env.apple, fetchImpl),
    deviceCheck: createDeviceCheckClientFromEnv(env.apple, fetchImpl),
    roots() {
      if (roots === null) {
        try {
          roots = trustedRoots(env.apple.rootCaPem);
        } catch (err) {
          throw new ConfigError(`APPLE_ROOT_CA_G3_PEM: ${(err as Error).message}`);
        }
      }
      return roots;
    },
  };
}

/** `getUser` from Auth admin; `wasMergedInto` from the `account_merge` audit rows written by the merge SQL. */
export function createOwnerLookup(db: Db, authAdmin: AuthAdmin): OwnerLookup {
  return {
    async getUser(userId) {
      const u = await authAdmin.getUser(userId);
      return u ? { id: u.id, isAnonymous: u.isAnonymous } : null;
    },
    wasMergedInto(fromId, intoId) {
      return wasMergedInto(db, fromId, intoId);
    },
  };
}

export async function wasMergedInto(db: Db, fromId: string, intoId: string): Promise<boolean> {
  const rows = await db.selectMany<{ details: { from?: unknown } | null }>('private', 'audit_log', 'details', {
    action: 'account_merge',
    subject: intoId,
  });
  return rows.some((r) => typeof r.details?.from === 'string' && r.details.from.toLowerCase() === fromId);
}
