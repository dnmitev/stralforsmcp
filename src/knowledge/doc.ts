import { z } from 'zod/v4';

export const knowledgeDoc = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(120),
  source: z.enum(['public', 'private']),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  channel: z.string().regex(/^[A-Za-z0-9]{1,40}$/).optional(),
  tags: z.array(z.string().min(1).max(32)).max(12),
  link: z.url({ protocol: /^https$/ }).optional(),
  body: z.string().max(20000),
});
export type KnowledgeDoc = z.infer<typeof knowledgeDoc>;

export type ParseResult = { ok: true; doc: KnowledgeDoc } | { ok: false };

// ponytail: fixed format only (`key: value` lines, tags comma separated); no YAML features, no multi-line values.
export const parseDoc = (raw: string, source: 'public' | 'private'): ParseResult => {
  const lines = raw.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) return { ok: false };
  const fm: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const parsed = knowledgeDoc.safeParse({
    id: fm.id,
    title: fm.title,
    source,
    country: fm.country,
    channel: fm.channel,
    tags: (fm.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    link: fm.link,
    body: lines.slice(end + 1).join('\n').trim(),
  });
  return parsed.success ? { ok: true, doc: parsed.data } : { ok: false };
};
