/*
 * 06-02 Task 2: send_invoice (ADR 0028). Fake clients only: no network. The client itself (one POST, noReplay, detached) is covered
 * in src/stralfors/send.test.ts; here: policy gate, input rules, per-call profile scope check, outcome mapping and the audit line.
 */
import { describe, expect, it } from 'vitest';
import { Claims } from '../stralfors/token.ts';
import {
  AgreementNotFoundError, AuthError, BadRequestError, BusyError, ConflictError, ResponseTooLargeError, TimeoutError, TlsError, UpstreamError, ValidationFailedError, WriteBlockedError,
} from '../stralfors/errors.ts';
import { principal, sink } from '../../test/helpers/server.ts';
import { createSendInvoice, sendInput, sendOutput } from './send-tool.ts';
import { callTool, type RegistryDeps } from './tools.ts';

const AGREEMENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONSIGNMENT = 'CANARY-CONSIGNMENT-77';
const INVOICE = 'CANARY-INVOICE-9931';
const claims = (scope: string) => new Claims({ scope, exp: 1, aud: 'x' });
const doc = () => ({ documentHeader: { channelPriority: ['WeMailNO'] }, invoice: { id: INVOICE } });

function world(o: { send?: (b: unknown) => Promise<{ ok: true }>; scopes?: Record<string, string | undefined>; profiles?: Record<string, unknown> } = {}) {
  const sent: unknown[] = [];
  const mk = (id: string) => ({
    token: { peek: () => (o.scopes?.[id] === undefined && o.scopes && id in o.scopes ? undefined : claims(o.scopes?.[id] ?? 'apiomni.read apiomni.write')) },
    sendInvoice: async (b: unknown) => { sent.push(b); return (o.send ?? (async () => ({ ok: true as const })))(b); },
  });
  const clients = new Map([['se', mk('se')], ['no', mk('no')]]);
  const config = { env: 'test' as const, profiles: o.profiles ?? {
    se: { id: 'se', agreements: [{ id: OTHER }] },
    no: { id: 'no', agreements: [{ label: 'main', id: AGREEMENT }, { label: 'second', id: OTHER }] },
  } } as never;
  const tool = createSendInvoice({ clients: clients as never, config });
  const s = sink();
  const deps = (over: Partial<RegistryDeps> = {}): RegistryDeps => ({ env: 'test', allowWrite: true, prodValidateEnabled: false, audit: s.audit, claims: claims('apiomni.write'), ...over });
  const call = (args: unknown, over: Partial<RegistryDeps> = {}) => callTool(tool as never, args, principal('dev', ['test', 'prod']), deps(over));
  return { tool, sent, s, call };
}
const args = (over: Record<string, unknown> = {}) => ({ profile: 'no', agreement: 'main', consignmentId: CONSIGNMENT, document: doc(), ...over });
const out = (r: { structuredContent?: unknown }) => sendOutput.parse(r.structuredContent);
const audit = (w: ReturnType<typeof world>) => w.s.lines().map((l) => [l.tool, l.outcome, l.reason]);

describe('AC-1: definition and policy gate', () => {
  it('write access, not read-only, not idempotent, open world; the texts say TEST only and how to retry', () => {
    const { tool } = world();
    expect(tool.spec).toEqual({ name: 'send_invoice', access: 'write' });
    expect(tool.title).toBe('Send invoice (TEST)');
    expect(tool.description).toMatch(/TEST environment for real/);
    expect(tool.description).toMatch(/reuse the same one when you retry/);
    expect(tool.description).toMatch(/never resend with a new consignmentId/);
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });
  it.each([
    ['prod (even with allowWrite)', { env: 'prod' as const, allowWrite: true }, 'write'],
    ['test without STRALFORS_ALLOW_WRITE', { allowWrite: false }, 'write'],
    ['claims without apiomni.write', { claims: claims('apiomni.read') }, 'scope'],
  ])('%s: denied, nothing sent, audited with the deny reason', async (_n, over, reason) => {
    const w = world();
    const r = await w.call(args(), over);
    expect(r).toMatchObject({ isError: true, content: [{ text: `not allowed: ${reason}` }] });
    expect(w.sent).toHaveLength(0);
    expect(audit(w)).toEqual([['send_invoice', 'denied', reason]]);
  });
});

