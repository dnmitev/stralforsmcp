import { ToolInputError } from './tools.ts';

export const PROFILE_REQUIRED = 'profile is required';
export const UNKNOWN_PROFILE = 'unknown profile';
export const AGREEMENT_REQUIRED = 'agreement is required';
export const UNKNOWN_AGREEMENT = 'unknown agreement';

/** The named profile, or the only configured one when none is named. Fixed texts, never the argument value. */
/** The agreement named by label, or the only one when none is named. Fixed texts, never the argument value or an id. */
export function resolveAgreement<A extends { label?: string; id: string }>(agreements: readonly A[], label?: string): A {
  const a = label === undefined ? (agreements.length === 1 ? agreements[0] : undefined) : agreements.find((x) => x.label === label);
  if (!a) throw new ToolInputError(label === undefined ? AGREEMENT_REQUIRED : UNKNOWN_AGREEMENT);
  return a;
}

export function resolveProfile<C>(clients: ReadonlyMap<string, C>, profile?: string): { profile: string; client: C } {
  const id = profile ?? (clients.size === 1 ? [...clients.keys()][0]! : undefined);
  if (id === undefined) throw new ToolInputError(PROFILE_REQUIRED);
  const client = clients.get(id);
  if (!client) throw new ToolInputError(UNKNOWN_PROFILE);
  return { profile: id, client };
}
