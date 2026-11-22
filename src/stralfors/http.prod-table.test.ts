// R-12: the write guard over every vendor route x verb, with the allowed sets written out literally (not derived from the constants under test).
import { describe, expect, it } from 'vitest';
import { isAllowed } from './http.ts';

const A = '/rest/outputmanagement/apiomni';
const TT = '/rest/outputmanagement/tracktrace/v1/document';
const CL = '/rest/outputmanagement/channellookup/v1/lookup';
const VERBS = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// path (with query) -> verbs that PROD allows without the validate flag
const PROD_GETS = [
  `${A}/v2/apiinfo`, `${A}/v1/manage/health`, `${A}/v2/invoices/channels`, `${A}/v2/invoices/templates`, `${A}/v2/invoices/rules`, `${A}/v2/invoices/document`,
  `${A}/v2/invoices/channels?actionId=x`, `${A}/v2/invoices/rules?channel=EDI&templateStandardId=0`,
  `${TT}/documents`, `${TT}/documents?invoiceNumber=1`, `${TT}/a/documentinfohistory`, `${TT}/Abc123XYZ9/documentinfohistory`,
];
const VALIDATE = `${A}/v2/invoices/validate`;
const ROUTES_NEVER_PROD = [
  VALIDATE, `${A}/v2/invoices`, `${A}/v2/invoices/true`, `${A}/v2/invoices/false`, CL, `${CL}/abc`, `/v1/oidc/token`, `${A}/v1/invoices`, '/', '',
];
const prod = { env: 'prod' as const, allowWrite: false };
const test = { env: 'test' as const, allowWrite: false, prodValidateEnabled: false };

describe('PROD policy, validate flag off', () => {
  const p = { ...prod, prodValidateEnabled: false };
  it.each(PROD_GETS)('GET %s allowed, every other verb denied', (path) => {
    for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(v === 'GET');
  });
  it('method case does not matter', () => {
    expect(isAllowed(p, 'get', PROD_GETS[0]!)).toBe(true);
    expect(isAllowed(p, 'put', `${VALIDATE}?test=true`)).toBe(false);
  });
  it.each(ROUTES_NEVER_PROD)('nothing allowed on %s', (path) => {
    for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(false);
  });
  it.each([`${VALIDATE}?test=true`, `${VALIDATE}?test=false`, VALIDATE])('validate %s denied for every verb', (path) => {
    for (const v of VERBS) expect(isAllowed(p, v, path)).toBe(false);
  });
});

describe('PROD policy, validate flag on', () => {
  const p = { ...prod, prodValidateEnabled: true };
  it('only the exact dry run PUT opens', () => {
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=true`)).toBe(true);
    for (const v of VERBS.filter((x) => x !== 'PUT')) expect(isAllowed(p, v, `${VALIDATE}?test=true`), v).toBe(false);
  });
  it.each([VALIDATE, `${VALIDATE}?test=false`, `${VALIDATE}?test=`, `${VALIDATE}?test=True`, `${VALIDATE}?test=true&test=true`, `${VALIDATE}?test=true&test=false`, `${VALIDATE}?test=false&test=true`, `${VALIDATE}?Test=true`, `${VALIDATE}/?test=true`, `${VALIDATE}x?test=true`, `${A}/v2/invoices/Validate?test=true`])(
    'PUT %s denied',
    (path) => expect(isAllowed(p, 'PUT', path)).toBe(false),
  );
  it('the flag adds nothing besides the dry run', () => {
    for (const path of [...ROUTES_NEVER_PROD.filter((x) => x !== VALIDATE), `${VALIDATE}2`]) for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(false);
    for (const path of PROD_GETS) for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(v === 'GET');
  });
});

describe('PROD near-miss paths are denied', () => {
  const p = { ...prod, prodValidateEnabled: true };
  it.each([
    `${A}/v2/invoices/channels/`, `${A}/v2/invoices/Channels`, `${A}/V2/invoices/channels`, `${A}/v2/invoices/channels/x`, `${A}/v2/apiinfo/x`,
    `${A}/v2/invoices/%63hannels`, `${A}/v2/invoices/channels%2F`, `/${A}/v2/invoices/channels`, `//rest/outputmanagement/apiomni/v2/invoices/channels`,
    `${TT}/documents/`, `${TT}/Abc123XYZ90/documentinfohistory`, `${TT}/a%2Fb/documentinfohistory`, `${TT}/a-b/documentinfohistory`, `${TT}//documentinfohistory`,
    `${TT}/a/documentinfohistory/x`, `${TT}/a/b/documentinfohistory`, `${TT}/a/documentinfohistoryx`,
  ])('GET %s denied', (path) => expect(isAllowed(p, 'GET', path)).toBe(false));
});

