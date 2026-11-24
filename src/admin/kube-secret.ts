// Kubernetes Secret helpers for `npm run token --kube-*`: parse `kubectl get secret -o json`, build the manifest
// for `kubectl replace` / `kubectl create`. Pure: kubectl itself runs in scripts/token.ts.
import { InputError } from './token-list.ts';

/** Written by `kubectl apply`; it repeats the whole data, so the tool never writes it back. */
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

export interface SecretMeta {
  resourceVersion: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  type: string;
  otherData: Record<string, string>;
}

interface Raw {
  kind?: unknown;
  type?: unknown;
  metadata?: { resourceVersion?: unknown; labels?: Record<string, string>; annotations?: Record<string, string> };
  data?: Record<string, string>;
}

/** `text` is the decoded key, or null when the Secret has no such key. Errors never quote the output. */
export function readSecret(json: string, key: string): { text: string | null; meta: SecretMeta } {
  let r: Raw;
  try {
    r = JSON.parse(json) as Raw;
  } catch {
    throw new InputError('kubectl returned something that is not a Secret');
  }
  if (r?.kind !== 'Secret' || typeof r.metadata?.resourceVersion !== 'string') throw new InputError('kubectl returned something that is not a Secret');
  const type = typeof r.type === 'string' ? r.type : 'Opaque';
  if (type !== 'Opaque') throw new InputError(`the Secret has type ${type}; only Opaque is supported`);
  const { [key]: value, ...otherData } = r.data ?? {};
  return {
    text: value === undefined ? null : Buffer.from(value, 'base64').toString('utf8'),
    meta: { resourceVersion: r.metadata.resourceVersion, labels: { ...r.metadata.labels }, annotations: { ...r.metadata.annotations }, type, otherData },
  };
}

/** Manifest for `kubectl replace -f -` (meta given: optimistic concurrency on resourceVersion) or `kubectl create -f -` (meta null). */
export function secretManifest(ns: string, name: string, key: string, text: string, meta: SecretMeta | null): string {
  const { [LAST_APPLIED]: _dropped, ...annotations } = meta?.annotations ?? {};
  const labels = meta?.labels ?? {};
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name,
      namespace: ns,
      ...(meta && { resourceVersion: meta.resourceVersion }),
      ...(Object.keys(labels).length > 0 && { labels }),
      ...(Object.keys(annotations).length > 0 && { annotations }),
    },
    data: { ...meta?.otherData, [key]: Buffer.from(text).toString('base64') },
  });
}
