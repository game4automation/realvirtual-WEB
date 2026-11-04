// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetStartupModalCoordinatorForTests,
  mayShowStartupModal,
  setStartupModalOpen,
  useMayShowStartupModal,
  useStartupModalRegistration,
  type StartupModalId,
} from '../src/core/hmi/startup-modal-coordinator';
import { setWelcomeModalOpen, _resetWelcomeModalForTests } from '../src/core/hmi/welcome-modal-store';

describe('startup modal coordinator', () => {
  beforeEach(() => {
    _resetStartupModalCoordinatorForTests();
    _resetWelcomeModalForTests();
  });

  afterEach(() => {
    cleanup();
    _resetWelcomeModalForTests();
    _resetStartupModalCoordinatorForTests();
  });

  it('applies welcome > opener > autoquality > news priority', () => {
    expect(mayShowStartupModal('news')).toBe(true);

    setStartupModalOpen('news', true);
    expect(mayShowStartupModal('news')).toBe(true);
    setStartupModalOpen('autoquality', true);
    expect(mayShowStartupModal('news')).toBe(false);
    expect(mayShowStartupModal('autoquality')).toBe(true);
    setStartupModalOpen('opener', true);
    expect(mayShowStartupModal('autoquality')).toBe(false);
    expect(mayShowStartupModal('opener')).toBe(true);
    setStartupModalOpen('welcome', true);
    expect(mayShowStartupModal('opener')).toBe(false);
    expect(mayShowStartupModal('welcome')).toBe(true);
  });

  it('ranks the public-demo welcome window after welcome and projects, before every incidental dialog (plan-646)', () => {
    setStartupModalOpen('demo-welcome', true);
    expect(mayShowStartupModal('demo-welcome')).toBe(true);
    for (const lower of ['opener', 'autoquality', 'news'] as const) {
      expect(mayShowStartupModal(lower), lower).toBe(false);
    }
    setStartupModalOpen('projects', true);
    expect(mayShowStartupModal('demo-welcome')).toBe(false);
    setStartupModalOpen('projects', false);
    setWelcomeModalOpen(true);
    expect(mayShowStartupModal('demo-welcome')).toBe(false);
    setWelcomeModalOpen(false);
    expect(mayShowStartupModal('demo-welcome')).toBe(true);
    setStartupModalOpen('demo-welcome', false);
    expect(mayShowStartupModal('news')).toBe(true);
  });

  it('releases the demo-welcome slot when its registrant unmounts', () => {
    const view = render(<Probe id="demo-welcome" register />);
    expect(mayShowStartupModal('news')).toBe(false);
    view.unmount();
    expect(mayShowStartupModal('news')).toBe(true);
  });

  it('updates a waiting hook when a higher-priority modal opens and closes', () => {
    render(<Probe id="news" register />);
    expect(screen.getByTestId('may-show').textContent).toBe('yes');

    act(() => setStartupModalOpen('opener', true));
    expect(screen.getByTestId('may-show').textContent).toBe('no');

    act(() => setStartupModalOpen('opener', false));
    expect(screen.getByTestId('may-show').textContent).toBe('yes');
  });

  it('receives WelcomeModal visibility through the existing welcome store seam', () => {
    expect(mayShowStartupModal('news')).toBe(true);
    setWelcomeModalOpen(true);
    expect(mayShowStartupModal('news')).toBe(false);
    setWelcomeModalOpen(false);
    expect(mayShowStartupModal('news')).toBe(true);
  });
});

function Probe({ id, register }: { id: StartupModalId; register: boolean }) {
  const mayShow = useMayShowStartupModal(id);
  useStartupModalRegistration(id, register && mayShow);
  return <div data-testid="may-show">{mayShow ? 'yes' : 'no'}</div>;
}
