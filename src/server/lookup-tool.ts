import * as z from 'zod/v4';
import { AgreementNotFoundError } from '../stralfors/errors.ts';
import type { StralforsClient } from '../stralfors/index.ts';
import { mapLookup } from '../stralfors/lookup.ts';
import { resolveProfile } from './profile.ts';
import { ToolInputError, type ToolDef } from './tools.ts';

export const STILL_RUNNING = 'lookup still running; try again';
const POLL_MS = 1000;
const MAX_WAIT_MS = 20_000;

// Candidates are personal identifiers: bounded here, never logged, audited, spanned, echoed or put in an error.
export const lookupInput = z.object({
  profile: z.string().min(1).optional(),
  channels: z.array(z.string().regex(/^[A-Za-z0-9]{1,40}$/)).min(1).max(4),
  candidates: z.array(z.string().min(1).max(40)).min(1).max(1000),
});
const channelResult = z.union([z.object({ channel: z.string(), available: z.array(z.boolean()) }), z.object({ channel: z.string(), failed: z.literal(true), reason: z.enum(['not_configured', 'error']) })]);
export const lookupOutput = z.object({ profile: z.string(), results: z.array(channelResult), unrecognised: z.number(), checkedAt: z.string() });

export interface LookupDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'channelLookup' | 'channelLookupResult'>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createChannelLookup(deps: LookupDeps): ToolDef<typeof lookupInput, typeof lookupOutput> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    spec: { name: 'channel_lookup', access: 'lookup' },
    title: 'Channel lookup',
    description: 'TEST only. Checks which lookup channels (for example Kivra) can reach each candidate recipient identifier. Candidates are not stored, logged or returned by this server. Answers are indexed by candidate position: available[i] is true when candidates[i] was matched. A lookup takes seconds; the call waits up to 20 s. A channel that reports an error is returned as failed with a reason: not_configured (the vendor has not set the channel up for this client) or error.',
    inputSchema: lookupInput,
    outputSchema: lookupOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const deadline = now() + MAX_WAIT_MS; // one budget for the whole call, the POST included
      const { correlationId } = await client.channelLookup({ channels: args.channels, candidates: args.candidates });
      for (let answer; ; ) {
        if (now() >= deadline) throw new ToolInputError(STILL_RUNNING);
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
    },
  };
}
