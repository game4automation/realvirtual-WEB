// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  hashPath,
  mulberry32,
  generateHistory,
  WINDOW_SEC,
} from '../src/core/hmi/sensor-history-data';

describe('sensor-history-data', () => {
  // ── mulberry32 ────────────────────────────────────────────────────────
  describe('mulberry32', () => {
    it('produces deterministic sequence for same seed', () => {
      const a = mulberry32(42);
      const b = mulberry32(42);
      for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    });

    it('produces different sequences for different seeds', () => {
      const a = mulberry32(1);
      const b = mulberry32(2);
      const seqA = Array.from({ length: 10 }, a);
      const seqB = Array.from({ length: 10 }, b);
      expect(seqA).not.toEqual(seqB);
    });

    it('stays within [0, 1)', () => {
      const r = mulberry32(99);
      for (let i = 0; i < 1000; i++) {
        const v = r();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });

  // ── hashPath ──────────────────────────────────────────────────────────
  describe('hashPath', () => {
    it('is deterministic', () => {
      expect(hashPath('Cell/Conv1/B-IGC01')).toBe(hashPath('Cell/Conv1/B-IGC01'));
    });

    it('produces different hashes for different paths', () => {
      expect(hashPath('Cell/Conv1/B-IGC01')).not.toBe(hashPath('Cell/Conv1/B-IGC02'));
    });

    it('is uint32', () => {
      const h = hashPath('Cell/Conv1/B-IGC01');
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
      expect(Number.isInteger(h)).toBe(true);
    });

    it('handles empty and unicode strings', () => {
      expect(hashPath('')).toBeGreaterThanOrEqual(0);
      const h = hashPath('ÄÖÜ/∑∆');
      expect(Number.isInteger(h)).toBe(true);
    });
  });

  // ── generateHistory ───────────────────────────────────────────────────
  describe('generateHistory', () => {
    it('is deterministic for fixed nowMs', () => {
      const a = generateHistory('Cell/B-IGC01', 60, true, 1_000_000);
      const b = generateHistory('Cell/B-IGC01', 60, true, 1_000_000);
      expect(a.ts).toEqual(b.ts);
      expect(a.state).toEqual(b.state);
      expect(a.numeric).toEqual(b.numeric);
    });

    it('covers full window', () => {
      const now = 1_000_000;
      const s = generateHistory('Cell/B-IGC01', 300, true, now);
      expect(s.ts.length).toBeGreaterThan(1);
      expect(s.ts[0]).toBeGreaterThanOrEqual(now - 300_000);
      expect(s.ts[s.ts.length - 1]).toBeLessThanOrEqual(now);
    });

    it('last timestamp is pinned to nowMs', () => {
      const now = 1_000_000;
      const s = generateHistory('Cell/B-IGC01', 300, true, now);
      expect(s.ts[s.ts.length - 1]).toBe(now);
    });

    it('produces only low/high for isInt=false', () => {
      const s = generateHistory('Cell/B-IGC01', 300, false, 1_000_000);
      const allowed = new Set(['low', 'high']);
      expect(s.state.every(v => allowed.has(v))).toBe(true);
      expect(s.numeric.every(n => n === 0 || n === 1)).toBe(true);
    });

    it('numeric matches state', () => {
      const s = generateHistory('Cell/B-IGC01', 60, true, 1_000_000);
      const map: Record<string, number> = { low: 0, high: 1, warning: 2, error: 3, unbound: 0 };
      s.state.forEach((st, i) => expect(s.numeric[i]).toBe(map[st]));
    });

    it('window-switch keeps compatible initial state (low anchor)', () => {
      // F10: Time-Window-Buttons regenerieren Daten (gleiches Seed → kompatible historische Form)
      const s1 = generateHistory('Cell/B-IGC01', 60, true, 1_000_000);
      const s2 = generateHistory('Cell/B-IGC01', 300, true, 1_000_000);
      // Both must start with the same anchor state, since seed is path-only.
      expect(s1.state[0]).toBe(s2.state[0]);
      expect(s1.numeric[0]).toBe(s2.numeric[0]);
    });

    it('ts arrays are monotonically non-decreasing', () => {
      const s = generateHistory('Cell/B-IGC01', 300, true, 1_000_000);
      for (let i = 1; i < s.ts.length; i++) {
        expect(s.ts[i]).toBeGreaterThanOrEqual(s.ts[i - 1]);
      }
    });

    it('WINDOW_SEC has all four windows', () => {
      expect(WINDOW_SEC['1m']).toBe(60);
      expect(WINDOW_SEC['5m']).toBe(300);
      expect(WINDOW_SEC['15m']).toBe(900);
      expect(WINDOW_SEC['1h']).toBe(3600);
    });
  });
});
