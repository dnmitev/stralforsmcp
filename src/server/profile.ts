import { ToolInputError } from './tools.ts';

export const PROFILE_REQUIRED = 'profile is required';
export const UNKNOWN_PROFILE = 'unknown profile';

/** The named profile, or the only configured one when none is named. Fixed texts, never the argument value. */
export function resolveProfile<C>(clients: ReadonlyMap<string, C>, profile?: string): { profile: string; client: C } {
  const id = profile ?? (clients.size === 1 ? [...clients.keys()][0]! : undefined);
  if (id === undefined) throw new ToolInputError(PROFILE_REQUIRED);
  const client = clients.get(id);
  if (!client) throw new ToolInputError(UNKNOWN_PROFILE);
  return { profile: id, client };
}
