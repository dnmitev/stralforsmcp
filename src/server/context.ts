import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../auth/index.ts';

const storage = new AsyncLocalStorage<Principal>();
/** Runs fn with p as the current principal for every async continuation started inside fn. */
export const withPrincipal = <T>(p: Principal, fn: () => T): T => storage.run(p, fn);
/** The principal of the enclosing withPrincipal, or undefined outside any tool call. */
export const currentPrincipal = (): Principal | undefined => storage.getStore();
