/**
 * Fakes for `auth.ts` / `db.ts` auth pieces: a ClaimsVerifier that accepts only tokens it issued (JWT-shaped, so
 * `verifyAccessToken`'s shape check passes) and an in-memory AuthAdmin.
 */
import type { ClaimsVerifier } from '../auth.ts';
import type { AdminUser, AuthAdmin } from '../db.ts';
import { toBase64Url } from '../crypto.ts';

export interface IssueOptions {
  userId?: string;
  anonymous?: boolean;
  role?: string;
  /** Seconds since epoch; defaults to now. */
  iat?: number;
  /** Lifetime in seconds (negative → already expired). Default 3600. */
  ttlSec?: number;
  extra?: Record<string, unknown>;
}

type VerifierResult = Awaited<ReturnType<ClaimsVerifier['getClaims']>>;

export class FakeClaimsVerifier implements ClaimsVerifier {
  private readonly issued = new Map<string, Record<string, unknown>>();
  /** When set, every call returns this error (e.g. `{name: 'AuthRetryableFetchError', status: 0}`). */
  failWith: { name?: string; message: string; status?: number } | null = null;
  /** When set, every call throws this (simulates a non-Auth error such as a JWKS fetch TypeError). */
  throwWith: Error | null = null;
  calls = 0;

  issue(options: IssueOptions = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const iat = options.iat ?? now;
    const claims = {
      iss: 'http://fake.test/auth/v1',
      sub: options.userId ?? crypto.randomUUID(),
      aud: 'authenticated',
      role: options.role ?? 'authenticated',
      iat,
      exp: iat + (options.ttlSec ?? 3600),
      aal: 'aal1',
      session_id: crypto.randomUUID(),
      is_anonymous: options.anonymous ?? false,
      ...(options.extra ?? {}),
    };
    const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
    const token = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'fake' })}.${enc(claims)}.${
      toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    }`;
    this.issued.set(token, claims);
    return token;
  }

  getClaims(jwt: string): Promise<VerifierResult> {
    this.calls++;
    if (this.throwWith) return Promise.reject(this.throwWith);
    if (this.failWith) return Promise.resolve({ data: null, error: this.failWith });
    const claims = this.issued.get(jwt);
    if (!claims) {
      return Promise.resolve({
        data: null,
        error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature', status: 400 },
      });
    }
    if ((claims.exp as number) <= Math.floor(Date.now() / 1000)) {
      return Promise.resolve({ data: null, error: { name: 'AuthInvalidJwtError', message: 'JWT has expired' } });
    }
    return Promise.resolve({ data: { claims: { ...claims } }, error: null });
  }
}

export class FakeAuthAdmin implements AuthAdmin {
  readonly users = new Map<string, AdminUser>();
  readonly deleted: string[] = [];

  addUser(user: Partial<AdminUser> & { id: string }): this {
    this.users.set(user.id, {
      id: user.id,
      isAnonymous: user.isAnonymous ?? false,
      email: user.email ?? null,
      createdAt: user.createdAt ?? new Date().toISOString(),
    });
    return this;
  }

  getUser(userId: string): Promise<AdminUser | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  deleteUser(userId: string): Promise<boolean> {
    const existed = this.users.delete(userId);
    if (existed) this.deleted.push(userId);
    return Promise.resolve(existed);
  }
}
