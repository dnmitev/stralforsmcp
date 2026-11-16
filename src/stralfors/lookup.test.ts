import { describe, expect, it } from 'vitest';
import { mapLookup, normalise } from './lookup.ts';

const r = (channel: string, matchedCandidates: string[], error?: string | null) => ({ channel, matchedCandidates, ...(error === undefined ? {} : { error }) });

describe('normalise', () => {
  it.each([['19000101-0001', '190001010001'], [' AbC-12 ', 'abc12'], ['a.b_c d', 'abcd'], ['', ''], ['---', ''], ['ÅÄ1', '1']])('%j -> %j', (a, b) => expect(normalise(a)).toBe(b));
});

describe('mapLookup', () => {
  it('available[i] is true iff the candidate is among the matches, in input order', () => {
    const out = mapLookup(['Kivra'], ['a1', 'b2', 'c3'], [r('Kivra', ['c3', 'a1'], '')]);
    expect(out).toEqual({ results: [{ channel: 'Kivra', available: [true, false, true] }], unrecognised: 0 });
  });
  it('matches regardless of spelling: hyphens, case, spaces on either side', () => {
    const out = mapLookup(['Kivra'], ['1900-0101 0001', 'AB-1'], [r('Kivra', ['190001010001', 'ab1'])]);
    expect(out.results).toEqual([{ channel: 'Kivra', available: [true, true] }]);
  });
  it('duplicates in the input each get the answer', () => {
    expect(mapLookup(['K'], ['a', 'a', 'b'], [r('K', ['a'])]).results).toEqual([{ channel: 'K', available: [true, true, false] }]);
  });
  it('no matches: all false, nothing unrecognised', () => {
    expect(mapLookup(['K'], ['a', 'b'], [r('K', [])])).toEqual({ results: [{ channel: 'K', available: [false, false] }], unrecognised: 0 });
  });
  it('counts matches that map to no input candidate (spelling mismatch signal), not values', () => {
    const out = mapLookup(['K'], ['a'], [r('K', ['a', 'zzz', 'yyy'])]);
    expect(out.unrecognised).toBe(2);
    expect(JSON.stringify(out)).not.toContain('zzz');
  });
  it('sums unrecognised over channels; failed channels do not count', () => {
    const out = mapLookup(['K', 'L', 'M'], ['a'], [r('K', ['x']), r('L', ['y', 'z'], 'boom'), r('M', ['q'])]);
    expect(out.unrecognised).toBe(2);
  });
  it('a non-empty error string makes the channel failed, with no other field', () => {
    const out = mapLookup(['K'], ['a'], [r('K', ['a'], 'something went wrong CANARY-err')]);
    expect(out.results).toEqual([{ channel: 'K', failed: true, reason: 'error' }]);
    expect(JSON.stringify(out)).not.toContain('CANARY');
  });
  it('whitespace-only error, null error and absent error are success', () => {
    for (const e of ['  ', null, undefined, '']) expect(mapLookup(['K'], ['a'], [r('K', ['a'], e)]).results).toEqual([{ channel: 'K', available: [true] }]);
  });
  it('a requested channel missing from the answer is failed; results follow the requested order', () => {
    const out = mapLookup(['B', 'A'], ['a'], [r('A', ['a'])]);
    expect(out.results).toEqual([{ channel: 'B', failed: true, reason: 'error' }, { channel: 'A', available: [true] }]);
  });
  it('channel names match case-insensitively, the requested spelling is reported', () => {
    expect(mapLookup(['Kivra'], ['a'], [r('kivra', ['a'])]).results).toEqual([{ channel: 'Kivra', available: [true] }]);
  });
  it('an upstream channel nobody asked for is ignored (not counted as unrecognised)', () => {
    expect(mapLookup(['K'], ['a'], [r('K', ['a']), r('Other', ['zzz'])])).toEqual({ results: [{ channel: 'K', available: [true] }], unrecognised: 0 });
  });
  it('the first answer per channel wins', () => {
    expect(mapLookup(['K'], ['a'], [r('K', []), r('K', ['a'])]).results).toEqual([{ channel: 'K', available: [false] }]);
  });
  it('a candidate that normalises to empty never matches an empty match', () => {
    expect(mapLookup(['K'], ['---'], [r('K', ['...'])]).results).toEqual([{ channel: 'K', available: [false] }]);
  });
  it('a match that normalises to nothing is unrecognised even when a candidate also normalises to nothing', () => {
    const out = mapLookup(['K'], ['---', 'a'], [r('K', ['...'])]);
    expect(out).toEqual({ results: [{ channel: 'K', available: [false, false] }], unrecognised: 1 });
  });
  it('the vendor sentence "configuration is missing" is reason not_configured, any other error is reason error, neither shows text', () => {
    const out = mapLookup(['A', 'B', 'C'], ['x'], [r('A', [], 'User configuration is missing for this channel.'), r('B', [], 'CANARY-other failure'), r('C', [], '  USER CONFIGURATION IS MISSING FOR THIS CHANNEL  ')]);
    expect(out.results).toEqual([{ channel: 'A', failed: true, reason: 'not_configured' }, { channel: 'B', failed: true, reason: 'error' }, { channel: 'C', failed: true, reason: 'not_configured' }]);
    expect(JSON.stringify(out)).not.toMatch(/CANARY|User configuration/);
  });
});