describe('AC-2: input and the per-call profile check', () => {
  it('consignmentId is required, 10..50 characters; both document parts are required', () => {
    expect(sendInput.safeParse(args({ consignmentId: undefined })).success).toBe(false);
    expect(sendInput.safeParse(args({ consignmentId: 'short' })).success).toBe(false);
    expect(sendInput.safeParse(args({ consignmentId: 'x'.repeat(51) })).success).toBe(false);
    expect(sendInput.safeParse(args({ document: { invoice: {} } })).success).toBe(false);
    expect(sendInput.safeParse(args()).success).toBe(true);
  });
  it('the chosen profile token lacks apiomni.write: fixed refusal, nothing sent, even though another profile holds it', async () => {
    const w = world({ scopes: { no: 'apiomni.read' } });
    const r = await w.call(args());
    expect(r).toMatchObject({ isError: true, content: [{ text: 'this profile cannot send' }] });
    expect(w.sent).toHaveLength(0);
    expect(audit(w)).toEqual([['send_invoice', 'error', 'scope']]);
  });
  it('a profile whose token was never fetched cannot send (fail closed)', async () => {
    const w = world({ scopes: { no: undefined } });
    expect(await w.call(args())).toMatchObject({ isError: true, content: [{ text: 'this profile cannot send' }] });
    expect(w.sent).toHaveLength(0);
    expect(audit(w)).toEqual([['send_invoice', 'error', 'scope']]);
  });
  it('profile and agreement are chosen like validate_invoice: same fixed texts', async () => {
    const w = world();
    expect((await w.call(args({ agreement: undefined }))).content).toEqual([{ type: 'text', text: 'agreement is required' }]);
    expect((await w.call(args({ agreement: 'nope' }))).content).toEqual([{ type: 'text', text: 'unknown agreement' }]);
    expect((await w.call(args({ profile: 'zz' }))).content).toEqual([{ type: 'text', text: 'unknown profile' }]);
    expect((await w.call(args({ profile: undefined }))).content).toEqual([{ type: 'text', text: 'profile is required' }]);
    expect(w.sent).toHaveLength(0);
  });
  it('sends the chosen agreement id, the caller consignmentId unchanged and the document as given', async () => {
    const w = world();
    await w.call(args({ agreement: 'second' }));
    expect(w.sent).toEqual([{ actionId: OTHER, consignmentId: CONSIGNMENT, document: doc() }]);
  });
  it('a client profile missing from the config has no agreements: "agreement is required", nothing sent', async () => {
    const w = world({ profiles: { se: { id: 'se', agreements: [{ id: OTHER }] } } });
    expect((await w.call(args({ agreement: undefined }))).content).toEqual([{ type: 'text', text: 'agreement is required' }]);
    expect(w.sent).toHaveLength(0);
  });
});

