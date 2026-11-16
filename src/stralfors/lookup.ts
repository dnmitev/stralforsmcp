/** Pure: turns the vendor's matched-only Channel Lookup answer into one boolean per input candidate. No I/O; nothing observed leaves except booleans and counts. */

export interface LookupAnswer { channel: string; matchedCandidates: readonly string[]; error?: string | null | undefined }
/** `not_configured`: the vendor says the channel is not set up for this client (a known, stable sentence). `error`: any other failure. The vendor text itself is never returned. */
export type FailReason = 'not_configured' | 'error';
export type LookupChannelResult = { channel: string; available: boolean[] } | { channel: string; failed: true; reason: FailReason };

const NOT_CONFIGURED = /configuration is missing/i;

/** Spelling-insensitive key: letters and digits only, lower-case (ASCII). An empty key never matches. */
export const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function mapLookup(channels: readonly string[], candidates: readonly string[], answers: readonly LookupAnswer[]): { results: LookupChannelResult[]; unrecognised: number } {
  const byName = new Map<string, LookupAnswer>();
  for (const a of answers) if (!byName.has(a.channel.toLowerCase())) byName.set(a.channel.toLowerCase(), a);
  const keys = candidates.map(normalise);
  const known = new Set(keys.filter((k) => k !== ''));
  let unrecognised = 0;
  const results = channels.map((channel): LookupChannelResult => {
    const a = byName.get(channel.toLowerCase());
    if (!a) return { channel, failed: true, reason: 'error' };
    const error = (a.error ?? '').trim();
    if (error !== '') return { channel, failed: true, reason: NOT_CONFIGURED.test(error) ? 'not_configured' : 'error' };
    const matched = new Set(a.matchedCandidates.map(normalise));
    for (const m of matched) if (!known.has(m)) unrecognised++;
    return { channel, available: keys.map((k) => k !== '' && matched.has(k)) };
  });
  return { results, unrecognised };
}