describe.each([[true], [false]])('PROD policy with allowWrite forced on (config refuses it; the guard must hold anyway), validate flag %s', (validate) => {
  const p = { env: 'prod' as const, allowWrite: true, prodValidateEnabled: validate };
  it('opens nothing beyond the reads and, only with the flag, the exact dry run', () => {
    for (const path of PROD_GETS) for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(v === 'GET');
    for (const path of ROUTES_NEVER_PROD.filter((x) => x !== VALIDATE)) for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(false);
    expect(isAllowed(p, 'PUT', `${VALIDATE}?test=true`)).toBe(validate);
    for (const path of [VALIDATE, `${VALIDATE}?test=false`]) for (const v of VERBS) expect(isAllowed(p, v, path), `${v} ${path}`).toBe(false);
  });
});

describe('TEST policy', () => {
  it('GET anything under a route, the exact dry run and the exact lookup POST; no other write', () => {
    expect(isAllowed(test, 'GET', `${A}/v2/invoices/anything`)).toBe(true);
    expect(isAllowed(test, 'PUT', `${VALIDATE}?test=true`)).toBe(true);
    expect(isAllowed(test, 'POST', CL)).toBe(true);
    for (const [v, path] of [
      ['PUT', `${VALIDATE}?test=false`], ['PUT', VALIDATE], ['PUT', `${VALIDATE}?test=true&test=false`], ['POST', `${CL}?x=1`], ['POST', `${CL}/`], ['POST', `${CL}/abc`], ['PUT', CL],
      ['POST', `${A}/v2/invoices/true`], ['POST', `${A}/v2/invoices/false`], ['DELETE', `${A}/v2/invoices/channels`], ['PATCH', CL], ['HEAD', CL],
    ] as const) expect(isAllowed(test, v, path), `${v} ${path}`).toBe(false);
  });
  it('allowWrite opens exactly POST to the send route on test, nothing else', () => {
    const w = { env: 'test' as const, allowWrite: true, prodValidateEnabled: false };
    const SEND = `${A}/v2/invoices/true`;
    expect(isAllowed(w, 'POST', SEND)).toBe(true);
    expect(isAllowed(w, 'post', SEND)).toBe(true); // method is case-insensitive, like every other rule
    expect(isAllowed(test, 'POST', SEND)).toBe(false); // flag off: refused
    for (const v of VERBS.filter((x) => x !== 'POST' && x !== 'GET')) expect(isAllowed(w, v, SEND), v).toBe(false);
    for (const path of [
      `${SEND}?x=1`, `${SEND}/`, `${SEND}/x`, `${A}/v2/invoices/false`, `${A}/v2/invoices/%74rue`, `${A}/v2/invoices`, `${A}/v2/invoices/true;x`,
      `${A}/v1/invoices/true`, `${A}/v2/invoices/../invoices/channels`, '/rest/outputmanagement/tracktrace/v1/document/documents', '/rest/anything',
    ]) expect(isAllowed(w, 'POST', path), path).toBe(false);
    for (const [v, path] of [['DELETE', '/rest/anything'], ['PATCH', SEND], ['PUT', `${A}/v2/invoices/validate`]] as const) expect(isAllowed(w, v, path), `${v} ${path}`).toBe(false);
  });
});
