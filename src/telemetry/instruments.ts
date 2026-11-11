// Pure data, no OpenTelemetry import: the instrument set and its label keys live in one table so the Views (label allowlists) and the call sites cannot drift.
export type InstrumentKind = 'counter' | 'histogram' | 'observable_gauge';
export interface InstrumentSpec { name: string; kind: InstrumentKind; unit: 's' | '{call}' | '{request}'; description: string; keys: readonly string[]; buckets?: readonly number[] }

/** Second-scale histogram boundaries (the SDK default is millisecond-shaped). */
export const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10] as const;

export const INSTRUMENTS = {
  httpDuration: { name: 'http.server.request.duration', kind: 'histogram', unit: 's', keys: ['http.request.method', 'http.response.status_code', 'http.route'], buckets: SECONDS, description: 'Inbound HTTP request duration' },
  authRejections: { name: 'mcp.auth.rejections', kind: 'counter', unit: '{request}', keys: ['reason'], description: 'Requests refused with 401, by verify code' },
  rateLimited: { name: 'mcp.http.rate_limited', kind: 'counter', unit: '{request}', keys: [], description: 'Requests refused with 429' },
  toolCalls: { name: 'mcp.tool.calls', kind: 'counter', unit: '{call}', keys: ['tool', 'outcome', 'env'], description: 'Tool calls by outcome' },
  toolDuration: { name: 'mcp.tool.duration', kind: 'histogram', unit: 's', keys: ['tool', 'outcome'], buckets: SECONDS, description: 'Tool call duration' },
  upstreamRequests: { name: 'stralfors.requests', kind: 'counter', unit: '{request}', keys: ['operation', 'outcome', 'error.type'], description: 'Stralfors requests by outcome' },
  upstreamDuration: { name: 'stralfors.request.duration', kind: 'histogram', unit: 's', keys: ['operation', 'outcome', 'error.type'], buckets: SECONDS, description: 'Stralfors request duration' },
  staleSeconds: { name: 'mcp.token_list.stale_seconds', kind: 'observable_gauge', unit: 's', keys: [], description: 'Seconds the token list has been served from the last good load while reloads fail' },
} as const satisfies Record<string, InstrumentSpec>;

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE']);
/** HTTP semconv: known methods verbatim, anything else `_OTHER` (the method is caller text; the label set must stay closed). */
export const METHOD_LABEL = (m: string | undefined): string => (KNOWN_METHODS.has(m ?? '') ? m! : '_OTHER');

/** Every key any span may carry; setSafe drops the rest. */
export const ALLOWED_SPAN_KEYS = new Set(['http.request.method', 'http.response.status_code', 'http.route', 'error.type', 'tool', 'outcome', 'env', 'stralfors.operation']);
