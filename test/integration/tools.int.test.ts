// AC-3: every Phase 3 tool through start() and an SDK client against the container's stubs, plus what reached the journal.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { integrationEnabled } from './docker.ts';
import { startWiremock, type WiremockStack } from './wiremock.ts';
import { bootWorld, errText, ok, query, type World } from './world.ts';

const enabled = await integrationEnabled();

describe.skipIf(!enabled)('tools through the real stack', () => {
  let wm: WiremockStack;
  let w: World;
  beforeAll(async () => {
    wm = await startWiremock();
    w = await bootWorld(wm);
  });
  afterAll(async () => {
    await w?.close();
    await wm?.stop();
  });
  beforeEach(() => wm.reset());
  const served = async () => (await wm.journal()).filter((r) => !r.url.startsWith('/v1/oidc/'));

  const doc = (extra: Record<string, unknown> = {}) => ({ documentHeader: { timeStamp: '2030-01-02T03:04:05Z', channelPriority: ['EDI'] }, invoice: { id: 'INV-IT-1', ...extra } });
  const validate = (consignmentId: string, o: Record<string, unknown> = {}) => w.call('validate_invoice', { agreement: 'main', consignmentId, document: doc(), ...o });

  it('lists the tools of this phase', async () => {
    const names = (await w.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_channels', 'get_rules', 'get_example_invoice', 'validate_invoice', 'track_document', 'channel_lookup']));
  });

  describe('list_channels', () => {
    it('without an agreement sends no actionId and returns the full list', async () => {
      const r = ok(await w.call('list_channels'));
      expect(r.profile).toBe('a');
      expect(r.channels).toContain('eInvoice');
      expect(r.channels.length).toBeGreaterThan(4);
      expect((await served()).map((e) => query(e.url).has('actionId'))).toEqual([false]);
    });
    it('with an agreement label sends that agreement and returns its channels', async () => {
      expect(ok(await w.call('list_channels', { agreement: 'alt' })).channels).toEqual(['EDI']);
      expect(ok(await w.call('list_channels', { agreement: 'main' })).channels).toEqual(['EDI', 'eBrevWeMail', 'eInvoice', 'Custom']);
    });
  });

  describe('get_rules', () => {
    it('two pages of a tree larger than the default limit; template 0 is sent', async () => {
      const p1 = ok(await w.call('get_rules', { channel: 'eBrevWeMail' }));
      expect(p1).toMatchObject({ profile: 'a', channel: 'eBrevWeMail', templateStandardId: 0, offset: 0, returned: 100, hasMore: true });
      expect(p1.total).toBeGreaterThan(100);
      const p2 = ok(await w.call('get_rules', { channel: 'eBrevWeMail', offset: 100 }));
      expect(p2).toMatchObject({ offset: 100, hasMore: false, total: p1.total, returned: p1.total - 100 });
      expect(p1.rules.at(-1).id).not.toBe(p2.rules[0].id);
      const reqs = (await served()).filter((e) => e.url.includes('/rules'));
      expect(reqs).toHaveLength(1); // the second page came from the cache
      expect(query(reqs[0]!.url).get('templateStandardId')).toBe('0');
      expect(query(reqs[0]!.url).get('channel')).toBe('eBrevWeMail');
    });
    it('turns every criterion kind into a fixed hint and keeps dependency children', async () => {
      const r = ok(await w.call('get_rules', { channel: 'eInvoice', limit: 200 }));
      const hints: string[] = r.rules.flatMap((x: { hints: string[] }) => x.hints);
      const has = (re: RegExp) => expect(hints.some((h) => re.test(h)), String(re)).toBe(true);
      for (const re of [
        /is required\.$/, /is optional\.$/, /is marked as a list by Stralfors/, /items satisfy their own rules/, /one of: Alpha, Beta, Gamma\.$/, /standard templates 0, 2, 3\.$/, /channels the agreement allows: EDI, eInvoice\.$/,
        /default channel/, /must match the pattern \^\[A-Z\]\{3\}\$\.$/, /digits only/, /decimal number/, /at least 0\.$/, /at most 100\.5\.$/, /at most 5 items/, /must be unique/, /case-sensitive/,
        /not be a date in the past/, /start date of/, /start time of/, /valid file name/, /cannot be set together with Other/,
        /optional when PASSTHRU-OPT/, /required when PASSTHRU-REQ/, /invalid when PASSTHRU-INV/, /Rule note: must be a PDF/, /Rule note: PASSTHRU-NOTE/, /rule of a kind this server does not know \(rule 1027\)/,
        /must match the pattern \^\[0-9\]\+\$\.$/, /any one of these must be present: document\.invoice\.sample\.childA, document\.invoice\.sample\.childB/, /all of these must be present/,
      ]) has(re);
      expect(hints.some((h) => /79228162514264337593543950335/.test(h))).toBe(false); // the decimal "no bound" limit has no hint
      const byId = new Map<string, any>(r.rules.map((x: { id: string }) => [x.id, x]));
      expect(byId.get('1200').dependsOn).toEqual({ operator: 'any', rules: [{ id: '1201', path: 'document.invoice.sample.childA' }, { id: '1202', path: 'document.invoice.sample.childB' }] });
      expect(byId.get('1210').dependsOn.operator).toBe('all');
      expect(byId.has('1211')).toBe(true);
      expect(byId.get('1100')).toMatchObject({ tag: 'Template0', pattern: '^[0-9]+$', example: '123' });
    });
    it('sends a non-default template id', async () => {
      const r = ok(await w.call('get_rules', { channel: 'eInvoice', templateStandardId: 2 }));
      expect(r).toMatchObject({ templateStandardId: 2, total: 1 });
      expect(r.rules[0]).toMatchObject({ id: '1300', tag: 'Template2', required: true });
    });
  });

  describe('get_example_invoice', () => {
    it('returns the example without the agreement id, keeping consignmentId, plus fixed notes', async () => {
      const r = ok(await w.call('get_example_invoice', { channels: ['EDI'] }));
      expect(r.channels).toEqual(['EDI']);
      expect(r.example).not.toHaveProperty('actionId');
      expect(r.example.consignmentId).toBe('CONSIGNMENT-0001');
      expect(r.example.document.documentHeader.channelPriority).toEqual(['EDI']);
      expect(r.notes).toHaveLength(4);
      const e = await served();
      expect(e.map((x) => x.method)).toEqual(['GET']);
      expect(query(e[0]!.url).get('channels')).toBe('EDI');
    });
  });

  describe('validate_invoice', () => {
    const putBodies = async () => (await served()).filter((e) => e.method === 'PUT');
    let fresh: World; // own server: a cold rules cache, so the dry run's rules request is always in the journal
    beforeAll(async () => {
      fresh = await bootWorld(wm);
    });
    afterAll(() => fresh?.close());
    it('200 string-wrapped body -> valid; the dry run is always test=true and carries the agreement', async () => {
      expect(ok(await fresh.call('validate_invoice', { agreement: 'main', consignmentId: 'it-valid-000001', document: doc() }))).toEqual({ valid: true, stage: 'passed', findings: [], moreMayFollow: false });
      const puts = await putBodies();
      expect(puts).toHaveLength(1);
      expect(query(puts[0]!.url).get('test')).toBe('true');
      expect(JSON.parse(puts[0]!.body)).toMatchObject({ consignmentId: 'it-valid-000001', actionId: expect.stringMatching(/^10000000-/) });
      const rules = (await served()).filter((e) => e.url.includes('/rules'));
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((e) => query(e.url).get('templateStandardId') === '0')).toBe(true);
    });
    it('400 header-layer fault -> fixed findings with rule ids, nothing of the vendor wording', async () => {
      const r = ok(await validate('it-header-fault-1'));
      expect(r).toMatchObject({ valid: false, stage: 'dry_run', moreMayFollow: true });
      expect(r.findings.map((f: { path: string; kind: string }) => [f.path, f.kind])).toEqual(expect.arrayContaining([
        ['document.documentHeader.timeStamp', 'required'], ['document.documentHeader.timeStamp', 'pattern'], ['document.documentHeader.channelPriority', 'valid_channels'],
      ]));
      expect(r.findings.every((f: { source: string }) => f.source === 'stralfors')).toBe(true);
      expect(r.findings.find((f: { kind: string }) => f.kind === 'pattern').example).toBe('2021-02-03T04:05:06Z');
      expect(r.findings.map((f: { kind: string }) => f.kind)).toContain('unknown'); // the unheard-of criterion became the fixed unknown text
    });
    it('400 template-layer fault -> findings carry the template tag', async () => {
      const r = ok(await validate('it-template-fault-1'));
      expect(r.stage).toBe('dry_run');
      expect(r.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: '3002', tag: 'Template0', path: 'document.invoice.id', kind: 'required' }),
        expect.objectContaining({ ruleId: '1300', tag: 'Template2', kind: 'valid_items' }),
      ]));
    });
    it('a fault value holding a rule-engine exception sentence is reported as a server error, not echoed', async () => {
      const r = ok(await validate('it-engine-fault-1'));
      expect(r.findings).toEqual([{ source: 'stralfors', ruleId: '3002', tag: 'Template0', path: 'document.invoice.id', kind: 'rule_engine', serverError: true, message: "Stralfors' rule engine failed on this rule; this is not a problem with the document. Report rule 3002 to Stralfors." }]);
      expect(JSON.stringify(r)).not.toMatch(/NullReference|CANARY/);
    });
    it('400 without a compositeFault (field errors) -> shape findings', async () => {
      const r = ok(await validate('it-problem-details-1'));
      expect(r.findings).toEqual([expect.objectContaining({ source: 'stralfors', kind: 'shape', path: 'document.invoice.note' })]);
    });
    it('404 agreement -> the fixed agreement text', async () => {
      expect(errText(await validate('it-valid-000001', { agreement: 'gone' }))).toBe('agreement not found for this profile');
    });
    it('a local finding stops before the dry run', async () => {
      const r = ok(await validate('it-valid-000001', { document: { documentHeader: { channelPriority: ['EDI'] }, invoice: {} } }));
      expect(r.stage).toBe('local');
      expect((await putBodies())).toHaveLength(0);
    });
  });

  describe('track_document', () => {
    it('lists with a cursor, then follows it to the last page; GET only', async () => {
      const p1 = ok(await w.call('track_document', { invoiceNumber: 'INV-LIST-1' }));
      expect(p1).toMatchObject({ profile: 'a', hasMore: true, nextCursor: 'M8I5' });
      expect(p1.documents.map((d: { documentId: string; outcome: string }) => [d.documentId, d.outcome])).toEqual([['M8I4', 'delivered'], ['M8I5', 'in_progress']]);
      expect(p1.documents[0].channels[0]).toMatchObject({ channelId: 9, status: 'Delivered', outcome: 'delivered', deliveryTime: '2030-01-03T00:00:00Z', documents: 1, pages: 2 });
      expect(p1.documents[0].channels[0].comments).toEqual([{ status: 'Delivered', dateTime: '2030-01-02T03:04:05Z', paymentMethod: 'Card' }]);
      const p2 = ok(await w.call('track_document', { invoiceNumber: 'INV-LIST-1', cursor: p1.nextCursor }));
      expect(p2.hasMore).toBe(false);
      expect(p2).not.toHaveProperty('nextCursor');
      expect(p2.documents.map((d: { outcome: string }) => d.outcome)).toEqual(['refused']);
      const e = await served();
      expect(e).toHaveLength(2);
      expect(e.every((x) => x.method === 'GET' && x.url.startsWith('/rest/outputmanagement/tracktrace/v1/'))).toBe(true);
      expect(query(e.find((x) => query(x.url).has('lastDocumentId'))!.url).get('lastDocumentId')).toBe('M8I5');
    });
    it('history of one document keeps known status names and drops free text', async () => {
      const r = ok(await w.call('track_document', { documentId: 'M8I4', history: true }));
      const events = r.documents[0].history.channels[0].deliveryDocuments[0].events;
      expect(events.map((e: { message?: string }) => e.message)).toEqual(['Registered', undefined, 'Delivered', undefined]);
      expect(r.documents[0].outcome).toBe('delivered');
      const e = await served();
      expect(e.map((x) => `${x.method} ${x.url.split('?')[0]}`).sort()).toEqual([
        'GET /rest/outputmanagement/tracktrace/v1/document/M8I4/documentinfohistory',
        'GET /rest/outputmanagement/tracktrace/v1/document/documents',
      ]);
    });
    it('unwraps a string-wrapped body', async () => {
      const r = ok(await w.call('track_document', { extDocumentId: 'ext-wrapped' }));
      expect(r.documents.map((d: { documentId: string }) => d.documentId)).toEqual(['M8I7']);
    });
    it('404 -> "tool failed: not_found"', async () => {
      expect(errText(await w.call('track_document', { invoiceNumber: 'INV-NONE' }))).toBe('tool failed: not_found');
    });
  });
});
