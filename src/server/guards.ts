export interface Refusal { status: number; headers: Record<string, string>; body: string }

export const text = (status: number, body: string, extra: Record<string, string> = {}): Refusal => ({ status, headers: { 'Content-Type': 'text/plain', ...extra }, body });

/** Pure path / method / declared-size checks (after the Host and Origin guards). undefined means pass. */
export function refuse(req: { method?: string; url?: string; contentLength?: string }, maxBodyBytes: number): Refusal | undefined {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return text(404, 'not found');
  if (req.method !== 'POST') return text(405, 'method not allowed', { Allow: 'POST' });
  if (req.contentLength !== undefined && Number(req.contentLength) > maxBodyBytes) return text(413, 'payload too large', { Connection: 'close' });
  return undefined;
}
