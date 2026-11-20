/*
 * 05-04a Task 1 (AEGIS R-01): the dry run is only authoritative if the response proves it was one.
 * PROD requires isTest === true; any env refuses isTest === false; the response is never echoed. Synthetic data only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { json } from '../../test/helpers/api.ts';
import { generatePki, type Pki } from '../../test/helpers/mtls.ts';
import { VALIDATE, doc, validateWorld } from '../../test/helpers/validate.ts';
import { StralforsError } from '../stralfors/errors.ts';

let pki: Pki;
let w: Awaited<ReturnType<typeof validateWorld>> | undefined;
beforeAll(() => void (pki = generatePki()));
afterAll(() => pki.cleanup());
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const PROD = { STRALFORS_ENV: 'prod', STRALFORS_PROD_VALIDATE_ENABLED: 'true' };
const world = async (env?: Record<string, string>) => (w = await validateWorld(pki, { env }));
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const GUID = 'GUID-CANARY-5678';

describe.each([
  ['prod', PROD],
  ['test', undefined],
] as const)('env %s: explicit isTest false is refused', (_name, env) => {
  it('throws a fixed-text StralforsError, never valid true, nothing of the response in the message', async () => {
    const x = await world(env);
    x.routes[VALIDATE] = (_q, res) => json(res, 200, JSON.stringify({ isTest: false, guid: GUID, document: doc() }));
    const e = await rejection(x.run({ document: doc() }));
    expect(e).toBeInstanceOf(StralforsError);
    expect((e as StralforsError).message).toBe('validate response did not confirm a dry run');
    expect(JSON.stringify(e)).not.toContain(GUID);
  });
});

describe('env prod: only isTest true proves a dry run', () => {
  it.each([
    ['empty body', ''],
    ['no isTest key', JSON.stringify({ guid: GUID })],
  ])('%s: refused', async (_n, body) => {
    const x = await world(PROD);
    x.routes[VALIDATE] = (_q, res) => json(res, 200, body);
    const e = await rejection(x.run({ document: doc() }));
    expect(e).toBeInstanceOf(StralforsError);
    expect((e as StralforsError).message).toBe('validate response did not confirm a dry run');
  });
  it('isTest as a string fails the client schema: refused as well', async () => {
    const x = await world(PROD);
    x.routes[VALIDATE] = (_q, res) => json(res, 200, JSON.stringify({ isTest: 'true' }));
    expect(await rejection(x.run({ document: doc() }))).toBeInstanceOf(StralforsError);
  });
  it('isTest true: valid after a clean dry run, no guid in the output', async () => {
    const x = await world(PROD);
    x.routes[VALIDATE] = (_q, res) => json(res, 200, JSON.stringify({ isTest: true, guid: GUID, document: doc() }));
    const r = await x.run({ document: doc() });
    expect(r).toMatchObject({ valid: true, stage: 'passed', findings: [], moreMayFollow: false });
    expect(JSON.stringify(r)).not.toContain(GUID);
  });
});

describe('env test: unchanged for empty and true answers', () => {
  it.each([['empty body', ''], ['isTest true', JSON.stringify({ isTest: true })], ['no isTest key', JSON.stringify({ guid: GUID })]])('%s: valid', async (_n, body) => {
    const x = await world();
    x.routes[VALIDATE] = (_q, res) => json(res, 200, body);
    expect(await x.run({ document: doc() })).toMatchObject({ valid: true, stage: 'passed' });
  });
});

describe('annotations follow the risk', () => {
  it('prod: readOnlyHint false, the rest unchanged', async () => {
    expect((await world(PROD)).tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
  it('test: readOnlyHint true', async () => {
    expect((await world()).tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
});
