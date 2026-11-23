/**
 * Red tests for scripts/live-read-check.ts (plan 03-03c, AC-1..AC-4). Fakes only: no network, no credentials. Every string in the fakes is a run-time canary.
 *
 * Assumed contract for the developer:
 *   report(deps, opts): Promise<string>
 *     deps = { client: Pick<StralforsClient, 'token'|'channels'|'rules'|'documentExample'|'trackDocuments'|'trackHistory'>,
 *              profile: { id: string; agreements: Profile['agreements'] }, env: 'test' | 'prod' }   (rules cache and tool defs built inside)
 *     opts = { channels?: string[]; invoiceNumber?: string; now?: () => number }
 *   parseChannels(env: string | undefined): string[] | undefined   (comma list, trimmed, empty entries dropped; nothing usable -> undefined)
 *
 * Output lines (the tests match only these key fragments):
 *   line 1: `env: test|prod`; then `scopes: a b`, `exp: 1`, `customerCountry: SE`
 *   step lines start with `ok ` or `fail <kind> `, then the tool name:
 *     `ok list_channels <label|#n>: ChanA, ChanB`
 *     `ok get_rules <channel>: total=5 required=2 unknown=1 kinds: required=2, numeric=1, ...`
 *     `ok get_example_invoice <channel>: keys: consignmentId, document leaves=4`
 *     `ok track: documents=1 hasMore=true` + per document / per channel lines holding `outcome=<o>`, `channelId=<n>`, `status=<raw>`
 *     `track: skipped (set LIVE_CHECK_INVOICE_NUMBER)` when no invoice number
 *   A thrown StralforsError prints `fail <kind>`; nothing of the upstream message.
 *   get_example_invoice is called once per chosen channel (channels: [name]); the top-level keys are those after the tool strips actionId.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgreementNotFoundError, Claims, ConfigError, ForbiddenError, UpstreamError } from '../src/stralfors/index.ts';
import { channel, page, rawDoc, receiverCanaries } from '../test/helpers/track.ts';
import { parseChannels, pickProfile, report } from './live-read-check.ts';

// ---- fake builders -------------------------------------------------------------------------------------------------
const hex = () => randomBytes(5).toString('hex');
const cn = (what: string) => `CANARY-${what}-${hex()}`;
const CATALOGUE = ['ChanA', 'ChanB', 'ChanC'];
const FORBIDDEN_METHODS = ['validateInvoice', 'sendInvoice', 'send', 'validate', 'post', 'put', 'delete'];

/** every value a leak would show up as */
function canaries() {
  return {
    agreementA: cn('agreementA'), agreementB: cn('agreementB'), action: cn('action'), consignment: cn('consignment'),
    invoice: cn('invoice'), docId: cn('docId'), extDoc: cn('extDoc'), prose: cn('prose'), exampleRule: cn('exampleRule'),
    pattern: cn('pattern'), ruleId: cn('ruleId'), exHeader: cn('exHeader'), exInvoiceId: cn('exInvoiceId'), exNote: cn('exNote'),
    msg: cn('upstreamMsg'), name: cn('name'), addr: cn('addr'), statusMsg: cn('statusMsg'), ...receiverCanaries(),
  };
}
type C = ReturnType<typeof canaries>;
const values = (c: C) => Object.values(c);

const rules = (c: C) => ({
  rules: [
    { id: `${c.ruleId}-1`, parameter: 'Document.Invoice.Id', isRequired: true, ruleCriterias: ['Required', 'NumericExpected'], expectedPattern: c.pattern, exampleValue: c.exampleRule, dependencies: [] },
    { id: `${c.ruleId}-2`, parameter: 'Document.Invoice.IssueDate', isRequired: true, ruleCriterias: ['Required'], dependencies: [] },
    { id: `${c.ruleId}-3`, parameter: 'Document.Invoice.Note', isRequired: false, ruleCriterias: [`Bogus: ${c.prose}`], dependencies: [] },
    { id: `${c.ruleId}-4`, parameter: 'Document.Invoice.Extra', isRequired: false, ruleCriterias: ['Optional'], dependencies: [] },
    { id: `${c.ruleId}-5`, parameter: 'Document.Invoice.Free', isRequired: false, ruleCriterias: [`ValidationCriteria: ${c.prose}`], dependencies: [] },
  ],
});
/** 4 leaves once actionId is stripped: consignmentId, timeStamp, invoice.id, invoice.note */
const example = (c: C) => ({
  actionId: c.action, consignmentId: c.consignment,
  document: { documentHeader: { timeStamp: c.exHeader }, invoice: { id: c.exInvoiceId, note: c.exNote } },
});
const trackPage = (c: C) => page([rawDoc(c, { documentId: c.docId, extDocumentId: c.extDoc, invoiceNumber: c.invoice, channels: [channel('Delivered', {}, c)] })], false);

