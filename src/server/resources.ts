import { ProtocolError, ProtocolErrorCode, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { Audit } from '../audit/index.ts';
import type { Env, Principal } from '../auth/index.ts';
import { knowledgeDoc, type KnowledgeDoc } from '../knowledge/index.ts';

const NOT_FOUND = 'knowledge document not found'; // one text for an unknown and an invalid id; neither is echoed
const MD = 'text/markdown';
const idOk = (id: unknown): id is string => typeof id === 'string' && knowledgeDoc.shape.id.safeParse(id).success;

const header = (d: KnowledgeDoc) =>
  [`# ${d.title}`, '', `- source: ${d.source}`, ...(d.country ? [`- country: ${d.country}`] : []), ...(d.channel ? [`- channel: ${d.channel}`] : []), ...(d.link ? [`- link: ${d.link}`] : []), '', ''].join('\n');
const index = (docs: KnowledgeDoc[]) =>
  ['# Knowledge documents', '', ...docs.map((d) => `- ${d.id}: ${d.title} (source: ${d.source}${d.country ? `, country: ${d.country}` : ''}${d.channel ? `, channel: ${d.channel}` : ''})`)].join('\n');

/** Local, read-only: the docs were loaded once at start, so a read does no I/O and needs no Stralfors client. Ids and URIs never reach the audit. */
export function registerKnowledgeResources(server: McpServer, docs: KnowledgeDoc[], principal: Principal, deps: { env: Env; audit: Audit }): void {
  server.server.registerCapabilities({ resources: { listChanged: false } }); // the SDK defaults to true; docs are fixed for the process lifetime
  const byId = new Map(docs.map((d) => [d.id, d]));
  const audit = (outcome: 'allowed' | 'error') =>
    deps.audit.record({ principal, tool: 'resource:read', env: deps.env, durationMs: 0, outcome, ...(outcome === 'error' ? { reason: 'bad_input' as const } : {}) });
  server.registerResource('knowledge-index', 'knowledge://index', { title: 'Knowledge index', description: 'Every knowledge document: id, title, source, country and channel.', mimeType: MD }, (uri) => {
    audit('allowed');
    return { contents: [{ uri: uri.href, mimeType: MD, text: index(docs) }] };
  });
  server.registerResource(
    'knowledge-doc',
    new ResourceTemplate('knowledge://docs/{id}', {
      list: () => ({ resources: docs.map((d) => ({ uri: `knowledge://docs/${d.id}`, name: d.id, title: d.title, description: `${d.title} (source: ${d.source})`, mimeType: MD })) }),
    }),
    { title: 'Knowledge document', description: 'One knowledge document by id, as Markdown.', mimeType: MD },
    (uri, { id }) => {
      const doc = idOk(id) ? byId.get(id) : undefined;
      if (!doc) {
        audit('error');
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, NOT_FOUND);
      }
      audit('allowed');
      return { contents: [{ uri: uri.href, mimeType: MD, text: header(doc) + doc.body }] };
    },
  );
}
