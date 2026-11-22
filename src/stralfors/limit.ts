/** Per-pod cap on concurrent upstream requests: a full cap refuses at once (no queue), so vendor slowness cannot pile up sockets and memory. */
export interface UpstreamLimit {
  /** true and one slot taken, or false when the cap is full */
  tryAcquire(): boolean;
  release(): void;
  readonly inFlight: number;
}

export function createUpstreamLimit(max: number): UpstreamLimit {
  let n = 0;
  return {
    tryAcquire: () => (n < max ? (n++, true) : false),
    release: () => void (n > 0 && n--),
    get inFlight() { return n; },
  };
}
