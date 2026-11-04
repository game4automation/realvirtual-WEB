// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2022 Phase 0 §9.1 / §9.8 — RootErrorBoundary WITHOUT a diagnostics collector.
 *
 * A child that throws while rendering must not unmount the HMI: the boundary shows its card,
 * logs, reports a problem, hands the error to the optional structured receiver, remounts ONCE
 * after 1 s, and stops auto-remounting when the next crash follows within 30 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  RootErrorBoundary,
  ROOT_AUTO_REMOUNT_DELAY_MS,
  ROOT_CRASH_PROBLEM_ID,
  setOnRootError,
} from '../src/core/hmi/RootErrorBoundary';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import {
  diagnosticsCollector, getDiagnosticsEntries, installDiagnosticsCollector,
} from '../src/core/diagnostics/rv-diagnostics-collector';

/** Throws while `state.fail` is true; counts its successful mounts. */
const state = { fail: true, mounts: 0 };

function Bomb() {
  if (state.fail) throw new Error('boom from Bomb');
  state.mounts++;
  return <div data-testid="hmi-content">HMI</div>;
}

let consoleError: { mock: { calls: unknown[][] }; mockRestore: () => void };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  state.fail = true;
  state.mounts = 0;
  resetProblemsForTests();
  setOnRootError(null);
  // React logs the caught error itself; keep the run output readable but keep the spy to assert.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as typeof consoleError;
});

afterEach(() => {
  cleanup();
  setOnRootError(null);
  resetProblemsForTests();
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe('RootErrorBoundary (Phase 0, no collector)', () => {
  it('shows the crash card, logs and reports instead of unmounting', () => {
    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);

    expect(screen.getByTestId('root-error-card')).toBeTruthy();
    expect(screen.getByText('The interface crashed.')).toBeTruthy();
    expect(screen.queryByTestId('hmi-content')).toBeNull();

    const own = consoleError.mock.calls.find(c => c[0] === '[RootErrorBoundary]');
    expect(own).toBeTruthy();
    expect((own![1] as Error).message).toBe('boom from Bomb');
    expect(typeof own![2]).toBe('string');
    expect(own![2] as string).toContain('Bomb');

    const problem = getProblems().find(p => p.id === ROOT_CRASH_PROBLEM_ID);
    expect(problem?.severity).toBe('error');
    expect(problem?.detail).toContain('boom from Bomb');
  });

  it('hands error and component stack to the optional receiver', () => {
    const received: Array<{ error: unknown; stack: string }> = [];
    setOnRootError((error, stack) => received.push({ error, stack }));

    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);

    expect(received).toHaveLength(1);
    expect((received[0].error as Error).message).toBe('boom from Bomb');
    expect(received[0].stack).toContain('Bomb');
  });

  it('a throwing receiver does not break the card', () => {
    setOnRootError(() => { throw new Error('receiver broken'); });
    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);
    expect(screen.getByTestId('root-error-card')).toBeTruthy();
  });

  it('remounts automatically once after 1 s', () => {
    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);
    expect(screen.getByTestId('root-error-card')).toBeTruthy();

    state.fail = false;
    act(() => { vi.advanceTimersByTime(ROOT_AUTO_REMOUNT_DELAY_MS - 1); });
    expect(screen.getByTestId('root-error-card')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });

    expect(screen.getByTestId('hmi-content')).toBeTruthy();
    expect(screen.queryByTestId('root-error-card')).toBeNull();
    expect(state.mounts).toBe(1);
  });

  it('a second crash within 30 s is not auto-remounted; the button rebuilds', () => {
    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);
    // First crash → auto-remount after 1 s, which crashes again (still failing).
    act(() => { vi.advanceTimersByTime(ROOT_AUTO_REMOUNT_DELAY_MS); });
    expect(screen.getByTestId('root-error-card')).toBeTruthy();

    // No further automatic remount, however long we wait.
    state.fail = false;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('root-error-card')).toBeTruthy();
    expect(state.mounts).toBe(0);

    // The manual rebuild restores the UI.
    fireEvent.click(screen.getByTestId('root-error-rebuild'));
    expect(screen.getByTestId('hmi-content')).toBeTruthy();
    expect(state.mounts).toBe(1);
  });

  it('a crash more than 30 s after the previous one is auto-remounted again', () => {
    const { rerender } = render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);
    state.fail = false;
    act(() => { vi.advanceTimersByTime(ROOT_AUTO_REMOUNT_DELAY_MS); });
    expect(screen.getByTestId('hmi-content')).toBeTruthy();

    // 31 s later the HMI crashes again on the SAME boundary instance.
    act(() => { vi.advanceTimersByTime(31_000); });
    state.fail = true;
    rerender(<RootErrorBoundary><Bomb key="again" /></RootErrorBoundary>);
    expect(screen.getByTestId('root-error-card')).toBeTruthy();

    state.fail = false;
    act(() => { vi.advanceTimersByTime(ROOT_AUTO_REMOUNT_DELAY_MS); });
    expect(screen.getByTestId('hmi-content')).toBeTruthy();
  });
});

describe('RootErrorBoundary with diagnostics collector', () => {
  it('records exactly one structured react entry with separate full component stack', () => {
    diagnosticsCollector.clear();
    installDiagnosticsCollector();
    render(<RootErrorBoundary><Bomb /></RootErrorBoundary>);

    const entries = getDiagnosticsEntries().filter(e => e.cat === 'react');
    expect(entries).toHaveLength(1);
    expect(entries[0].stack).toContain('boom from Bomb');
    expect(entries[0].component).toContain('Bomb');
    expect(entries[0].msg).not.toContain('Bomb (');
  });
});
