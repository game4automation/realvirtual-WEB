// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.1 — the pure rules: which mode a deliberate open ends in, which
 * exit-guard question that open causes, and the storage key.
 */

import { describe, it, expect } from 'vitest';
import {
  documentModeKey,
  documentModeProjectPrefix,
  effectiveOpenMode,
  handoffParkMode,
  plannedDeparture,
  resumeModeOf,
} from '../src/core/project/rv-document-mode';

const REGISTERED = new Set(['viewer', 'hmi', 'planner', 'des', 'editor']);
const has = (m: string) => REGISTERED.has(m);

describe('effectiveOpenMode', () => {
  it('lastMode beats the declared mode', () => {
    expect(effectiveOpenMode({ lastMode: 'editor', declaredMode: 'hmi', isDemo: false, has })).toBe('editor');
  });

  it('the declared mode when there is no lastMode', () => {
    expect(effectiveOpenMode({ lastMode: null, declaredMode: 'planner', isDemo: false, has })).toBe('planner');
  });

  it('null when neither names a mode', () => {
    expect(effectiveOpenMode({ lastMode: null, declaredMode: undefined, isDemo: false, has })).toBeNull();
  });

  it('a demo ignores the lastMode and keeps the declared mode', () => {
    expect(effectiveOpenMode({ lastMode: 'editor', declaredMode: 'hmi', isDemo: true, has })).toBe('hmi');
    expect(effectiveOpenMode({ lastMode: 'editor', declaredMode: null, isDemo: true, has })).toBeNull();
  });

  it('unregistered modes fall through', () => {
    expect(effectiveOpenMode({ lastMode: 'gone', declaredMode: 'planner', isDemo: false, has })).toBe('planner');
    expect(effectiveOpenMode({ lastMode: 'gone', declaredMode: 'also-gone', isDemo: false, has })).toBeNull();
  });
});

describe('plannedDeparture', () => {
  it('T equal to the active mode asks nothing', () => {
    expect(plannedDeparture('hmi', 'hmi', 'viewer')).toBeNull();
  });

  it('otherwise the question is T', () => {
    expect(plannedDeparture('hmi', 'planner', 'viewer')).toBe('planner');
    expect(plannedDeparture(null, 'hmi', 'viewer')).toBe('hmi');
  });

  it('from the editor the question is T itself, not the first non-editor mode', () => {
    expect(plannedDeparture('editor', 'planner', 'viewer')).toBe('planner');
  });

  it('editor → editor asks the park departure', () => {
    expect(plannedDeparture('editor', 'editor', 'viewer')).toBe('viewer');
  });
});

describe('handoffParkMode', () => {
  it('is the first non-editor mode, hmi without one', () => {
    expect(handoffParkMode({ list: () => [{ id: 'editor' }, { id: 'viewer' }, { id: 'hmi' }] })).toBe('viewer');
    expect(handoffParkMode({ list: () => [{ id: 'editor' }] })).toBe('hmi');
  });
});

describe('documentModeKey', () => {
  it('keeps bundled and folder of the same project id apart', () => {
    expect(documentModeKey('bundled', 'prj_x', 'd1')).toBe('bundled:prj_x:d1');
    expect(documentModeKey('folder', 'prj_x', 'd1')).toBe('folder:prj_x:d1');
    expect(documentModeKey('bundled', 'prj_x', 'd1')).not.toBe(documentModeKey('folder', 'prj_x', 'd1'));
  });

  it('the project prefix covers exactly that project\'s keys', () => {
    const prefix = documentModeProjectPrefix('folder', 'prj_x');
    expect(documentModeKey('folder', 'prj_x', 'd1').startsWith(prefix)).toBe(true);
    expect(documentModeKey('bundled', 'prj_x', 'd1').startsWith(prefix)).toBe(false);
    expect(documentModeKey('folder', 'prj_xy', 'd1').startsWith(prefix)).toBe(false);
  });
});

describe('resumeModeOf', () => {
  it('the effective mode first, the session mode only as the fallback', () => {
    expect(resumeModeOf({ lastMode: 'editor', declaredMode: null, isDemo: false, has, sessionMode: 'hmi' })).toBe('editor');
    expect(resumeModeOf({ lastMode: null, declaredMode: 'planner', isDemo: false, has, sessionMode: 'hmi' })).toBe('planner');
    expect(resumeModeOf({ lastMode: null, declaredMode: null, isDemo: false, has, sessionMode: 'hmi' })).toBe('hmi');
    expect(resumeModeOf({ lastMode: null, declaredMode: null, isDemo: false, has, sessionMode: null })).toBeNull();
  });
});
