// Fixtures for validate_invoice: routes-based fake API (rules + validate), synthetic rule trees, one world per test. Additive to boot.ts.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, startFakeApi } from './api.ts';
import { INVOICES, loadConfig, realClients, twoProfiles } from './boot.ts';
import type { Pki } from './mtls.ts';
import { principal, sink } from './server.ts';
import { createRulesCache, type RulesCache } from '../../src/server/rules-cache.ts';
import { callTool, type ToolContext } from '../../src/server/tools.ts';
import { createValidateInvoice } from '../../src/server/validate-tool.ts';

export const RULES = `${INVOICES}/rules`;
export const VALIDATE = `${INVOICES}/validate`;
type Reply = (req: IncomingMessage, res: ServerResponse) => void;

export const ctx = (): ToolContext => ({ principal: principal('dev', ['test']), env: 'test', allowWrite: false, prodValidateEnabled: false, visible: [] });
export const rule = (id: string, parameter: string, criteria: string[], extra: Record<string, unknown> = {}) => ({ id, parameter, isRequired: criteria.includes('Required'), ruleCriterias: criteria, dependencies: [], ...extra });
export const doc = (channels: unknown = ['X'], invoice: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => ({ documentHeader: { channelPriority: channels, ...header }, invoice });
export const queryOf = (url: string) => new URL(url, 'https://x').searchParams;
export const fault = (...pv: { param: string; value: string }[]) => ({ compositeFault: { faults: [{ paramValues: pv, explanationText: 'EXPLAIN-CANARY', message: 'FAULT-MESSAGE-CANARY' }] } });
export const deepFreeze = <T>(o: T): T => {
  if (typeof o === 'object' && o !== null) for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
};

export interface WorldOpts {
  /** rules per channel name; unknown channels answer an empty rule list */
  rules?: Record<string, unknown[]>;
  /** extra env (undefined removes) */
  env?: Record<string, string | undefined>;
  serverCert?: 'trusted' | 'selfSigned';
  cache?: RulesCache;
  uuid?: () => string;
}
/** Profile "b" (single agreement "letters") is the default profile; "a" has two agreements. Validate answers 200 with an empty body unless a route says otherwise. */
export async function validateWorld(pki: Pki, o: WorldOpts = {}) {
  const routes: Record<string, Reply> = {
    [RULES]: (req, res) => json(res, 200, { channel: 'X', rules: o.rules?.[queryOf(req.url!).get('channel') ?? ''] ?? [] }),
    [VALIDATE]: (_q, res) => json(res, 200, ''),
  };
  const fake = await startFakeApi({ pki, serverCert: o.serverCert, api: (req, res) => (routes[req.url!.split('?')[0]!] ?? ((_q, s) => json(s, 404, 'No Mapping Rule matched', 'text/plain')))(req, res) });
  const tp = twoProfiles(pki, o.env);
  const config = loadConfig(tp.env);
  const all = realClients(pki, fake, config);
  const cache = o.cache ?? createRulesCache({ ttlMs: 3_600_000 });
  const mk = (clients: Parameters<typeof createValidateInvoice>[0]['clients']) => createValidateInvoice({ clients, config, cache, uuid: o.uuid });
  const tool = mk(all);
  const only = mk(new Map([['b', all.get('b')!]]));
  type Args = Parameters<typeof tool.run>[0];
  const requests = (path: string) => fake.apiRequests.filter((x) => x.url.split('?')[0] === path);
  const audit = sink();
  return {
    ...tp, config, clients: all, fake, routes, cache, tool, requests, audit,
    /** run on profile b alone (no profile argument needed) */
    run: (args: Args) => only.run(args, ctx()),
    /** through the registry wrapper: sanitised text + audit line */
    call: (args: Args, t = tool) => callTool(t as never, args, principal('dev', ['test']), { env: 'test', allowWrite: false, prodValidateEnabled: false, audit: audit.audit }),
    callOnly: (args: Args) => callTool(only as never, args, principal('dev', ['test']), { env: 'test', allowWrite: false, prodValidateEnabled: false, audit: audit.audit }),
    bodies: () => requests(VALIDATE).map((r) => JSON.parse(r.body) as { actionId: string; consignmentId: string; document: unknown }),
    close: async () => {
      try {
        await Promise.allSettled([...all.values()].map((c) => c.close())); // a test may already have closed a client
      } finally {
        await fake.close();
      }
    },
  };
}
export const randomId = randomUUID;