interface Spy { calls: Record<string, unknown[][]> }
interface Over { channels?: (id?: string) => Promise<string[]>; rules?: (ch: string) => Promise<unknown>; documentExample?: (a: { channels: string[] }) => Promise<unknown>; trackDocuments?: (a: unknown) => Promise<unknown>; agreements?: { label?: string; id: string }[]; customer?: string }

function world(c: C, over: Over = {}) {
  const spy: Spy = { calls: {} };
  const rec = <A extends unknown[], R>(name: string, f: (...a: A) => R) => (...a: A): R => { (spy.calls[name] ??= []).push(a); return f(...a); };
  const impl = {
    token: { get: async () => ({ claims: new Claims({ scope: 'a b', exp: 1, aud: 'x', ...('customer' in over ? (over.customer === undefined ? {} : { customer: over.customer }) : { customer: 'c/SE' }) }) }) },
    channels: rec('channels', over.channels ?? (async (id?: string) => (id === c.agreementA ? ['ChanA', 'ChanB'] : id === c.agreementB ? ['ChanC'] : CATALOGUE))),
    rules: rec('rules', over.rules ?? (async (_ch: string) => rules(c))),
    documentExample: rec('documentExample', over.documentExample ?? (async () => example(c))),
    trackDocuments: rec('trackDocuments', over.trackDocuments ?? (async () => trackPage(c))),
    trackHistory: rec('trackHistory', async () => { throw new Error('history must not be called'); }),
  } as Record<string, unknown>;
  // any method outside the read allowlist (a send, a validate) explodes on touch
  const client = new Proxy(impl, {
    get(t, k) {
      if (typeof k === 'string' && FORBIDDEN_METHODS.includes(k)) throw new Error(`forbidden client method touched: ${k}`);
      if (typeof k === 'string' && !(k in t)) throw new Error(`unexpected client member touched: ${k}`);
      return t[k as string];
    },
  });
  const agreements = over.agreements ?? [{ label: 'test-a', id: c.agreementA }, { id: c.agreementB }];
  const deps = (env: 'test' | 'prod' = 'test') => ({ client, profile: { id: 'p1', agreements }, env }) as unknown as Parameters<typeof report>[0];
  return { spy, deps };
}
const run = (w: ReturnType<typeof world>, opts: Parameters<typeof report>[1] = {}, env: 'test' | 'prod' = 'test') => report(w.deps(env), { now: () => 0, ...opts });
const line = (out: string, ...frag: string[]) => out.split('\n').find((l) => frag.every((f) => l.includes(f)));

