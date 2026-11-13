/* validate_invoice through the registry and the SDK: PROD gate matrix, outputSchema, audit and telemetry canaries. Real client against a fake API. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { json } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { RULES, VALIDATE, doc, fault, rule, validateWorld } from '../../test/helpers/validate.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';
import { dump, memTelemetry } from '../../test/helpers/telemetry.ts';
import { buildMcp } from './mcp.ts';
import { callTool } from './tools.ts';
import { whoami } from './whoami.ts';
import { createGetRules } from './rules-tools.ts';
import { validateOutput } from './validate-tool.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const CANARY = { value: 'DOC-VALUE-CANARY', param: 'RULE-PARAM-CANARY', consignment: 'CONSIGNMENT-CANARY-0001' };

async function setup(env: 'test' | 'prod', prodValidate: boolean, p = principal('dev', ['test', 'prod']), rules: Record<string, unknown[]> = {}) {
  const x = (w = await validateWorld(pki, { rules, env: { STRALFORS_ENV: env, STRALFORS_PROD_VALIDATE_ENABLED: prodValidate ? 'true' : 'false' } }));
  const s = sink();
  const m = memTelemetry();
  const tools = [whoami, createGetRules({ clients: x.clients, cache: x.cache }), x.tool];
  const h = handlerFetch(buildMcp({ env, allowWrite: false, prodValidateEnabled: prodValidate, audit: s.audit, tools, telemetry: m.t }), toAuth(p));
  return { x, s, m, c: await connect('modern', h.fetch), h };
}
const names = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).tools.map((t) => t.name);
const call = (c: Awaited<ReturnType<typeof connect>>, document: unknown, extra: Record<string, unknown> = {}) => c.callTool({ name: 'validate_invoice', arguments: { document, ...extra } });

describe('AC-1 gate', () => {
  it('prod, flag off: not listed; a direct call is denied with reason validate and reaches nothing', async () => {
    const { x, s, c } = await setup('prod', false);
    expect(await names(c)).not.toContain('validate_invoice');
    expect(await call(c, doc()).then((r) => r.isError === true, () => true)).toBe(true); // the SDK refuses a tool that was never registered
    expect(s.lines()).toEqual([]);
    // the registry wrapper itself, called directly, denies with the reason and audits it
    const r = await callTool(x.tool as never, { document: doc() }, principal('dev', ['prod']), { env: 'prod', allowWrite: false, prodValidateEnabled: false, audit: s.audit });
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'not allowed: validate' }] });
    expect(s.lines().map((l) => [l.tool, l.outcome, l.reason])).toEqual([['validate_invoice', 'denied', 'validate']]);
    expect(s.text()).not.toMatch(/findings|path|document/i);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });

  it('prod, flag on: listed; a call reaches the stub with PUT .../validate?test=true', async () => {
    const { x, s, c } = await setup('prod', true);
    expect(await names(c)).toContain('validate_invoice');
    const r = await call(c, doc(), { consignmentId: CANARY.consignment, profile: 'b' });
    expect(r.isError).toBeFalsy();
    expect(validateOutput.parse(r.structuredContent)).toMatchObject({ valid: true, stage: 'passed' });
    const req = x.fake.apiRequests.filter((q) => q.url.split('?')[0] === VALIDATE);
    expect(req.map((q) => [q.method, q.url.split('?')[1]])).toEqual([['PUT', 'test=true']]);
    expect(s.lines().map((l) => [l.tool, l.env, l.outcome])).toEqual([['validate_invoice', 'prod', 'allowed']]);
  });

  it('test env: listed for dev, qa and pm', async () => {
    for (const role of ['dev', 'qa', 'pm'] as const) {
      const { c } = await setup('test', false, principal(role, ['test']));
      expect(await names(c), role).toContain('validate_invoice');
      await w?.close();
    }
  });

  it('prod, flag on: dev listed; qa/pm without prod access are not and a direct call fails', async () => {
    const { c } = await setup('prod', true, principal('dev', ['prod']));
    expect(await names(c)).toContain('validate_invoice');
    await w?.close();
    for (const role of ['qa', 'pm'] as const) {
      const { c: c2, x } = await setup('prod', true, principal(role, ['test']));
      expect(await names(c2), role).not.toContain('validate_invoice');
      expect(await call(c2, doc()).then((r) => r.isError === true, () => true)).toBe(true);
      expect(x.requests(VALIDATE)).toHaveLength(0);
      await w?.close();
    }
  });
});

describe('schema and structured output', () => {
  it.each(ERAS)('annotations, outputSchema, structuredContent (%s era)', async (era) => {
    const { h } = await setup('test', false);
    const c = await connect(era, h.fetch);
    const t = (await c.listTools()).tools.find((v) => v.name === 'validate_invoice')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t.outputSchema).toBeTruthy();
    const r = await call(c, { documentHeader: {} }, { profile: 'b' });
    expect(validateOutput.parse(r.structuredContent)).toMatchObject({ valid: false, stage: 'input', moreMayFollow: true });
  });

  it('lists whoami, get_rules and validate_invoice in the test env', async () => {
    const { c } = await setup('test', false);
    expect(await names(c)).toEqual(['whoami', 'get_rules', 'validate_invoice']);
  });
});

describe('privacy: audit, spans, metrics carry nothing from the call', () => {
  const rules = { X: [rule('1', 'Document.Invoice.Amount', ['Required', `ExpectedPattern: ^${CANARY.param}$`])] };
  const doit = async (kind: 'allowed' | 'local' | 'dry' | 'error' | 'agreement') => {
    const { x, s, m, c } = await setup('test', false, undefined, kind === 'local' ? rules : {});
    x.routes[VALIDATE] = (_q, res) => {
      if (kind === 'dry') json(res, 400, fault({ param: 'p', value: CANARY.value }));
      else if (kind === 'error') json(res, 500, `UPSTREAM-${CANARY.value}`);
      else if (kind === 'agreement') json(res, 404, { message: `identity ${x.uuid.b}` });
      else json(res, 200, '');
    };
    const body = kind === 'local' ? doc(['X'], { amount: CANARY.value }) : doc(['X'], { note: CANARY.value });
    const r = await call(c, body, { consignmentId: CANARY.consignment, agreement: 'letters', profile: 'b' });
    return { r, x, s, m };
  };
  it.each(['allowed', 'local', 'dry', 'error', 'agreement'] as const)('%s', async (kind) => {
    const { r, x, s, m } = await doit(kind);
    const lines = s.lines().filter((l) => l.tool === 'validate_invoice');
    expect(lines).toHaveLength(1);
    for (const k of Object.keys(lines[0]!)) expect(['ts', 'level', 'log.type', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs'], k).toContain(k);
    expect(lines[0]!.outcome).toBe(kind === 'error' || kind === 'agreement' ? 'error' : 'allowed');
    const all = s.text() + dump(m.spans()) + (await m.text());
    for (const v of [CANARY.value, CANARY.param, CANARY.consignment, 'letters', x.uuid.b, 'UPSTREAM']) expect(all, `${kind} ${v}`).not.toContain(v);
    if (kind === 'error' || kind === 'agreement') expect(JSON.stringify(r.content)).not.toMatch(/CANARY|UPSTREAM/);
    expect(s.text()).not.toMatch(/\d+ findings|findings|path|document\./i);
  });

});

describe('RULES route is hit through the same client', () => {
  it('local stage loads rules once for the channel', async () => {
    const { x, c } = await setup('test', false, undefined, { X: [rule('1', 'Document.Invoice.A', ['Required'])] });
    const r = await call(c, doc(['X'], {}), { profile: 'b' });
    expect(validateOutput.parse(r.structuredContent).stage).toBe('local');
    expect(x.requests(RULES)).toHaveLength(1);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
});
