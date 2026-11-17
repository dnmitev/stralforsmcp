// Mutation-killing cases for the track_document mapper (written red, sharpened after green). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { channelOutcome, documentOutcome, minimiseDocument, minimiseHistory } from './tracking.ts';
import { channel, rawDoc, receiverCanaries } from '../../test/helpers/track.ts';

describe('boundaries', () => {
  it('history forcing needs delivered === total and total > 0', () => {
    const r = [{ outcome: 'refused' as const }];
    expect(documentOutcome(r, { delivered: 1, total: 1 })).toBe('delivered');
    expect(documentOutcome(r, { delivered: 0, total: 1 })).toBe('refused');
    expect(documentOutcome(r, { delivered: 2, total: 1 })).toBe('refused');
    expect(documentOutcome(r, { delivered: 0, total: 0 })).toBe('refused');
  });
  it('priority is delivered > in_progress/unknown > refused > failed, both orders', () => {
    const pairs: [string[], string][] = [
      [['delivered', 'in_progress'], 'delivered'], [['in_progress', 'delivered'], 'delivered'],
      [['in_progress', 'refused'], 'in_progress'], [['refused', 'in_progress'], 'in_progress'],
      [['unknown', 'refused'], 'in_progress'], [['unknown', 'failed'], 'in_progress'], [['failed', 'unknown'], 'in_progress'],
      [['refused', 'failed'], 'refused'], [['failed', 'refused'], 'refused'],
    ];
    for (const [c, e] of pairs) expect(documentOutcome(c.map((outcome) => ({ outcome })) as never), c.join()).toBe(e);
  });
});

describe('prefix groups need the whole prefix at the start', () => {
  it.each([['signorder', 'delivered'], ['printing', 'in_progress'], ['enveloping', 'in_progress'], ['reprints', 'in_progress'], ['postprocessing', 'in_progress']] as const)('%s', (p, o) => {
    expect(channelOutcome(p)).toBe(o);
    expect(channelOutcome(`${p}zzz`)).toBe(o);
    expect(channelOutcome(`z${p}`)).toBe('unknown');
    expect(channelOutcome(p.slice(0, -1))).toBe('unknown');
    expect(channelOutcome(p.slice(1))).toBe('unknown');
  });
});

describe('minimiser is an allowlist', () => {
  it('every channel field is picked explicitly', () => {
    const c = receiverCanaries();
    const m = minimiseDocument(rawDoc(c, { channels: [channel('Paid', { channelId: 26, channelName: 'N', documents: 7, pages: 11, deliveryTime: 'dt', surprise: c.fileId }, c)] })) as { channels: Record<string, unknown>[] };
    expect(m.channels[0]).toEqual({ channelId: 26, channelName: 'N', status: 'Paid', outcome: 'delivered', deliveryTime: 'dt', documents: 7, pages: 11, comments: [{ status: 'Paid', dateTime: '2030-01-02T03:04:05Z', paymentMethod: 'Card' }] });
  });
  it('history keeps raw counts and never an unknown field', () => {
    const c = receiverCanaries();
    const h = minimiseHistory({ status: 'S', arrivalTime: 'A', deliveryDocumentsDelivered: 4, deliveryDocumentsTotal: 5, surprise: c.fileId, channels: [{ channelId: 1, channelName: 'n', status: 'Rejected', surprise: c.fileId, deliveryDocuments: [{ deliveryDocumentId: 'Z', surprise: c.fileId, statusHistory: [{ dateTime: 'd', message: 'Delivered', paymentMethod: 'P', surprise: c.fileId }] }] }] });
    expect(h).toEqual({ status: 'other', arrivalTime: 'A', deliveryDocumentsDelivered: 4, deliveryDocumentsTotal: 5, channels: [{ channelId: 1, channelName: 'n', status: 'Rejected', outcome: 'refused', deliveryDocuments: [{ deliveryDocumentId: 'Z', events: [{ dateTime: 'd', message: 'Delivered' }] }] }] });
  });
});
