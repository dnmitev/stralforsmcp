import * as z from 'zod/v4';
import { currentSignal, withSignal } from '../stralfors/abort.ts';
import { AgreementNotFoundError, CancelledError } from '../stralfors/errors.ts';
import type { StralforsClient } from '../stralfors/index.ts';
import { lookupRequest } from '../stralfors/operations.ts';
import { mapLookup } from '../stralfors/lookup.ts';
import { resolveProfile } from './profile.ts';
import { ToolInputError, type ToolDef } from './tools.ts';

export const STILL_RUNNING = 'lookup still running; try again';
const POLL_MS = 1000;
const MAX_WAIT_MS = 20_000;

// Candidates are personal identifiers: bounded here, never logged, audited, spanned, echoed or put in an error.
export const lookupInput = lookupRequest.extend({ profile: z.string().min(1).optional() });
const channelResult = z.union([z.object({ channel: z.string(), available: z.array(z.boolean()) }), z.object({ channel: z.string(), failed: z.literal(true), reason: z.enum(['not_configured', 'error']) })]);
export const lookupOutput = z.object({ profile: z.string(), results: z.array(channelResult), unrecognised: z.number(), checkedAt: z.string() });

export interface LookupDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'channelLookup' | 'channelLookupResult'>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Starts the budget timer; returns its cancel. Default setTimeout (unref'd). */
  timer?: (fire: () => void, ms: number) => () => void;
}

export function createChannelLookup(deps: LookupDeps): ToolDef<typeof lookupInput, typeof lookupOutput> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timer = deps.timer ?? ((fire: () => void, ms: number) => { const h = setTimeout(fire, ms); h.unref(); return () => clearTimeout(h); });
  return {
    spec: { name: 'channel_lookup', access: 'lookup' },
    title: 'Channel lookup',
    description: 'TEST only. Checks which lookup channels (for example Kivra) can reach each candidate recipient identifier. Candidates are not stored, logged or returned by this server. Answers are indexed by candidate position: available[i] is true when candidates[i] was matched. A lookup takes seconds; the call waits about 20 s. A channel that reports an error is returned as failed with a reason: not_configured (the vendor has not set the channel up for this client) or error.',
    inputSchema: lookupInput,
    outputSchema: lookupOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const deadline = now() + MAX_WAIT_MS; // one budget for the whole call, the POST included
      // The budget also aborts whatever upstream request is in flight when it runs out, so no request outlives the call.
      const budget = new AbortController();
      const caller = currentSignal();
      const stop = timer(() => budget.abort(), MAX_WAIT_MS);
      try {
        return await withSignal(caller ? AbortSignal.any([caller, budget.signal]) : budget.signal, () => poll(args, profile, client, deadline));
      } catch (e) {
        if (e instanceof CancelledError && budget.signal.aborted && !caller?.aborted) throw new ToolInputError(STILL_RUNNING, 'timeout');
        throw e;
      } finally {
        stop();
      }
    },
  };

  async function poll(args: z.infer<typeof lookupInput>, profile: string, client: Pick<StralforsClient, 'channelLookup' | 'channelLookupResult'>, deadline: number): Promise<z.infer<typeof lookupOutput>> {
      const { correlationId } = await client.channelLookup({ channels: args.channels, candidates: args.candidates });
      for (let answer; ; ) {
        if (now() >= deadline) throw new ToolInputError(STILL_RUNNING, 'timeout');
        try {
          answer = await client.channelLookupResult(correlationId);
        } catch (e) {
          if (!(e instanceof AgreementNotFoundError)) throw e; // the JSON 404 means "not completed (or unknown)": keep polling, never POST again
          await sleep(Math.min(POLL_MS, Math.max(0, deadline - now()))); // never sleep past the budget
          continue;
        }
        const { results, unrecognised } = mapLookup(args.channels, args.candidates, answer.results);
        return { profile, results, unrecognised, checkedAt: new Date(now()).toISOString() };
      }
  }
}
