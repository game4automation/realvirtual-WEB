// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerFilterSubscriber,
  getFilterSubscribers,
  isTypeEnabled,
  type SearchSettings,
} from '../src/core/hmi/search-settings-store';

describe('search-settings-store', () => {
  describe('isTypeEnabled', () => {
    const settings: SearchSettings = {
      highlightEnabled: true,
      nodesEnabled: true,
      disabledTypes: ['Sensor'],
    };

    it('should pass untyped nodes when nodesEnabled is true', () => {
      expect(isTypeEnabled(settings, [])).toBe(true);
    });

    it('should block untyped nodes when nodesEnabled is false', () => {
      const noNodes: SearchSettings = { ...settings, nodesEnabled: false };
      expect(isTypeEnabled(noNodes, [])).toBe(false);
    });

    it('should pass nodes with enabled types', () => {
      expect(isTypeEnabled(settings, ['Drive'])).toBe(true);
    });

    it('should block nodes with only disabled types', () => {
      expect(isTypeEnabled(settings, ['Sensor'])).toBe(false);
    });

    it('should pass nodes with mixed types if at least one is enabled', () => {
      expect(isTypeEnabled(settings, ['Sensor', 'Drive'])).toBe(true);
    });

    it('should pass all types when disabledTypes is empty', () => {
      const noDisabled: SearchSettings = { highlightEnabled: true, nodesEnabled: true, disabledTypes: [] };
      expect(isTypeEnabled(noDisabled, ['Sensor'])).toBe(true);
      expect(isTypeEnabled(noDisabled, ['Drive'])).toBe(true);
    });

    it('should still pass typed nodes when nodesEnabled is false', () => {
      const noNodes: SearchSettings = { highlightEnabled: true, nodesEnabled: false, disabledTypes: [] };
      expect(isTypeEnabled(noNodes, ['Drive'])).toBe(true);
      expect(isTypeEnabled(noNodes, [])).toBe(false);
    });
  });

  describe('registerFilterSubscriber', () => {
    it('should register subscribers and prevent duplicates', () => {
      const before = getFilterSubscribers().length;
      registerFilterSubscriber({ id: 'TestType', label: 'Tests', componentType: 'TestType' });
      expect(getFilterSubscribers().length).toBe(before + 1);
      // Duplicate should not add
      registerFilterSubscriber({ id: 'TestType', label: 'Tests', componentType: 'TestType' });
      expect(getFilterSubscribers().length).toBe(before + 1);
    });
  });
});