describe('AC-4: outcomes and audit', () => {
  it('accepted: outcome sent, the caller consignmentId, a track hint; audit allowed/sent', async () => {
    const w = world();
    const r = await w.call(args());
    expect(out(r)).toMatchObject({ outcome: 'sent', consignmentId: CONSIGNMENT, findings: [] });
    expect(out(r).hint).toMatch(/track_document/);
    expect(audit(w)).toEqual([['send_invoice', 'allowed', 'sent']]);
  });
  it('400 with faults: rejected with mapped findings; audit rejected', async () => {
    const w = world({ send: async () => { throw new ValidationFailedError('x', { profile: 'no', operation: 'sendInvoice', violations: [{ ruleId: '7', path: 'Document.Invoice.Id', criteria: ['Required'] }] as never, faults: [] }); } });
    const r = await w.call(args());
    expect(out(r).outcome).toBe('rejected');
    expect(out(r).findings.length).toBeGreaterThan(0);
    expect(audit(w)).toEqual([['send_invoice', 'allowed', 'rejected']]);
  });
  it('409: rejected with the fixed duplicate finding on consignmentId', async () => {
    const w = world({ send: async () => { throw new ConflictError('HTTP 409: conflict', { profile: 'no', operation: 'sendInvoice' }); } });
    const r = await w.call(args());
    expect(out(r)).toMatchObject({ outcome: 'rejected', findings: [{ source: 'stralfors', path: 'consignmentId', kind: 'duplicate' }] });
    expect(out(r).findings[0]!.message).toMatch(/already used with this agreement.*track_document/);
    expect(out(r).hint).toMatch(/already received.*do not send it again/);
    expect(out(r).hint).not.toMatch(/nothing was sent|send again\./);
  });
  it('400 without faults: rejected, mapped field errors (or the fixed fallback finding)', async () => {
    const w = world({ send: async () => { throw new BadRequestError('b', { profile: 'no', operation: 'sendInvoice', errors: { 'document.invoice.id': ['x'] } }); } });
    const r = await w.call(args());
    expect(out(r).outcome).toBe('rejected');
    expect(out(r).findings.length).toBeGreaterThan(0);
    const bare = world({ send: async () => { throw new BadRequestError('b'); } });
    expect(out(await bare.call(args())).findings).toEqual([expect.objectContaining({ kind: 'rejected', path: 'document' })]);
  });
  it.each([
    ['timeout', new TimeoutError('t')],
    ['5xx / network', new UpstreamError('u')],
    ['oversized answer', new ResponseTooLargeError('l')],
    ['TLS reset during the send', new TlsError('r', { profile: 'no', operation: 'sendInvoice' })],
  ])('%s: outcome unknown with the track hint, never "send again"; audit outcome_unknown', async (_n, err) => {
    const w = world({ send: async () => { throw err; } });
    const r = await w.call(args());
    expect(out(r)).toMatchObject({ outcome: 'unknown', consignmentId: CONSIGNMENT, findings: [] });
    expect(out(r).hint).toMatch(/track_document/);
    expect(out(r).hint).toMatch(/same consignmentId/);
    expect(audit(w)).toEqual([['send_invoice', 'allowed', 'outcome_unknown']]);
  });
  it.each([
    ['timeout', new TimeoutError('t', { profile: 'no', operation: 'token' })],
    ['upstream', new UpstreamError('u', { profile: 'no', operation: 'token' })],
    ['too_large', new ResponseTooLargeError('l', { profile: 'no', operation: 'token' })],
    ['tls', new TlsError('s', { profile: 'no', operation: 'token' })],
    // AEGIS F-03-102 / R-49: a token-stage answer that looks like a send outcome must not be read as one (nothing was posted)
    ['conflict', new ConflictError('c', { profile: 'no', operation: 'token' })],
    ['bad_request', new BadRequestError('b', { profile: 'no', operation: 'token' })],
    ['agreement_not_found', new AgreementNotFoundError('n', { profile: 'no', operation: 'token' })],
  ])('the token fetch failed (%s) before any POST: the call fails with its kind, never "unknown"', async (kind, err) => {
    const w = world({ send: async () => { throw err; } });
    expect(await w.call(args())).toMatchObject({ isError: true, content: [{ text: `tool failed: ${kind}` }] });
    expect(audit(w)).toEqual([['send_invoice', 'error', kind]]);
  });
  it.each([
    ['auth', new AuthError('a')],
    ['write_blocked', new WriteBlockedError('w')],
    ['busy', new BusyError('b')],
  ])('nothing was accepted (%s): the call fails with the kind, not an outcome', async (kind, err) => {
    const w = world({ send: async () => { throw err; } });
    const r = await w.call(args());
    expect(r).toMatchObject({ isError: true, content: [{ text: `tool failed: ${kind}` }] });
    expect(audit(w)).toEqual([['send_invoice', 'error', kind]]);
  });
  it('an unknown agreement at the vendor: agreement_not_found refusal', async () => {
    const w = world({ send: async () => { throw new AgreementNotFoundError('n'); } });
    const r = await w.call(args());
    expect(r).toMatchObject({ isError: true, content: [{ text: 'agreement not found for this profile' }] });
    expect(audit(w)).toEqual([['send_invoice', 'error', 'agreement_not_found']]);
  });
  it('the audit line never carries the document, consignmentId, agreement id or invoice number', async () => {
    const w = world();
    await w.call(args());
    for (const v of [CONSIGNMENT, INVOICE, AGREEMENT, 'main']) expect(w.s.text()).not.toContain(v);
  });
});
