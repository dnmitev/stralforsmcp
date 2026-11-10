/*
 * R6 typed operations. API under test:
 *   index.ts client methods (all go through the HTTP core, so guards/auth/errors apply):
 *     apiInfo(), healthV1(), channels(actionId?: string): Promise<string[]>, templates(),
 *     rules(channel: string, opts?: { templateStandardId?: number (default 0, ALWAYS sent);
 *                                     emailTemplateStandardId?: number; required?: boolean }),
 *     documentExample(opts: { channels: string | string[] (comma-joined); defaultChannel?: string; templateStandardId?: number }),
 *     validateInvoice(body: { actionId: string(uuid); consignmentId: string(10..50); document: {documentHeader; invoice} }):
 *         Promise<{ ok: true; guid?: string; isTest?: boolean; document?: object }>
 *         - always PUT .../v2/invoices/validate?test=true; no way to send test=false
 *         - local request check throws RequestValidationError (fields: ['actionId'|'consignmentId']) before any I/O
 *         - 200 body is a JSON string -> parsed; 204/empty -> { ok: true }
 *   operations.ts exports: schemas (lenient: extra keys kept), `rulesResponseSchema` (zod, recursive Rule),
 *     `isKnownChannel(s: string): boolean`, `KnownChannel` (the 10 observed values).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgreementNotFoundError, RequestValidationError, ValidationFailedError, mapHttpError } from './errors.ts';
import { isKnownChannel, rulesResponseSchema } from './operations.ts';
import { canary, fixture, fixtureJson, json, startFakeApi, testClient, type FakeApi } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';

let pki: Pki;
let fake: FakeApi | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const B = '/rest/outputmanagement/apiomni';
const V = `${B}/v2/invoices`;
const serve = (path: string, body: string) =>
  startFakeApi({ pki, api: (req, res) => (req.url!.split('?')[0] === path ? json(res, 200, body) : json(res, 404, 'No Mapping Rule matched', 'text/plain')) });
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const validBody = () => ({ actionId: randomUUID(), consignmentId: 'CONSIGNMENT-0001', document: { documentHeader: {}, invoice: {} } });

describe('R6 fixture parses', () => {
  const cases: [string, string, string, (c: ReturnType<typeof testClient>['client']) => Promise<unknown>, string?][] = [
    ['apiInfo', `${B}/v2/apiinfo`, 'apiinfo.json', (c) => c.apiInfo()],
    ['healthV1', `${B}/v1/manage/health`, 'health-v1.json', (c) => c.healthV1()],
    ['channels', `${V}/channels`, 'channels.json', (c) => c.channels()],
    ['templates', `${V}/templates`, 'templates.json', (c) => c.templates()],
    ['rules(eBrevWeMail)', `${V}/rules`, 'rules-ebrevwemail.json', (c) => c.rules('eBrevWeMail')],
    ['documentExample', `${V}/document`, 'document-edi.json', (c) => c.documentExample({ channels: 'EDI' })],
    ['documentExample (JSON string)', `${V}/document`, 'document-edi.json', (c) => c.documentExample({ channels: 'EDI' }), 'string'],
  ];
  it.each(cases)('%s', async (_op, path, file, call, mode) => {
    const text = fixture(file);
    fake = await serve(path, mode === 'string' ? JSON.stringify(JSON.stringify(JSON.parse(text))) : text);
    const { client } = testClient(pki, fake);
    await expect(call(client)).resolves.toEqual(fixtureJson(file));
  });

  it('rules sends channel and templateStandardId (default 0)', async () => {
    fake = await serve(`${V}/rules`, fixture('rules-ebrevwemail.json'));
    const { client } = testClient(pki, fake);
    await client.rules('eBrevWeMail');
    await client.rules('EDI', { templateStandardId: 3, emailTemplateStandardId: 1 });
    const urls = fake.apiRequests.map((r) => new URL(r.url, 'https://x'));
    expect(urls[0]!.searchParams.get('channel')).toBe('eBrevWeMail');
    expect(urls[0]!.searchParams.get('templateStandardId')).toBe('0');
    expect(urls[1]!.searchParams.get('templateStandardId')).toBe('3');
    expect(urls[1]!.searchParams.get('emailTemplateStandardId')).toBe('1');
  });

  it('documentExample sends channels', async () => {
    fake = await serve(`${V}/document`, fixture('document-edi.json'));
    const { client } = testClient(pki, fake);
    await client.documentExample({ channels: ['EDI', 'eMail'] });
    expect(new URL(fake.apiRequests[0]!.url, 'https://x').searchParams.get('channels')).toBe('EDI,eMail');
  });
});

describe('R6 schemas', () => {
  it('rules tree with one dependency level', () => {
    const leaf = {
      id: '227', tag: 'EBrevWeMail', parameter: 'Document.X', isRequired: false, isOptional: true, ruleCriterias: null,
      expectedPattern: null, exampleValue: null, hasDependencies: false, dependencyOperator: null, dependencies: [],
    };
    const parent = { ...leaf, id: '226', hasDependencies: true, dependencyOperator: 'AnyRequired', dependencies: [leaf], extraKey: 1 };
    const parsed = rulesResponseSchema.parse({ channel: 'eBrevWeMail', templateStandardId: null, emailTemplateStandardId: null, rules: [parent] });
    expect(parsed.rules[0]!.dependencies[0]!.dependencies).toEqual([]);
    expect(parsed.rules[0]!.dependencyOperator).toBe('AnyRequired');
    expect(parsed.rules[0]!.dependencies[0]!.ruleCriterias ?? []).toEqual([]);
  });

  it('isKnownChannel', () => {
    for (const c of ['AvtaleGiro', 'Custom', 'Digipost', 'eBrevWeMail', 'EDI', 'eInvoice', 'eMail', 'Kivra', 'SMS', 'WeMailNO']) {
      expect(isKnownChannel(c)).toBe(true);
    }
    expect(isKnownChannel('FutureChannel')).toBe(false);
  });
});

describe('R6 channels and validate behaviour', () => {
  it('unknown channel value survives', async () => {
    fake = await serve(`${V}/channels`, JSON.stringify(['eBrevWeMail', 'FutureChannel']));
    const { client } = testClient(pki, fake);
    const result = await client.channels();
    expect(result).toEqual(['eBrevWeMail', 'FutureChannel']);
    expect(isKnownChannel('FutureChannel')).toBe(false);
  });

  it('channels(actionId) sends the agreement id as query', async () => {
    const g = randomUUID();
    fake = await serve(`${V}/channels`, fixture('channels.json'));
    const { client } = testClient(pki, fake);
    await client.channels(g);
    expect(fake.apiRequests[0]!.url).toBe(`${V}/channels?actionId=${g}`);
  });

  it('validate request is checked before sending', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => { res.writeHead(204); res.end(); } });
    const { client } = testClient(pki, fake);
    const { actionId: _drop, ...noAction } = validBody();
    const e1 = await rejection(client.validateInvoice(noAction as never));
    expect(e1).toBeInstanceOf(RequestValidationError);
    expect((e1 as RequestValidationError).message).toContain('actionId');
    const e2 = await rejection(client.validateInvoice({ ...validBody(), consignmentId: 'short' }));
    expect(e2).toBeInstanceOf(RequestValidationError);
    expect((e2 as RequestValidationError).message).toContain('consignmentId');
    const e3 = await rejection(client.validateInvoice({ ...validBody(), consignmentId: 'x'.repeat(51) }));
    expect(e3).toBeInstanceOf(RequestValidationError);
    expect(fake.requests).toHaveLength(0);
    await expect(client.validateInvoice({ ...validBody(), consignmentId: 'x'.repeat(10) })).resolves.toMatchObject({ ok: true });
    await expect(client.validateInvoice({ ...validBody(), consignmentId: 'x'.repeat(50) })).resolves.toMatchObject({ ok: true });
  });

  it('validate always sends test=true as PUT with the body', async () => {
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 204, '') });
    const { client } = testClient(pki, fake);
    const body = validBody();
    await client.validateInvoice(body);
    const r = fake.apiRequests[0]!;
    expect([r.method, r.url]).toEqual(['PUT', `${V}/validate?test=true`]);
    expect(JSON.parse(r.body)).toEqual(body);
  });

  it('validate 404 maps to agreement-not-found', async () => {
    const identity = canary('IDENT');
    const g = randomUUID();
    const msg = `ValidateInvoice | DtoGuid: ${randomUUID()} | CustomerContract was not found based on identityId '${identity}' and ActionId '${g}'.`;
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 404, { message: msg, compositeFault: null }) });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.validateInvoice({ ...validBody(), actionId: g }));
    expect(err).toBeInstanceOf(AgreementNotFoundError);
    expect([(err as AgreementNotFoundError).status, (err as AgreementNotFoundError).actionId]).toEqual([404, g]);
    expect((err as Error).message).not.toContain(identity);
    expect((err as AgreementNotFoundError).message).not.toContain(identity);
  });

  it('validate 400 with faults (live shape)', async () => {
    const dto = randomUUID();
    const body = {
      message: `ValidateInvoice | DtoGuid: ${dto} | CreateInvoiceDto: Document is not valid.`,
      compositeFault: {
        faults: [{
          faultCode: null, explanationText: `ValidateInvoice | DtoGuid: ${dto} | CreateInvoiceDto: Document is not valid.`,
          paramValues: [
            { param: '#2:Document.DocumentHeader.TimeStamp', value: 'Required | ExpectedPattern: ^x$ | ExampleValue: 2021-02-03T04:05:06Z' },
            { param: '#105:Template0:Document.Invoice.AdditionalDocumentReference[].Id.Value', value: 'Required | ArrayWithValidItemsExpected' },
          ],
        }],
      },
    };
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 400, body) });
    const { client } = testClient(pki, fake);
    const err = await rejection(client.validateInvoice(validBody()));
    expect(err).toBeInstanceOf(ValidationFailedError);
    const e = err as ValidationFailedError;
    expect(e.violations).toEqual([
      { ruleId: '2', tag: undefined, path: 'Document.DocumentHeader.TimeStamp', criteria: ['Required', 'ExpectedPattern: ^x$', 'ExampleValue: 2021-02-03T04:05:06Z'] },
      { ruleId: '105', tag: 'Template0', path: 'Document.Invoice.AdditionalDocumentReference[].Id.Value', criteria: ['Required', 'ArrayWithValidItemsExpected'] },
    ]);
    expect(e.message).not.toContain(dto);
    expect(e.message).not.toContain(dto);
  });

  it('validate 400 fixture keeps ", " inside one criterion', () => {
    const e = mapHttpError({ status: 400, contentType: 'application/json', body: fixture('error-errorresponse-400-faults.json') }, { profile: 'a', operation: 'validate' }) as ValidationFailedError;
    expect(e.violations.map((v) => v.ruleId)).toEqual(['2', '3']);
    expect(e.violations[1]!.criteria).toContain('ValidChannels: eBrevWeMail, EDI');
    expect(e.violations[1]!.path).toBe('Document.DocumentHeader.ChannelPriority');
  });

  it('validate 400 with spec shape (string paramValues)', () => {
    const body = JSON.stringify({ message: 'm', compositeFault: { faults: [{ faultCode: 'F1', explanationText: 'e', paramValues: ['Document.Invoice.Id'] }] } });
    const e = mapHttpError({ status: 400, contentType: 'application/json', body }, { profile: 'a', operation: 'validate' }) as ValidationFailedError;
    expect(e.violations).toEqual([{ ruleId: undefined, path: 'Document.Invoice.Id', criteria: [] }]);
    expect((e.faults[0] as { faultCode: string }).faultCode).toBe('F1');
  });

  it('engine exception inside a value is flagged', () => {
    const exc = "Unexpected error occurred when rule was validated: Value cannot be null. (Parameter 'source')";
    const body = JSON.stringify({
      message: 'm',
      compositeFault: { faults: [{ faultCode: null, explanationText: 'e', paramValues: [{ param: '#7:Document.Invoice.Id', value: `Required | ${exc}` }] }] },
    });
    const e = mapHttpError({ status: 400, contentType: 'application/json', body }, { profile: 'a', operation: 'validate' }) as ValidationFailedError;
    expect(e.violations[0]!.serverError).toBe(true);
    expect(e.violations[0]!.criteria).toEqual(['Required']);
    expect(JSON.stringify(e.violations)).not.toContain('Unexpected error');
  });

  it('validate 200 echo', async () => {
    const guid = randomUUID();
    const action = randomUUID();
    const echo = JSON.stringify({ isTest: true, guid, actionId: action, document: {} });
    fake = await startFakeApi({ pki, api: (_q, res) => json(res, 200, JSON.stringify(echo)) });
    const { client } = testClient(pki, fake);
    await expect(client.validateInvoice(validBody())).resolves.toEqual({ ok: true, guid, isTest: true, document: {} });
    await fake.close();
    fake = await startFakeApi({ pki, api: (_q, res) => { res.writeHead(204); res.end(); } });
    const again = testClient(pki, fake);
    await expect(again.client.validateInvoice(validBody())).resolves.toEqual({ ok: true });
  });
});
