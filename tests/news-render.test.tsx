// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsDialogHost } from '../src/core/hmi/NewsDialog';
import {
  fetchConnectNews,
  fetchUnseenNews,
} from '../src/core/news-store';
import {
  _resetStartupModalCoordinatorForTests,
} from '../src/core/hmi/startup-modal-coordinator';
import {
  newsItem,
  renderNews,
  resetNewsStoreForTest,
  setAppConfigForTest,
  stubNewsResponse,
} from './helpers/news-test-utils';

describe('NewsDialog rendering', () => {
  beforeEach(() => {
    resetNewsStoreForTest();
    _resetStartupModalCoordinatorForTests();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetNewsStoreForTest();
    _resetStartupModalCoordinatorForTests();
    localStorage.clear();
  });

  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<img src=x onerror=alert(1)>', 'img'],
    ['<iframe src=x></iframe>', 'iframe'],
  ])('renders %s as inert text without a live %s element', (body, tag) => {
    const { baseElement } = renderNews({ id: 'x', title: 'T', body });
    expect(baseElement.querySelector(tag)).toBeNull();
    expect(baseElement.querySelector('[onerror],[onclick],[onmouseover]')).toBeNull();
    expect(baseElement.textContent).toContain(body);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
  ])('drops the external link for unsafe protocol %s', (link) => {
    renderNews({ id: 'x', title: 'T', body: '', link });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders HTML in the title as inert text', () => {
    const { baseElement } = renderNews({
      id: 'x',
      title: '<img src=x onerror=alert(1)>',
      body: '',
    });
    expect(baseElement.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('renders safe external links with a protected new-tab target', () => {
    renderNews({ id: 'x', title: 'T', body: '', link: 'https://realvirtual.io' });
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('exposes a labelled and described accessible dialog', () => {
    renderNews({ id: 'x', title: 'Titel', body: 'Text' });
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toContain('Titel');
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('Text');
  });

  it('marks the current item seen and closes via the X button', async () => {
    const { onSeen } = renderNews({ id: 'x', title: 'T', body: '' });
    fireEvent.click(screen.getByRole('button', { name: 'News schließen' }));
    expect(onSeen).toHaveBeenCalledWith('x');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks the current item seen and closes via Escape', async () => {
    const { onSeen } = renderNews({ id: 'esc', title: 'T', body: '' });
    const modalRoot = screen.getByRole('dialog').closest('.MuiModal-root');
    expect(modalRoot).toBeTruthy();
    fireEvent.keyDown(modalRoot!, { key: 'Escape' });
    await waitFor(() => expect(onSeen).toHaveBeenCalledWith('esc'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks the current item seen and closes via backdrop click', async () => {
    const { onSeen, baseElement } = renderNews({ id: 'backdrop', title: 'T', body: '' });
    const backdrop = baseElement.querySelector('.MuiBackdrop-root');
    expect(backdrop).toBeTruthy();
    fireEvent.mouseDown(backdrop!);
    fireEvent.click(backdrop!);
    await waitFor(() => expect(onSeen).toHaveBeenCalledWith('backdrop'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('advances in order, marks each previous item, and updates the counter', () => {
    const { onSeen } = renderNews([
      { id: 'one', title: 'One', body: '' },
      { id: 'two', title: 'Two', body: '' },
    ]);
    expect(screen.getByText('1 von 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(onSeen).toHaveBeenCalledWith('one');
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText('2 von 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onSeen).toHaveBeenLastCalledWith('two');
  });

  it('keeps long content scrolling inside the divided DialogContent', () => {
    renderNews({ id: 'long', title: 'Long', body: 'Paragraph '.repeat(1_000) });
    const content = screen.getByTestId('news-dialog-content');
    expect(getComputedStyle(content).overflowY).toBe('auto');
    expect(content.classList.contains('MuiDialogContent-dividers')).toBe(true);
  });

  it('autofocuses the primary action inside the dialog', async () => {
    renderNews({ id: 'focus', title: 'Focus', body: '' });
    const button = screen.getByRole('button', { name: 'Schließen' });
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('arbitrates WEB before CONNECT and then advances to CONNECT', async () => {
    setAppConfigForTest({
      news: { enabled: true, apiUrl: 'https://portal.test/news/api/v1' },
    });
    stubNewsResponse([{ id: 'web-1', title: 'WEB item', body: '' }]);
    await fetchUnseenNews('web');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract: 1,
      items: [newsItem({ id: 'connect-1', title: 'CONNECT item', body: '' })],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await fetchConnectNews('http://localhost:5100');

    render(<NewsDialogHost includeWeb />);
    expect(screen.getByText('WEB item')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(await screen.findByText('CONNECT item')).toBeTruthy();
  });

  it('feeds only the CONNECT queue in the minimal shell host', async () => {
    setAppConfigForTest({
      news: { enabled: true, apiUrl: 'https://portal.test/news/api/v1' },
    });
    stubNewsResponse([{ id: 'web-1', title: 'WEB item', body: '' }]);
    await fetchUnseenNews('web');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contract: 1,
      items: [newsItem({ id: 'connect-1', title: 'CONNECT item', body: '' })],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await fetchConnectNews('http://localhost:5100');

    render(<NewsDialogHost includeWeb={false} />);
    expect(screen.queryByText('WEB item')).toBeNull();
    expect(screen.getByText('CONNECT item')).toBeTruthy();
  });
});
