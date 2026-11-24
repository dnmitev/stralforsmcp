// Claude Desktop extension bridge: stdio (Desktop) <-> Streamable HTTP (hosted server). Messages are forwarded verbatim, never interpreted.
// stdout carries protocol frames only; stderr carries fixed lines only (config, url, upstream error, authorization, upstream busy). The token and URL never appear in any output.
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const P = 'stralforsmcp-bridge: ';
const die = (msg: string): never => {
  process.stderr.write(`${P}${msg}\n`);
  process.exit(1);
};

const { MCP_URL, MCP_TOKEN } = process.env;
if (!MCP_URL || !MCP_TOKEN) die('MCP_URL and MCP_TOKEN are required');

function validUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw) || u.username || u.password) return undefined; // userinfo of any kind
    if (u.protocol === 'https:') return u;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u : undefined;
  } catch {
    return undefined;
  }
}
const url = validUrl(MCP_URL!) ?? die('MCP_URL must be https, or http on localhost');

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });

stdio.onmessage = async (msg) => {
  try {
    await http.send(msg);
  } catch (e) {
    // Answer the pending request id (if any) with a fixed JSON-RPC error; nothing from the upstream is echoed.
    const status = (e as { status?: unknown } | null)?.status; // SdkHttpError exposes the HTTP status
    const busy = status === 429 || status === 503; // 429: the server's rate limiter, before any handler; 503: no ready pod behind the ingress
    const answer = (message: string) => ('id' in msg && 'method' in msg ? stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }).catch(() => undefined) : undefined);
    if (busy) {
      // stay up and never resend: a tools/call may be send_invoice (ADR 0028); the client decides whether to try again
      process.stderr.write(`${P}upstream busy (${status})\n`);
      await answer('server busy or unavailable; try again, but check whether a send went through (track_document) before repeating it');
      return;
    }
    const denied = status === 401;
    await answer(denied ? 'authorization failed (check your token)' : 'upstream error');
    die(denied ? 'authorization failed' : 'upstream error');
  }
};
http.onmessage = (msg) => void stdio.send(msg).catch(() => die('upstream error'));
// ponytail: a failed send is fatal except 429/503 (answered busy, bridge stays up); no reconnect, never a resend.
const end = () => process.exit(0);
stdio.onclose = () => void http.close().then(end, end);
http.onclose = () => void stdio.close().then(end, end);

try {
  await http.start();
  await stdio.start();
} catch {
  die('upstream error'); // fixed line: the raw error can carry the URL
}
