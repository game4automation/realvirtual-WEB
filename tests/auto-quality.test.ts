// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  pickInitialPreset, probeGPUTier,
  queueAutoQualityNotice, clearAutoQualityNotice, getAutoQualityNotice,
  hasAutoQualityApplied, markAutoQualityApplied,
  AUTO_QUALITY_APPLIED_KEY, FAST_PRESET_NAME, DEFAULT_PRESET_NAME,
} from '../src/core/hmi/auto-quality';

describe('auto-quality', () => {
  describe('pickInitialPreset', () => {
    it('picks Fast on mobile regardless of GPU tier', () => {
      expect(pickInitialPreset(true, 'discrete')).toEqual({ name: FAST_PRESET_NAME, reason: 'mobile' });
    });

    it('picks Fast for integrated and software GPUs', () => {
      expect(pickInitialPreset(false, 'integrated')).toEqual({ name: FAST_PRESET_NAME, reason: 'weak-gpu' });
      expect(pickInitialPreset(false, 'software')).toEqual({ name: FAST_PRESET_NAME, reason: 'weak-gpu' });
    });

    it('picks Default for discrete, apple-silicon and unknown', () => {
      expect(pickInitialPreset(false, 'discrete').name).toBe(DEFAULT_PRESET_NAME);
      expect(pickInitialPreset(false, 'apple-silicon').name).toBe(DEFAULT_PRESET_NAME);
      // 'unknown' must NOT downgrade — privacy-redacted GPU strings are common
      // on capable hardware.
      const unknown = pickInitialPreset(false, 'unknown');
      expect(unknown.name).toBe(DEFAULT_PRESET_NAME);
      expect(unknown.reason).toBeUndefined();
    });
  });

  describe('probeGPUTier', () => {
    it('returns a valid tier without throwing (headless smoke test)', () => {
      const tier = probeGPUTier();
      expect(['software', 'integrated', 'discrete', 'apple-silicon', 'unknown']).toContain(tier);
    });
  });

  describe('notice store', () => {
    beforeEach(() => clearAutoQualityNotice());

    it('queues and clears a notice', () => {
      expect(getAutoQualityNotice()).toBeNull();
      queueAutoQualityNotice('weak-gpu');
      expect(getAutoQualityNotice()).toEqual({ reason: 'weak-gpu', presetName: FAST_PRESET_NAME });
      clearAutoQualityNotice();
      expect(getAutoQualityNotice()).toBeNull();
    });
  });

  describe('once-per-device flag', () => {
    beforeEach(() => localStorage.removeItem(AUTO_QUALITY_APPLIED_KEY));

    it('is unset by default and sticky once marked', () => {
      expect(hasAutoQualityApplied()).toBe(false);
      markAutoQualityApplied();
      expect(hasAutoQualityApplied()).toBe(true);
      localStorage.removeItem(AUTO_QUALITY_APPLIED_KEY);
    });
  });
});
