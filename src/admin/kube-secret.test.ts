import { describe, expect, it } from 'vitest';
import { InputError } from './token-list.ts';
import { LAST_APPLIED, readSecret, secretManifest } from './kube-secret.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const LIST = '{"users":[],"tokens":[]}\n';

const get = (over: Record<string, unknown> = {}) => JSON.stringify({
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: {
    name: 's', namespace: 'ns', resourceVersion: '42', uid: 'u', creationTimestamp: 't',
    labels: { app: 'x' },
    annotations: { [LAST_APPLIED]: '{"data":{"token-list.json":"secret"}}', note: 'keep' },
    managedFields: [{}],
  },
  data: { 'token-list.json': b64(LIST), other: b64('o') },
  ...over,
});

describe('readSecret', () => {
  it('decodes the key and keeps what a write must preserve', () => {
    const r = readSecret(get(), 'token-list.json');
    expect(r.text).toBe(LIST);
    expect(r.meta).toEqual({ resourceVersion: '42', labels: { app: 'x' }, annotations: { [LAST_APPLIED]: expect.any(String), note: 'keep' }, type: 'Opaque', otherData: { other: b64('o') } });
  });

  it('returns null text when the key is absent', () => {
    expect(readSecret(get({ data: { other: b64('o') } }), 'token-list.json').text).toBeNull();
    expect(readSecret(get({ data: undefined }), 'token-list.json').text).toBeNull();
  });

  it('refuses malformed output and non-Opaque Secrets without echoing content', () => {
    expect(() => readSecret('not json', 'k')).toThrow(InputError);
    expect(() => readSecret('not json', 'k')).toThrow('kubectl returned something that is not a Secret');
    expect(() => readSecret(JSON.stringify({ kind: 'ConfigMap' }), 'k')).toThrow('kubectl returned something that is not a Secret');
    expect(() => readSecret(get({ type: 'kubernetes.io/tls' }), 'k')).toThrow('the Secret has type kubernetes.io/tls; only Opaque is supported');
  });
});

describe('secretManifest', () => {
  it('replace: keeps resourceVersion, labels, other annotations and keys; drops the last-applied copy', () => {
    const { meta } = readSecret(get(), 'token-list.json');
    const m = JSON.parse(secretManifest('ns', 's', 'token-list.json', 'NEW', meta));
    expect(m).toEqual({
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: 's', namespace: 'ns', resourceVersion: '42', labels: { app: 'x' }, annotations: { note: 'keep' } },
      data: { other: b64('o'), 'token-list.json': b64('NEW') },
    });
  });

  it('create: no resourceVersion, only the key', () => {
    expect(JSON.parse(secretManifest('ns', 's', 'k', 'X', null))).toEqual({
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 's', namespace: 'ns' }, data: { k: b64('X') },
    });
  });

  it('keeps ownerReferences and finalizers set by an operator', () => {
    const owner = [{ apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret', name: 'e', uid: '1', controller: true }];
    const { meta } = readSecret(get({ metadata: { resourceVersion: '7', ownerReferences: owner, finalizers: ['f/1'] } }), 'k');
    expect(JSON.parse(secretManifest('ns', 's', 'k', 'X', meta)).metadata).toEqual({ name: 's', namespace: 'ns', resourceVersion: '7', ownerReferences: owner, finalizers: ['f/1'] });
    expect(readSecret(get(), 'k').meta).not.toHaveProperty('ownerReferences');
  });

  it('omits empty labels and annotations', () => {
    const { meta } = readSecret(get({ metadata: { resourceVersion: '1', annotations: { [LAST_APPLIED]: 'x' } } }), 'k');
    expect(JSON.parse(secretManifest('ns', 's', 'k', 'X', meta)).metadata).toEqual({ name: 's', namespace: 'ns', resourceVersion: '1' });
  });
});
