import { AsyncLocalStorage } from 'node:async_hooks';
import { CancelledError } from './errors.ts';

// ponytail: one async-local signal instead of threading an AbortSignal through every client method
const store = new AsyncLocalStorage<AbortSignal>();

/** Runs fn with the caller's abort signal: upstream requests started inside are aborted with it. */
export const withSignal = <T>(signal: AbortSignal | undefined, fn: () => T): T => (signal ? store.run(signal, fn) : fn());

/** The signal of the innermost withSignal scope, if any. */
export const currentSignal = (): AbortSignal | undefined => store.getStore();

/** Runs fn outside every caller's scope: for work shared by several callers (token refresh, a cache fill), so one caller's cancel cannot fail the others. */
export const detached = <T>(fn: () => T): T => store.exit(fn);

/** Waits for p, but rejects with CancelledError as soon as the caller's signal aborts; p itself keeps running for anyone else waiting on it. */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined = currentSignal()): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new CancelledError('request cancelled by the caller'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new CancelledError('request cancelled by the caller'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', stop); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', stop); reject(e); },
    );
  });
}
