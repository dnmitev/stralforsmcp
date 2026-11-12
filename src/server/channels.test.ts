/*
 * R19 list_channels. API under test (src/server/channels.ts): createListChannels({ clients, config }), listChannelsInput/Output,
 * PROFILE_REQUIRED / UNKNOWN_PROFILE / UNKNOWN_AGREEMENT; ToolInputError from tools.ts. [fake-api] = Phase 1 in-process mTLS fake.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RateLimitedError, StralforsError, type StralforsClient } from '../stralfors/index.ts';
import { createListChannels, listChannelsOutput } from './channels.ts';
import { ToolInputError, type ToolContext } from './tools.ts';
import { whoami } from './whoami.ts';
import { buildMcp } from './mcp.ts';
import { json } from '../../test/helpers/api.ts';
import { CHANNELS, loadConfig, realClients, startChannelsApi, twoProfiles } from '../../test/helpers/boot.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { ERAS, connect, handlerFetch, principal, sink, toAuth } from '../../test/helpers/server.ts';

let pki: Pki;
let api: Awaited<ReturnType<typeof startChannelsApi>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await api?.fake.close();
  api = undefined;
});

const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
async function world(opts: Parameters<typeof startChannelsApi>[1] = {}, extra: Record<string, string | undefined> = {}) {
  api = await startChannelsApi(pki, opts);
  const tp = twoProfiles(pki, extra);
  const config = loadConfig(tp.env);
  const clients = realClients(pki, api.fake, config);
  const only = (id: string) => new Map([[id, clients.get(id)!]]);
  return { ...tp, config, clients, only, ...api, tool: createListChannels({ clients, config }) };
}
const queryOf = (url: string) => new URL(url, 'https://x').searchParams;

describe('list_channels [fake-api]', () => {
  it('a single profile needs no argument; order and duplicates are kept; no actionId is sent', async () => {
    const w = await world();
    const tool = createListChannels({ clients: w.only('a'), config: w.config });
    const r = await tool.run({}, ctx());
    expect(r).toEqual({ profile: 'a', channels: CHANNELS });
    expect(listChannelsOutput.strict().parse(r)).toEqual(r);
    const reqs = w.channelRequests();
    expect(reqs).toHaveLength(1);
    expect(queryOf(reqs[0]!.url).has('actionId')).toBe(false);
  });

  it('several profiles require the argument: fixed text, zero upstream requests', async () => {
    const w = await world();
    const e = await rejection(w.tool.run({}, ctx()));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe('profile is required');
    expect(w.fake.apiRequests).toHaveLength(0);
    expect(w.fake.tokenRequests).toHaveLength(0);
  });

  it('an explicit profile goes through that profile\'s client', async () => {
    const w = await world();
    const r = await w.tool.run({ profile: 'b' }, ctx());
    expect(r.profile).toBe('b');
    expect(w.fake.requests.find((q) => q.url.startsWith('/rest'))!.headers['authorization']).toBeTypeOf('string');
    expect(w.fake.tokenRequests).toHaveLength(1);
    // credentials travel in the Basic header, not in the form body
    const basic = Buffer.from(String(w.fake.tokenRequests[0]!.headers['authorization']).replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(basic.startsWith(`${w.files.b.clientId}:`)).toBe(true);
    expect(basic).not.toContain(w.files.a.clientId);
  });

  it.each(['zzz', 'A', 'a '])('unknown profile %j: fixed text without the argument, zero requests', async (arg) => {
    const w = await world();
    const e = (await rejection(w.tool.run({ profile: arg }, ctx()))) as Error;
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toBe('unknown profile');
    expect(w.fake.requests).toHaveLength(0);
  });

  it('the agreement label maps to the id server-side; the id appears only in the upstream query', async () => {
    const w = await world();
    const r = await w.tool.run({ profile: 'a', agreement: 'billing' }, ctx());
    expect(queryOf(w.channelRequests()[0]!.url).get('actionId')).toBe(w.uuid.a);
    expect(r).toEqual({ profile: 'a', channels: CHANNELS });
    expect(JSON.stringify(r)).not.toContain(w.uuid.a);
    const b = await w.tool.run({ profile: 'b', agreement: 'letters' }, ctx());
    expect(queryOf(w.channelRequests()[1]!.url).get('actionId')).toBe(w.uuid.b);
    expect(b.profile).toBe('b');
  });

  it('unknown or unlabelled agreement: fixed text, zero requests', async () => {
    const w = await world();
    for (const agreement of ['letters', w.uuid.aNoLabel, 'Billing']) {
      const e = (await rejection(w.tool.run({ profile: 'a', agreement }, ctx()))) as Error;
      expect(e).toBeInstanceOf(ToolInputError);
      expect(e.message).toBe('unknown agreement');
      expect(e.message).not.toContain(agreement);
    }
    expect(w.fake.requests).toHaveLength(0);
  });

  it('an agreement with a single profile and no profile argument resolves against that profile', async () => {
    const w = await world();
    const tool = createListChannels({ clients: w.only('b'), config: w.config });
    await tool.run({ agreement: 'letters' }, ctx());
    expect(queryOf(w.channelRequests()[0]!.url).get('actionId')).toBe(w.uuid.b);
  });

  it('the profile is checked before the agreement', async () => {
    const w = await world();
    const e = (await rejection(w.tool.run({ profile: 'nope', agreement: 'nope' }, ctx()))) as Error;
    expect(e.message).toBe('unknown profile');
  });

  it('the input schema rejects an empty profile or agreement and extra types', () => {
    const w = createListChannels({ clients: new Map(), config: { profiles: {} } });
    expect(w.inputSchema.safeParse({ agreement: '' }).success).toBe(false);
    expect(w.inputSchema.safeParse({ profile: '' }).success).toBe(false);
    expect(w.inputSchema.safeParse({}).success).toBe(true);
    expect(w.inputSchema.safeParse({ profile: 'a', agreement: 'b' }).success).toBe(true);
  });
});

describe('list_channels upstream failures surface as kinds only [fake-api]', () => {
  const MSG = (id: string) => `{"message":"actionId '${id}' not found for identityId 'ID-CANARY'","compositeFault":null}`;
  const rows: [string, (id: string) => (req: never, res: import('node:http').ServerResponse) => void, string, Record<string, string>?][] = [
    ['404 JSON', (id) => (_q, res) => json(res, 404, MSG(id)), 'agreement_not_found'],
    ['404 text', () => (_q, res) => json(res, 404, 'No Mapping Rule matched', 'text/plain'), 'route_not_found'],
    ['400 problem', () => (_q, res) => json(res, 400, { title: 'x', errors: { actionId: ['CANARY'] } }, 'application/problem+json'), 'bad_request'],
    ['401 twice', () => (_q, res) => json(res, 401, ''), 'auth'],
    ['403', () => (_q, res) => json(res, 403, ''), 'forbidden'],
    ['429', () => (_q, res) => (res.setHeader('retry-after', '2'), json(res, 429, '')), 'rate_limited'],
    ['500', () => (_q, res) => json(res, 500, 'boom'), 'upstream'],
    ['not json', () => (_q, res) => json(res, 200, 'not json', 'application/json'), 'schema'],
    ['not an array', () => (_q, res) => json(res, 200, { x: 1 }), 'schema'],
    ['no response', () => () => undefined, 'timeout', { STRALFORS_TIMEOUT_MS: '300' }],
  ];
  it.each(rows)('%s -> %s', async (_n, mk, kind, extra) => {
    const w = await world({}, extra);
    w.reply.current = mk(w.uuid.a) as never;
    const e = await rejection(w.tool.run({ profile: 'a', agreement: 'billing' }, ctx()));
    expect(e).toBeInstanceOf(StralforsError);
    expect((e as StralforsError).kind).toBe(kind);
    const seen = `${(e as Error).message}${JSON.stringify(e)}`;
    for (const c of [w.uuid.a, 'ID-CANARY', 'identityId', 'CANARY']) expect(seen).not.toContain(c);
  });

  it('a self-signed server certificate surfaces as tls', async () => {
    const w = await world({ serverCert: 'selfSigned' });
    const e = await rejection(w.tool.run({ profile: 'a' }, ctx()));
    expect((e as StralforsError).kind).toBe('tls');
  });

  it('an upstream 429 is the client error class (not our limiter)', async () => {
    const w = await world();
    w.reply.current = (_q, res) => json(res, 429, '');
    expect(await rejection(w.tool.run({ profile: 'a' }, ctx()))).toBeInstanceOf(RateLimitedError);
  });
});

describe('list_channels policy matrix over the SDK', () => {
  const stub = { channels: async () => ['x'] } as unknown as StralforsClient;
  const tool = createListChannels({ clients: new Map([['a', stub]]), config: { profiles: {} } });
  const rows = (['dev', 'qa', 'pm'] as const).flatMap((role) =>
    (['test', 'prod'] as const).flatMap((env) =>
      ([['test'], ['prod'], ['test', 'prod']] as const).flatMap((envs) => [false, true].map((allowWrite) => [role, env, envs, allowWrite] as const))));

  it('is listed exactly when whoami is listed, over role x env x principal envs x allowWrite', async () => {
    let listed = 0;
    let unlisted = 0;
    for (const [role, env, envs, allowWrite] of rows) {
      const s = sink();
      const { fetch } = handlerFetch(buildMcp({ env, allowWrite: allowWrite && env === 'test', prodValidateEnabled: false, audit: s.audit, tools: [whoami, tool] }), toAuth(principal(role, [...envs])));
      const c = await connect('modern', fetch);
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names.includes('list_channels'), `${role} ${env} ${envs} ${allowWrite}`).toBe(names.includes('whoami'));
      if (names.includes('list_channels')) listed++;
      else {
        unlisted++;
        const r = await c.callTool({ name: 'list_channels', arguments: {} }).then((x) => x.isError === true, () => true);
        expect(r).toBe(true);
        expect(s.lines()).toEqual([]);
      }
    }
    expect(listed).toBeGreaterThan(0);
    expect(unlisted).toBeGreaterThan(0);
  });

  it.each(ERAS)('is callable end to end through the SDK (%s era) and audited allowed', async (era) => {
    const s = sink();
    const { fetch } = handlerFetch(buildMcp({ env: 'test', allowWrite: false, prodValidateEnabled: false, audit: s.audit, tools: [tool] }), toAuth(principal('qa', ['test'])));
    const c = await connect(era, fetch);
    const r = await c.callTool({ name: 'list_channels', arguments: {} });
    expect(r.structuredContent).toEqual({ profile: 'a', channels: ['x'] });
    expect(s.lines().map((l) => [l.tool, l.outcome])).toEqual([['list_channels', 'allowed']]);
    expect(listChannelsOutput.strict().parse(r.structuredContent)).toBeTruthy();
  });
});
