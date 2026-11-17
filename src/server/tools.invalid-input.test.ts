// Schema-invalid input is rejected by the SDK before the wrapper; it must still be audited as error/invalid_input, never with values.
import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';
import { buildMcp } from './mcp.ts';
import type { ToolDef } from './tools.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import { memTelemetry } from '../../test/helpers/telemetry.ts';

const strict = (): { def: ToolDef; ran: () => number } => {
  let n = 0;
  const def: ToolDef = {
    spec: { name: 'strictTool', access: 'read' },
    title: 'Strict', description: 'Strict',
    inputSchema: z.object({ id: z.string().regex(/^[0-9]+$/) }),
    outputSchema: z.object({ v: z.number() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async () => { n++; return { v: 1 }; },
  };
  return { def, ran: () => n };
};

describe.each(ERAS)('SDK-rejected input (%s)', (era) => {
  const setup = async () => {
    const s = sink();
    const t = strict();
    const m = memTelemetry();
    const h = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [t.def], telemetry: m.t }), toAuth(principal('qa', ['test'])));
    return { s, t, m, c: await connect(era, h.fetch) };
  };
  it('is audited once as error/invalid_input with the tool, no values, and the tool never runs', async () => {
    const { s, t, c } = await setup();
    const r = await c.callTool({ name: 'strictTool', arguments: { id: 'ARG-CANARY' } }).then((x) => x.isError === true, () => true);
    expect(r).toBe(true);
    expect(t.ran()).toBe(0);
    expect(s.lines()).toHaveLength(1);
    expect(s.lines()[0]).toMatchObject({ tool: 'strictTool', env: 'test', outcome: 'error', reason: 'invalid_input' });
    expect(s.text()).not.toContain('ARG-CANARY');
  });
  it('a missing field is audited the same way; a valid call is not audited as invalid', async () => {
    const { s, c } = await setup();
    await c.callTool({ name: 'strictTool', arguments: {} }).catch(() => undefined);
    await c.callTool({ name: 'strictTool', arguments: { id: '12' } });
    expect(s.lines().map((l) => [l.outcome, l.reason])).toEqual([['error', 'invalid_input'], ['allowed', undefined]]);
  });
  it('counts the call as an error in the tool metrics', async () => {
    const { m, c } = await setup();
    await c.callTool({ name: 'strictTool', arguments: { id: 'x' } }).catch(() => undefined);
    expect(await m.text()).toMatch(/outcome="error"/);
  });
});

describe('an asynchronous schema', () => {
  it('is audited as invalid_input too', async () => {
    const s = sink();
    const def: ToolDef = { ...strict().def, inputSchema: z.object({ id: z.string().refine(async (v) => v === 'ok') }) };
    const h = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [def] }), toAuth(principal('qa', ['test'])));
    const c = await connect('modern', h.fetch);
    await c.callTool({ name: 'strictTool', arguments: { id: 'no' } }).catch(() => undefined);
    await c.callTool({ name: 'strictTool', arguments: { id: 'ok' } });
    expect(s.lines().map((l) => l.reason)).toEqual(['invalid_input', undefined]);
  });
});
