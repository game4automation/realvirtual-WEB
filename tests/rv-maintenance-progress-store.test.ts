// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, beforeEach } from 'vitest';
import {
  loadMaintenanceProgress,
  saveMaintenanceProgress,
  clearMaintenanceProgress,
  clearAllMaintenanceProgress,
} from '../src/core/hmi/maintenance-progress-store';

describe('maintenance-progress-store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('loadMaintenanceProgress returns null when no saved progress', () => {
    expect(loadMaintenanceProgress('Test Procedure')).toBeNull();
  });

  test('saveMaintenanceProgress and loadMaintenanceProgress round-trip', () => {
    saveMaintenanceProgress('Test Procedure', ['pass', null, 'fail'], 1);
    const loaded = loadMaintenanceProgress('Test Procedure');
    expect(loaded).not.toBeNull();
    expect(loaded!.procedureName).toBe('Test Procedure');
    expect(loaded!.stepResults).toEqual(['pass', null, 'fail']);
    expect(loaded!.currentStep).toBe(1);
    expect(loaded!.lastUpdated).toBeTruthy();
  });

  test('saves multiple procedures independently', () => {
    saveMaintenanceProgress('Proc A', ['pass'], 0);
    saveMaintenanceProgress('Proc B', [null, 'fail'], 1);

    const a = loadMaintenanceProgress('Proc A');
    const b = loadMaintenanceProgress('Proc B');
    expect(a!.stepResults).toEqual(['pass']);
    expect(b!.stepResults).toEqual([null, 'fail']);
  });

  test('clearMaintenanceProgress removes specific procedure', () => {
    saveMaintenanceProgress('Proc A', ['pass'], 0);
    saveMaintenanceProgress('Proc B', ['fail'], 0);

    clearMaintenanceProgress('Proc A');
    expect(loadMaintenanceProgress('Proc A')).toBeNull();
    expect(loadMaintenanceProgress('Proc B')).not.toBeNull();
  });

  test('clearAllMaintenanceProgress removes everything', () => {
    saveMaintenanceProgress('Proc A', ['pass'], 0);
    saveMaintenanceProgress('Proc B', ['fail'], 0);

    clearAllMaintenanceProgress();
    expect(loadMaintenanceProgress('Proc A')).toBeNull();
    expect(loadMaintenanceProgress('Proc B')).toBeNull();
  });

  test('overwriting progress updates correctly', () => {
    saveMaintenanceProgress('Test', ['pass', null], 0);
    saveMaintenanceProgress('Test', ['pass', 'pass'], 1);

    const loaded = loadMaintenanceProgress('Test');
    expect(loaded!.stepResults).toEqual(['pass', 'pass']);
    expect(loaded!.currentStep).toBe(1);
  });

  test('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('rv-maintenance-progress', '{invalid json}');
    expect(loadMaintenanceProgress('Test')).toBeNull();
  });

  test('stepResults are copied (not referenced)', () => {
    const results: ('pass' | 'fail' | 'skipped' | null)[] = ['pass', null];
    saveMaintenanceProgress('Test', results, 0);

    // Mutate original array
    results[0] = 'fail';

    const loaded = loadMaintenanceProgress('Test');
    expect(loaded!.stepResults[0]).toBe('pass'); // should be original value
  });
});
