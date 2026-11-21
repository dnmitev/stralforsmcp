import { AsyncLocalStorage } from 'node:async_hooks';

// ponytail: one async-local signal instead of threading an AbortSignal through every client method
const store = new AsyncLocalStorage<AbortSignal>();

/** Runs fn with the caller's abort signal: upstream requests started inside are aborted with it. Token fetches never read it (they are shared). */
export const withSignal = <T>(signal: AbortSignal | undefined, fn: () => T): T => (signal ? store.run(signal, fn) : fn());

/** The signal of the innermost withSignal scope, if any. */
export const currentSignal = (): AbortSignal | undefined => store.getStore();
