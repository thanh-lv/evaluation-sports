/** Test helpers for Edge Function handlers: request builders, fakes for every injected dependency, local stack. */
import type { ServiceClients } from '../db.ts';
import { FakeAuthAdmin } from './fake_auth.ts';
import { FakeDb } from './fake_db.ts';
import { createFakeStorage, type MemoryStorage } from './fake_storage.ts';
import type { StorageServiceOptions } from '../storage.ts';

export * from './requests.ts';
export * from './env.ts';
export * from './log.ts';
export * from './fake_auth.ts';
export * from './fake_db.ts';
export * from './fake_storage.ts';

export interface FakeServiceClients extends ServiceClients {
  db: FakeDb;
  authAdmin: FakeAuthAdmin;
  /** The in-memory buckets behind `storage`. */
  memory: MemoryStorage;
}

/** `ServiceClients` backed entirely by in-memory fakes. */
export function fakeServiceClients(storageOptions: StorageServiceOptions = {}): FakeServiceClients {
  const { storage, memory } = createFakeStorage(storageOptions);
  return { db: new FakeDb(), storage, authAdmin: new FakeAuthAdmin(), memory };
}
