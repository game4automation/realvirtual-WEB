// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ActiveOnly utility tests
 *
 * Validates parseActiveOnly() and isActiveForState() behavior
 * for all ActiveOnly enum values and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { parseActiveOnly, isActiveForState, type ActiveOnly } from '../src/core/engine/rv-active-only';

describe('parseActiveOnly', () => {
  it('parses valid ActiveOnly values', () => {
    expect(parseActiveOnly({ Active: 'Always' })).toBe('Always');
    expect(parseActiveOnly({ Active: 'Connected' })).toBe('Connected');
    expect(parseActiveOnly({ Active: 'Disconnected' })).toBe('Disconnected');
    expect(parseActiveOnly({ Active: 'Never' })).toBe('Never');
    expect(parseActiveOnly({ Active: 'DontChange' })).toBe('DontChange');
  });

  it('defaults to Always when Active is missing', () => {
    expect(parseActiveOnly({})).toBe('Always');
  });

  it('defaults to Always for invalid values', () => {
    expect(parseActiveOnly({ Active: 'invalid' })).toBe('Always');
    expect(parseActiveOnly({ Active: 42 })).toBe('Always');
    expect(parseActiveOnly({ Active: null })).toBe('Always');
    expect(parseActiveOnly({ Active: '' })).toBe('Always');
  });
});

describe('isActiveForState', () => {
  it('Always is active regardless of connection state', () => {
    expect(isActiveForState('Always', true)).toBe(true);
    expect(isActiveForState('Always', false)).toBe(true);
  });

  it('Connected is active only when connected', () => {
    expect(isActiveForState('Connected', true)).toBe(true);
    expect(isActiveForState('Connected', false)).toBe(false);
  });

  it('Disconnected is active only when disconnected', () => {
    expect(isActiveForState('Disconnected', true)).toBe(false);
    expect(isActiveForState('Disconnected', false)).toBe(true);
  });

  it('Never is never active', () => {
    expect(isActiveForState('Never', true)).toBe(false);
    expect(isActiveForState('Never', false)).toBe(false);
  });

  it('DontChange is treated as always active', () => {
    expect(isActiveForState('DontChange', true)).toBe(true);
    expect(isActiveForState('DontChange', false)).toBe(true);
  });

  // Scenario-based tests for fixedUpdate guard behavior
  it('Connected playback runs when viewer is Connected', () => {
    const active: ActiveOnly = 'Connected';
    const viewerConnected = true;
    expect(isActiveForState(active, viewerConnected)).toBe(true);
  });

  it('Connected playback stops when viewer switches to Disconnected', () => {
    const active: ActiveOnly = 'Connected';
    const viewerConnected = false;
    expect(isActiveForState(active, viewerConnected)).toBe(false);
  });

  it('Disconnected component activates when viewer goes Disconnected', () => {
    const active: ActiveOnly = 'Disconnected';
    const viewerConnected = false;
    expect(isActiveForState(active, viewerConnected)).toBe(true);
  });

  it('Always component runs in both states (default GLB behavior)', () => {
    expect(isActiveForState('Always', true)).toBe(true);
    expect(isActiveForState('Always', false)).toBe(true);
  });
});
