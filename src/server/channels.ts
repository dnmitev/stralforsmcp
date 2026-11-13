import * as z from 'zod/v4';
import type { Config, StralforsClient } from '../stralfors/index.ts';
import { PROFILE_REQUIRED, UNKNOWN_PROFILE, resolveProfile } from './profile.ts';
import { ToolInputError, type ToolDef } from './tools.ts';

export { PROFILE_REQUIRED, UNKNOWN_PROFILE };

export const listChannelsInput = z.object({
  profile: z.string().min(1).optional(),
  agreement: z.string().min(1).optional(), // agreement LABEL, never an id
});
export const listChannelsOutput = z.object({
  profile: z.string(),
  channels: z.array(z.string()),
});
export const AGREEMENT_REQUIRED = 'agreement is required';
export const UNKNOWN_AGREEMENT = 'unknown agreement';

export interface ChannelsDeps {
  clients: ReadonlyMap<string, Pick<StralforsClient, 'channels'>>;
  config: Pick<Config, 'profiles'>;
}

export function createListChannels(deps: ChannelsDeps): ToolDef<typeof listChannelsInput, typeof listChannelsOutput> {
  return {
    spec: { name: 'list_channels', access: 'read' },
    title: 'List channels',
    description: 'Lists the delivery channels of a Stralfors profile, optionally narrowed to one agreement by its label.',
    inputSchema: listChannelsInput,
    outputSchema: listChannelsOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const { profile, client } = resolveProfile(deps.clients, args.profile);
      const actionId = args.agreement === undefined ? undefined : deps.config.profiles[profile]?.agreements.find((a) => a.label === args.agreement)?.id;
      if (args.agreement !== undefined && actionId === undefined) throw new ToolInputError(UNKNOWN_AGREEMENT);
      return { profile, channels: await client.channels(actionId) };
    },
  };
}