// ---- AC-1 ----------------------------------------------------------------------------------------------------------
describe('AC-1: report content per tool', () => {
  it('puts the env line first, then scopes, exp and customerCountry', async () => {
    const out = await run(world(canaries()));
    expect(out.split('\n')[0]).toBe('env: test');
    expect(out).toContain('scopes: a b');
    expect(out).toContain('exp: 1');
    expect(out).toContain('customerCountry: SE');
  });

  it('lists channels per agreement label, falling back to #n', async () => {
    const out = await run(world(canaries()));
    expect(line(out, 'list_channels', 'test-a:')).toMatch(/^ok .*ChanA, ChanB/);
    expect(line(out, 'list_channels', '#2:')).toMatch(/^ok .*ChanC/);
  });

  it('summarises rules per chosen channel: total, required, kind histogram, unknown', async () => {
    const out = await run(world(canaries()), { channels: ['ChanA'] });
    const l = line(out, 'get_rules', 'ChanA')!;
    expect(l).toMatch(/^ok /);
    for (const f of ['total=5', 'required=2', 'unknown=1', 'numeric=1', 'optional=1', 'criteria=1']) expect(l).toContain(f);
  });

  it('defaults to the first two channels of the client catalogue', async () => {
    const w = world(canaries());
    const out = await run(w);
    expect(w.spy.calls['rules']!.map((a) => a[0])).toEqual(['ChanA', 'ChanB']);
    expect(w.spy.calls['documentExample']!.map((a) => (a[0] as { channels: string[] }).channels)).toEqual([['ChanA'], ['ChanB']]);
    expect(line(out, 'get_rules', 'ChanC')).toBeUndefined();
  });

  it('honours an explicit channel list over the default', async () => {
    const w = world(canaries());
    await run(w, { channels: ['ChanC'] });
    expect(w.spy.calls['rules']!.map((a) => a[0])).toEqual(['ChanC']);
  });

  it('prints sorted top-level example keys and a leaf count, no values', async () => {
    const c = canaries();
    const out = await run(world(c), { channels: ['ChanA'] });
    const l = line(out, 'get_example_invoice', 'ChanA')!;
    expect(l).toMatch(/^ok /);
    expect(l).toContain('keys: consignmentId, document');
    expect(l).toContain('leaves=4');
    expect(l).not.toContain(c.action);
  });

  it('prefixes every step line with ok or fail <kind>', async () => {
    const out = await run(world(canaries()), { channels: ['ChanA'] });
    for (const l of out.split('\n').filter((x: string) => /list_channels|get_rules|get_example_invoice/.test(x))) expect(l).toMatch(/^(ok|fail \w+) /);
  });

  it('a failing step prints its kind and does not stop the rest', async () => {
    const c = canaries();
    const w = world(c, {
      rules: async (ch) => { if (ch === 'ChanA') throw new ForbiddenError(c.msg); return rules(c); },
      documentExample: async () => { throw new UpstreamError(c.msg); },
      channels: async (id) => { if (id === c.agreementA) throw new AgreementNotFoundError(c.msg); return id ? ['ChanC'] : CATALOGUE; },
    });
    const out = await run(w, { channels: ['ChanA', 'ChanB'] });
    expect(line(out, 'list_channels', 'test-a:')).toMatch(/^fail agreement_not_found /);
    expect(line(out, 'list_channels', '#2:')).toMatch(/^ok /);
    expect(line(out, 'get_rules', 'ChanA')).toMatch(/^fail forbidden /);
    expect(line(out, 'get_rules', 'ChanB')).toMatch(/^ok /);
    expect(line(out, 'get_example_invoice', 'ChanA')).toMatch(/^fail upstream /);
    expect(line(out, 'get_example_invoice', 'ChanB')).toMatch(/^fail upstream /);
    expect(out).not.toContain(c.msg);
  });

  it('maps a non-vendor throw to fail unknown without its message', async () => {
    const c = canaries();
    const out = await run(world(c, { rules: async () => { throw new Error(c.msg); } }), { channels: ['ChanA'] });
    expect(line(out, 'get_rules', 'ChanA')).toMatch(/^fail unknown /);
    expect(out).not.toContain(c.msg);
  });
});

// ---- review findings ----------------------------------------------------------------------------------------------
describe('review findings', () => {
  it('reads channels by id when two agreements share a label', async () => {
    const c = canaries();
    const agreements = [{ label: 'dup', id: c.agreementA }, { label: 'dup', id: c.agreementB }];
    const out = await run(world(c, { agreements }), { channels: [] });
    const ls = out.split('\n').filter((l) => l.includes('list_channels dup:'));
    expect(ls).toHaveLength(2);
    expect(ls[0]).toContain('ChanA, ChanB');
    expect(ls[1]).toContain('ChanC');
  });

  it('a rejecting default channel discovery still yields env, fail and track lines', async () => {
    const c = canaries();
    const channels = async (id?: string) => { if (id === undefined) throw new UpstreamError(c.msg); return ['ChanC']; };
    const out = await run(world(c, { channels }), { invoiceNumber: c.invoice });
    expect(out.split('\n')[0]).toBe('env: test');
    expect(line(out, 'discover channels')).toMatch(/^fail upstream discover channels:/);
    expect(out).toContain('ok track:');
    expect(out).not.toContain(c.msg);
  });
});

