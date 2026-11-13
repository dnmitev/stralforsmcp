import { describe, expect, it } from 'vitest';
import { PROFILE_REQUIRED, UNKNOWN_PROFILE, resolveProfile } from './profile.ts';
import { ToolInputError } from './tools.ts';

const one = new Map([['a', 1]]);
const two = new Map([['a', 1], ['b', 2]]);
const thrown = (f: () => unknown) => { try { f(); } catch (e) { return e; } return undefined; };

describe('resolveProfile', () => {
  it('fixed texts', () => expect([PROFILE_REQUIRED, UNKNOWN_PROFILE]).toEqual(['profile is required', 'unknown profile']));
  it('a single profile needs no name', () => expect(resolveProfile(one)).toEqual({ profile: 'a', client: 1 }));
  it('a named profile wins', () => expect(resolveProfile(two, 'b')).toEqual({ profile: 'b', client: 2 }));
  it('several profiles and no name: required', () => {
    const e = thrown(() => resolveProfile(two));
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toBe(PROFILE_REQUIRED);
  });
  it('no profiles and no name: required', () => expect((thrown(() => resolveProfile(new Map())) as Error).message).toBe(PROFILE_REQUIRED));
  it('unknown name: fixed text, never the value', () => {
    const e = thrown(() => resolveProfile(one, 'SECRET-NAME')) as Error;
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e.message).toBe(UNKNOWN_PROFILE);
  });
  it('an empty name is a name, not "absent"', () => expect((thrown(() => resolveProfile(one, '')) as Error).message).toBe(UNKNOWN_PROFILE));
});
