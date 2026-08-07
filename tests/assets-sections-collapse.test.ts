// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.3 — the Assets-tab collapse state.
 *
 * The persistence SEMANTICS are the feature, not an implementation detail:
 * only collapsed keys are written, so an unknown key (a fresh browser, a
 * library attached one second ago) reads as expanded. Invert that and every
 * newly attached library appears as a closed header the user has to find.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  isSectionCollapsed,
  toggleSection,
  pruneSections,
  reloadAssetsSectionsForTests,
  resetAssetsSectionsForTests,
  subscribeAssetsSections,
  getAssetsSectionsSnapshot,
} from '../src/core/hmi/projects/assets-sections-store';
import { ASSETS_SECTIONS_COLLAPSED_KEY } from '../src/core/hmi/rv-storage-keys';

beforeEach(() => {
  localStorage.removeItem(ASSETS_SECTIONS_COLLAPSED_KEY);
  resetAssetsSectionsForTests();
});

function persisted(): string[] {
  const raw = localStorage.getItem(ASSETS_SECTIONS_COLLAPSED_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as { collapsed: string[] }).collapsed;
}

describe('assets-sections-store', () => {
  test('persists only collapsed groupKeys', () => {
    toggleSection('global:a');
    toggleSection('global:b');
    toggleSection('global:a');

    expect(persisted()).toEqual(['global:b']);
    expect(isSectionCollapsed('global:a')).toBe(false);
    expect(isSectionCollapsed('global:b')).toBe(true);
  });

  test('treats an unknown groupKey as expanded (a new library is visible)', () => {
    expect(isSectionCollapsed('global:never-seen')).toBe(false);
  });

  test('prunes groupKeys of libraries that no longer exist', () => {
    toggleSection('global:gone');
    toggleSection('global:stays');
    pruneSections(['global:stays']);

    expect(persisted()).toEqual(['global:stays']);
    expect(isSectionCollapsed('global:gone')).toBe(false);
  });

  test('survives corrupt JSON in localStorage without throwing', () => {
    localStorage.setItem(ASSETS_SECTIONS_COLLAPSED_KEY, '{not json');
    expect(() => reloadAssetsSectionsForTests()).not.toThrow();
    expect(isSectionCollapsed('global:a')).toBe(false);
  });

  test('survives a persisted value of the wrong shape', () => {
    localStorage.setItem(ASSETS_SECTIONS_COLLAPSED_KEY, JSON.stringify({ collapsed: 'oops' }));
    expect(() => reloadAssetsSectionsForTests()).not.toThrow();
    expect(isSectionCollapsed('global:a')).toBe(false);
  });

  test('reads back what a previous session wrote', () => {
    toggleSection('global:remembered');
    reloadAssetsSectionsForTests();
    expect(isSectionCollapsed('global:remembered')).toBe(true);
  });

  test('publishes a version counter, not an object', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAssetsSections(() => seen.push(getAssetsSectionsSnapshot()));
    toggleSection('global:a');
    toggleSection('global:a');
    unsubscribe();

    expect(seen).toEqual([1, 2]);
    expect(typeof getAssetsSectionsSnapshot()).toBe('number');
  });
});