// ---- AC-2 ----------------------------------------------------------------------------------------------------------
describe('AC-2: nothing but shapes leaves the process', () => {
  it('contains no canary, id, invoice number or receiver field with every step enabled', async () => {
    const c = canaries();
    const out = await run(world(c), { channels: ['ChanA', 'ChanB'], invoiceNumber: c.invoice });
    for (const v of values(c)) expect(out).not.toContain(v);
    expect(out).not.toMatch(/CANARY/);
  });

  it('names agreements only by label or #n', async () => {
    const c = canaries();
    const out = await run(world(c));
    expect(out).toContain('test-a');
    expect(out).toContain('#2');
    expect(out).not.toContain(c.agreementA);
    expect(out).not.toContain(c.agreementB);
  });

  it('leaks nothing when every step fails with a canary message', async () => {
    const c = canaries();
    const boom = async () => { throw new UpstreamError(c.msg); };
    const out = await run(world(c, { channels: boom, rules: boom, documentExample: boom, trackDocuments: boom }), { channels: ['ChanA'], invoiceNumber: c.invoice });
    for (const v of values(c)) expect(out).not.toContain(v);
  });
});

// ---- AC-3 ----------------------------------------------------------------------------------------------------------
describe('AC-3: track_document is opt-in and minimal', () => {
  it('makes no tracking request and says so when no invoice number is given', async () => {
    const w = world(canaries());
    const out = await run(w);
    expect(w.spy.calls['trackDocuments']).toBeUndefined();
    expect(out).toContain('track: skipped (set LIVE_CHECK_INVOICE_NUMBER)');
  });

  it('makes exactly one call with that invoice number, no history and no cursor', async () => {
    const c = canaries();
    const w = world(c);
    await run(w, { invoiceNumber: c.invoice });
    expect(w.spy.calls['trackDocuments']).toHaveLength(1);
    const arg = w.spy.calls['trackDocuments']![0]![0] as Record<string, unknown>;
    expect(arg['invoiceNumber']).toBe(c.invoice);
    expect(arg['lastDocumentId']).toBeUndefined();
    expect(arg['extDocumentId']).toBeUndefined();
    expect(arg['documentId']).toBeUndefined();
    expect(w.spy.calls['trackHistory']).toBeUndefined();
  });

  it('shows document count, hasMore, outcome, and per channel id, raw status and outcome', async () => {
    const c = canaries();
    const out = await run(world(c), { invoiceNumber: c.invoice });
    expect(out).not.toContain('track: skipped');
    expect(out).toMatch(/documents=1/);
    expect(out).toMatch(/hasMore=true/);
    expect(out).toMatch(/outcome=delivered/);
    expect(out).toMatch(/channelId=9/);
    expect(out).toMatch(/status=Delivered/);
  });

  it('never prints the invoice number or any receiver value', async () => {
    const c = canaries();
    const out = await run(world(c), { invoiceNumber: c.invoice });
    for (const v of values(c)) expect(out).not.toContain(v);
  });

  it('prints a status only when it is a known status name; anything else becomes a length marker', async () => {
    const c = canaries();
    const free = `Delivered to Alice Smith ${c.name}`;
    const prefix = 'Printing for Alice';
    const letters = 'Delivered to Alice Smith';
    const trackDocuments = async () => page([rawDoc(c, { documentId: c.docId, channels: [channel(free, {}, c), channel(letters, {}, c), channel(prefix, {}, c), channel('Verified Delivered', {}, c), channel('Delivered', {}, c)] })], false);
    const out = await run(world(c, { trackDocuments }), { invoiceNumber: c.invoice });
    expect(out).toContain('status=Verified Delivered');
    expect(out).toContain('status=Delivered ');
    expect(out.match(/status=<other len=5>/g)).toHaveLength(3); // the tool already masks free text as "other"; the script marks it
    expect(out).not.toContain('Alice');
    expect(out).not.toContain(c.name);
    expect(out).not.toContain('raw status strings shown');
  });

  it('reports a tracking failure by kind and keeps the earlier steps', async () => {
    const c = canaries();
    const out = await run(world(c, { trackDocuments: async () => { throw new UpstreamError(c.msg); } }), { channels: ['ChanA'], invoiceNumber: c.invoice });
    expect(line(out, 'track')).toMatch(/^fail upstream /);
    expect(line(out, 'get_rules', 'ChanA')).toMatch(/^ok /);
    expect(out).not.toContain(c.msg);
    expect(out).not.toContain(c.invoice);
  });
});

