// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for connect-store.importMultiTabTagTable() — the Multi-Topic push.
 *
 * One InterfaceConfig carries N topics; a re-import with fewer topics REPLACES
 * the whole array (no accumulation, F10); a push error surfaces as a thrown
 * error (F16). fetch is stubbed and the PUT body asserted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importMultiTabTagTable } from '../src/core/hmi/connect-store';
import type { ParsedTopic } from '../src/core/import/s7-tag-table';

const TOPICS: ParsedTopic[] = [
  { topic: 'Data_Q_1', sheetName: 'Data_Q_1', signals: [{ name: 'M_Run', wireType: 'PLCOutputBool', address: '%Q1.0', dataType: 'Bool', area: 'Q', comment: 'Motor running' }], warnings: [] },
  { topic: 'Data_Q_2', sheetName: 'Data_Q_2', signals: [{ name: 'Cmd', wireType: 'PLCOutputInt', address: '%QW2800', dataType: 'Word', area: 'Q' }], warnings: [] },
];

describe('importMultiTabTagTable', () => {
  let body: any;
  beforeEach(() => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('builds ONE InterfaceConfig with N topics (F9)', async () => {
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt1', brokerUrl: 'mqtt://x' });
    expect(body.topics).toHaveLength(2);
    expect(body.topics.map((t: any) => t.topic)).toEqual(['Data_Q_1', 'Data_Q_2']);
    expect(body.topics[0].signals[0].type).toBe('PLCOutputBool');
  });

  it('carries the tag comment through to the signal config (column 4)', async () => {
    await importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt1', brokerUrl: 'mqtt://x' });
    // Signal with a comment carries it; signal without one omits the field entirely.
    expect(body.topics[0].signals[0].comment).toBe('Motor running');
    expect(body.topics[1].signals[0]).not.toHaveProperty('comment');
  });

  it('re-import with fewer topics REPLACES the whole array (F10)', async () => {
    await importMultiTabTagTable([TOPICS[0]], { interfaceId: 'mqtt1', brokerUrl: 'mqtt://x' });
    expect(body.topics).toHaveLength(1);           // Data_Q_2 must be gone, not accumulated
    expect(body.topics[0].topic).toBe('Data_Q_1');
  });

  it('surfaces a push error instead of failing silently (F16)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as Response)));
    await expect(importMultiTabTagTable(TOPICS, { interfaceId: 'mqtt1', brokerUrl: 'mqtt://x' }))
      .rejects.toThrow();
  });
});
