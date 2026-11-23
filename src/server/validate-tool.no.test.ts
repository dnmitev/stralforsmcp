/*
 * Norwegian channels (06-01): synthetic rule trees in the vendor's published grammar for AvtaleGiro, WeMailNO and Digipost.
 * Values and paths are made up; they show that the local stage handles NO-shaped rules (arrays, numeric patterns) like any other channel.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { RULES, VALIDATE, doc, rule, validateWorld } from '../../test/helpers/validate.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const NO_RULES = {
  AvtaleGiro: [
    rule('1', 'Document.Invoice.PaymentMeans[].PaymentId', ['Required']),
    rule('2', 'Document.Invoice.PaymentMeans[].PaymentDueDate', ['Required']),
    rule('3', 'Document.Invoice.PartyIdentification[].Id.SchemeId', ['Required', 'ExpectedPattern: ^\\d+$']),
    rule('4', 'Document.Invoice.PayableAmount', ['Required']),
  ],
  WeMailNO: [rule('1', 'Document.Invoice.Id', ['Required'])],
  Digipost: [rule('1', 'Document.Invoice.Subject', ['Required']), rule('2', 'Document.Invoice.DigipostAddress', ['Optional'])],
};
const world = async () => (w = await validateWorld(pki, { rules: NO_RULES }));
const header = { timeStamp: 't' };
const avtaleGiro = (over: Record<string, unknown> = {}) => ({
  paymentMeans: [{ paymentId: '12345678903', paymentDueDate: '2030-01-31' }],
  partyIdentification: [{ id: { value: 'x', schemeId: '0007' } }],
  payableAmount: 10,
  ...over,
});
const paths = (r: { findings: { path?: string }[] }) => r.findings.map((f) => f.path);

describe('06-01 AC-3: Norwegian channels in the local stage', () => {
  it('AvtaleGiro without a PaymentId: field-level finding on that array item, no dry run', async () => {
    const x = await world();
    const r = await x.run({ document: doc(['AvtaleGiro'], avtaleGiro({ paymentMeans: [{ paymentDueDate: '2030-01-31' }] }), header) });
    expect(r).toMatchObject({ valid: false, stage: 'local' });
    expect(paths(r)).toEqual(['document.invoice.paymentMeans[0].paymentId']);
    expect(x.requests(VALIDATE)).toHaveLength(0);
  });
  it('AvtaleGiro with a non-numeric SchemeId: pattern finding carrying the expected pattern', async () => {
    const x = await world();
    const r = await x.run({ document: doc(['AvtaleGiro'], avtaleGiro({ partyIdentification: [{ id: { value: 'x', schemeId: 'GLN' } }] }), header) });
    expect(r).toMatchObject({ valid: false, stage: 'local' });
    expect(r.findings).toEqual([expect.objectContaining({ path: 'document.invoice.partyIdentification[0].id.schemeId', kind: 'pattern', expected: '^\\d+$' })]);
  });
  it('Digipost without a Subject: one finding; the optional DigipostAddress is not one', async () => {
    const x = await world();
    const r = await x.run({ document: doc(['Digipost'], {}, header) });
    expect(r).toMatchObject({ valid: false, stage: 'local' });
    expect(paths(r)).toEqual(['document.invoice.subject']);
  });
  it.each([
    ['AvtaleGiro', avtaleGiro()],
    ['WeMailNO', { id: 'INV-1' }],
  ])('a valid %s invoice has no local finding and goes to the dry run', async (channel, invoice) => {
    const x = await world();
    const r = await x.run({ document: doc([channel], invoice, header) });
    expect(r).toMatchObject({ valid: true, stage: 'passed', findings: [] });
    expect(x.requests(RULES)).toHaveLength(1);
    expect(x.requests(VALIDATE)).toHaveLength(1);
  });
});