// ---- AC-4 ----------------------------------------------------------------------------------------------------------
describe('AC-4: PROD safety', () => {
  it('names the environment on the first line for prod', async () => {
    const out = await run(world(canaries()), {}, 'prod');
    expect(out.split('\n')[0]).toBe('env: prod');
  });

  it('touches only read methods: a full run never reaches a validate or write member', async () => {
    const c = canaries();
    // the proxy throws on any non-allowlisted member; a throw inside report() would surface as fail unknown or a rejection
    const out = await run(world(c), { channels: ['ChanA'], invoiceNumber: c.invoice }, 'prod');
    expect(out).not.toMatch(/fail unknown/);
    expect(out).not.toMatch(/forbidden client method/);
  });
});

// ---- parseChannels -------------------------------------------------------------------------------------------------
describe('parseChannels', () => {
  it('splits a comma list, trims and drops empty entries', () => {
    expect(parseChannels(' ChanA , ChanB,, ,ChanC ')).toEqual(['ChanA', 'ChanB', 'ChanC']);
  });
  it.each([undefined, '', '  ', ' , ,'])('returns undefined for %j', (v) => {
    expect(parseChannels(v)).toBeUndefined();
  });
});

// ---- 06-01: profile selector and agreement probe ------------------------------------------------------------------
describe('06-01 AC-1: pickProfile', () => {
  const profiles = { se: { id: 'se', agreements: [] }, 'no-test': { id: 'no-test', agreements: [] } } as unknown as Parameters<typeof pickProfile>[0];
  it('unset or blank selector gives the first profile', () => {
    expect(pickProfile(profiles, undefined).id).toBe('se');
    expect(pickProfile(profiles, '  ').id).toBe('se');
  });
  it('matches case-insensitively with - and _ equal, like the config', () => {
    expect(pickProfile(profiles, 'NO_TEST').id).toBe('no-test');
    expect(pickProfile(profiles, ' no-test ').id).toBe('no-test');
  });
  it('an unknown selector throws fixed text without the value or the configured ids', () => {
    const v = cn('selector');
    expect(() => pickProfile(profiles, v)).toThrow(ConfigError);
    try { pickProfile(profiles, v); } catch (e) {
      const m = (e as Error).message;
      expect(m).toBe('unknown LIVE_PROFILE');
      expect(m).not.toContain(v);
      expect(m).not.toContain('no-test');
    }
  });
  it('no profiles at all throws', () => {
    expect(() => pickProfile({} as never, undefined)).toThrow(ConfigError);
  });
});

describe('06-01 AC-1/AC-4: report names the profile, optional agreement probe', () => {
  it('prints the profile id on the second line', async () => {
    const out = await run(world(canaries()));
    expect(out.split('\n')[1]).toBe('profile: p1');
  });
  it('a token without a customer claim prints customerCountry: none (06-01 live: the NO token has none)', async () => {
    const out = await run(world(canaries(), { customer: undefined }));
    expect(out).toContain('customerCountry: none');
    expect(out).not.toContain('undefined');
  });
  it('no probe unless asked', async () => {
    const out = await run(world(canaries()));
    expect(out).not.toContain('agreement probe');
  });
  it('probe: a made-up agreement id answered with agreement_not_found is ok, and the id is never printed', async () => {
    const c = canaries();
    let probed = '';
    const w = world(c, { channels: async (id?: string) => { if (id && id !== c.agreementA && id !== c.agreementB) { probed = id; throw new AgreementNotFoundError(c.msg); } return CATALOGUE; } });
    const out = await run(w, { agreementProbe: true });
    expect(probed).toMatch(/^[0-9a-f-]{36}$/);
    expect(line(out, 'ok agreement probe: agreement_not_found')).toBeDefined();
    expect(out).not.toContain(probed);
    expect(out).not.toContain(c.msg);
  });
  it('probe: any other error kind or a success is a fail line', async () => {
    const c = canaries();
    const other = await run(world(c, { channels: async (id?: string) => { if (id && id !== c.agreementA && id !== c.agreementB) throw new UpstreamError(c.msg); return CATALOGUE; } }), { agreementProbe: true });
    expect(line(other, 'fail upstream agreement probe:')).toBeDefined();
    const ok = await run(world(c), { agreementProbe: true });
    expect(line(ok, 'fail unexpected agreement probe:')).toBeDefined();
  });
});
