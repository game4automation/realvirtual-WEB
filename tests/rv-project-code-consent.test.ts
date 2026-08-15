// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.9 — the per-project consent gate in front of native project code
 * (plan-718 stage 2b.3, R8).
 *
 * The three states the plan names — granted, refused, persisted — plus the two
 * that decide whether the gate is a gate at all: no dialog host mounted, and a
 * second project asking while one question is open.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  requestProjectCodeConsent,
  answerProjectCodeConsent,
  registerProjectCodeConsentHost,
  pendingProjectCodeConsent,
  projectCodeConsent,
  hasProjectCodeConsent,
  setProjectCodeConsent,
  resetProjectCodeConsent,
  _resetProjectCodeConsentForTests,
} from '../src/core/project/rv-project-code-consent';

const ask = (projectId: string, scriptRef = 'scripts/a.ts') =>
  requestProjectCodeConsent({ projectId, projectName: projectId, scriptRef });

beforeEach(() => { _resetProjectCodeConsentForTests(); });
afterEach(() => { _resetProjectCodeConsentForTests(); });

describe('decision states', () => {
  it('asks when nothing is on file, and grants what the user answered', async () => {
    registerProjectCodeConsentHost();
    const answer = ask('p1');
    expect(pendingProjectCodeConsent()?.projectId).toBe('p1');
    answerProjectCodeConsent(true);
    expect(await answer).toBe(true);
    expect(hasProjectCodeConsent('p1')).toBe(true);
  });

  it('refuses without prompting again once the answer was no', async () => {
    registerProjectCodeConsentHost();
    const first = ask('p1');
    answerProjectCodeConsent(false);
    expect(await first).toBe(false);

    // Persisted refusal: the second ask settles immediately, no dialog.
    expect(await ask('p1')).toBe(false);
    expect(pendingProjectCodeConsent()).toBeNull();
    expect(projectCodeConsent('p1')).toBe('denied');
  });

  it('persists a grant across "sessions" — the store is re-read, not remembered', async () => {
    registerProjectCodeConsentHost();
    const answer = ask('p1');
    answerProjectCodeConsent(true);
    await answer;

    // What a reload sees: the module state gone, localStorage intact.
    const raw = localStorage.getItem('rv-project-code-consent');
    _resetProjectCodeConsentForTests();
    localStorage.setItem('rv-project-code-consent', raw!);
    expect(hasProjectCodeConsent('p1')).toBe(true);
    expect(await ask('p1')).toBe(true);      // resolves with no host mounted
  });

  it('keeps the decision per project — a grant for one is not a grant for the next', async () => {
    registerProjectCodeConsentHost();
    const first = ask('p1');
    answerProjectCodeConsent(true);
    await first;
    expect(hasProjectCodeConsent('p1')).toBe(true);
    expect(hasProjectCodeConsent('p2')).toBe(false);
    expect(projectCodeConsent('p2')).toBeNull();
  });

  it('forgets a decision on reset', () => {
    setProjectCodeConsent('p1', true);
    expect(hasProjectCodeConsent('p1')).toBe(true);
    resetProjectCodeConsent('p1');
    expect(projectCodeConsent('p1')).toBeNull();
  });
});

describe('failing closed', () => {
  it('denies when no dialog host is mounted — never hangs, never assumes yes', async () => {
    expect(await ask('p1')).toBe(false);
    expect(pendingProjectCodeConsent()).toBeNull();
    expect(projectCodeConsent('p1')).toBeNull();   // nothing was DECIDED either
  });

  it('denies a second project while one question is open', async () => {
    registerProjectCodeConsentHost();
    const first = ask('p1');
    expect(await ask('p2')).toBe(false);
    answerProjectCodeConsent(true);
    expect(await first).toBe(true);
  });

  it('shares one question between concurrent asks for the same project', async () => {
    registerProjectCodeConsentHost();
    const a = ask('p1', 'scripts/a.ts');
    const b = ask('p1', 'scripts/b.ts');
    answerProjectCodeConsent(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
  });

  it('answers no when the host unmounts with a question open', async () => {
    const unmount = registerProjectCodeConsentHost();
    const answer = ask('p1');
    unmount();
    expect(await answer).toBe(false);
  });

  it('reads a record from an unknown table version as "no decision"', () => {
    localStorage.setItem(
      'rv-project-code-consent',
      JSON.stringify({ p1: { v: 99, decision: 'granted', at: 0 } }),
    );
    expect(projectCodeConsent('p1')).toBeNull();
    expect(hasProjectCodeConsent('p1')).toBe(false);
  });

  it('reads a corrupt table as "no decision"', () => {
    localStorage.setItem('rv-project-code-consent', 'not json');
    expect(projectCodeConsent('p1')).toBeNull();
  });
});
