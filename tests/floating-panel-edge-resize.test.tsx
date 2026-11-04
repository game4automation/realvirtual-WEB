// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FloatingPanel edge resizing — four edges and four corners on the ONE resize
 * code path the bottom-right corner always used. West/north move the origin
 * while the opposite edge stays put; the min size is a floor; the result is
 * persisted at pointerup like a corner resize. No handles exist where a resize
 * makes no sense (resizable=false, maximized, collapsed, content-driven width),
 * and mobile keeps only the corner it had.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { FloatingPanel } from '../src/core/hmi/FloatingPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

type Props = Partial<React.ComponentProps<typeof FloatingPanel>>;

/** Fits the 414 × 896 headless viewport: x 200..400, y 300..500. */
const BOX: Props = {
  defaultPosition: { x: 200, y: 300 },
  defaultWidth: 200,
  defaultHeight: 200,
  minWidth: 150,
  minHeight: 120,
};

function renderPanel(props: Props = {}) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <FloatingPanel open closable={false} title="Edge" panelId="edge-panel" {...BOX} {...props}>
        <div data-testid="panel-content">content</div>
      </FloatingPanel>
    </ThemeProvider>,
  );
}

function geo() {
  const cs = getComputedStyle(document.querySelector('[data-ui-panel]') as HTMLElement);
  return { left: parseFloat(cs.left), top: parseFloat(cs.top), width: parseFloat(cs.width), height: parseFloat(cs.height) };
}

function handle(dir: string): HTMLElement | null {
  return document.querySelector(`[data-resize-dir="${dir}"]`);
}

function resize(dir: string, dx: number, dy: number) {
  const h = handle(dir);
  if (!h) throw new Error(`no ${dir} handle`);
  fireEvent.pointerDown(h, { pointerId: 3, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(window, { pointerId: 3, clientX: 300 + dx, clientY: 300 + dy });
  fireEvent.pointerUp(window, { pointerId: 3, clientX: 300 + dx, clientY: 300 + dy });
}

const saved = () => JSON.parse(localStorage.getItem('rv-panel-geo:edge-panel') ?? 'null');

let capture: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  layout.mobile = false;
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  capture.mockRestore();
  localStorage.clear();
});

describe('FloatingPanel edge resize', () => {
  it('renders all eight handles with the matching cursors', () => {
    renderPanel();
    const cursors: Record<string, string> = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    };
    for (const [dir, cursor] of Object.entries(cursors)) {
      const h = handle(dir);
      expect(h, dir).not.toBeNull();
      expect(getComputedStyle(h!).cursor, dir).toBe(cursor);
    }
    // The visible grip is the classic corner handle.
    expect(handle('se')!.hasAttribute('data-resize-handle')).toBe(true);
    expect(handle('se')!.querySelector('svg')).not.toBeNull();
  });

  it('left edge to the left grows the width and moves x; the right edge stays', () => {
    renderPanel();
    resize('w', -50, 0);
    expect(geo()).toMatchObject({ left: 150, width: 250, top: 300, height: 200 });
    expect(saved()).toEqual({ x: 150, y: 300, w: 250, h: 200 });
  });

  it('bottom edge grows the height and leaves the origin alone', () => {
    renderPanel();
    resize('s', 0, 60);
    expect(geo()).toMatchObject({ left: 200, top: 300, width: 200, height: 260 });
    expect(saved()).toEqual({ x: 200, y: 300, w: 200, h: 260 });
  });

  it('top edge moves y and keeps the bottom edge', () => {
    renderPanel();
    resize('n', 0, -40);
    expect(geo()).toMatchObject({ top: 260, height: 240 });
    expect(saved()).toEqual({ x: 200, y: 260, w: 200, h: 240 });
  });

  it('holds the min size floor on west and north without moving the opposite edge', () => {
    renderPanel();
    resize('w', 500, 0);
    expect(geo()).toMatchObject({ width: 150, left: 250 });
    resize('n', 0, 500);
    expect(geo()).toMatchObject({ height: 120, top: 380 });
    expect(saved()).toEqual({ x: 250, y: 380, w: 150, h: 120 });
  });

  it('a west drag stops at the button column instead of leaving the viewport', () => {
    renderPanel();
    resize('w', -1000, 0);
    expect(geo()).toMatchObject({ left: 72, width: 328 });
  });

  it('the nw corner resizes both axes from the origin', () => {
    renderPanel();
    resize('nw', -30, -20);
    expect(geo()).toMatchObject({ left: 170, top: 280, width: 230, height: 220 });
  });

  it('renders no handles with resizable=false', () => {
    renderPanel({ resizable: false });
    expect(document.querySelector('[data-resize-dir]')).toBeNull();
  });

  it('renders no handles with a content-driven width', () => {
    renderPanel({ fixedWidth: 220 });
    expect(document.querySelector('[data-resize-dir]')).toBeNull();
  });

  it('renders no handles while maximized, and gets them back on restore', async () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText('Expand window'));
    await waitFor(() => expect(document.querySelector('[data-resize-dir]')).toBeNull());
    fireEvent.click(screen.getByLabelText('Collapse window'));
    await waitFor(() => expect(handle('w')).not.toBeNull());
  });

  it('renders no handles while collapsed', () => {
    renderPanel({ collapsible: true });
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    expect(document.querySelector('[data-resize-dir]')).toBeNull();
  });

  it('keeps only the corner handle on mobile', () => {
    layout.mobile = true;
    renderPanel();
    const dirs = [...document.querySelectorAll('[data-resize-dir]')].map(e => e.getAttribute('data-resize-dir'));
    expect(dirs).toEqual(['se']);
  });

  it('a north shrink near the viewport bottom keeps the bottom edge (render clamp)', () => {
    // Drag the panel half off the bottom: the render clamp holds top at vh - 40.
    renderPanel();
    const bar = document.querySelector('[data-drag-handle]') as HTMLElement;
    fireEvent.pointerDown(bar, { pointerId: 8, clientX: 300, clientY: 310 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 300, clientY: 1000 });
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 300, clientY: 1000 });
    const before = geo();
    expect(before.top).toBe(window.innerHeight - 40);
    resize('n', 0, 400);
    const after = geo();
    expect(after.top + after.height).toBe(before.top + before.height);
    expect(after.top).toBeLessThanOrEqual(window.innerHeight - 40);
  });

  it('a second pointer cannot take over a running resize', () => {
    renderPanel();
    fireEvent.pointerDown(handle('e')!, { pointerId: 5, clientX: 300, clientY: 300 });
    fireEvent.pointerDown(handle('w')!, { pointerId: 6, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 250, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 340, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 340, clientY: 300 });
    // Width from the first pointer only (the second would have given 250).
    expect(geo().width).toBe(240);
  });

  it('maximizing mid-gesture ends the resize', async () => {
    renderPanel();
    fireEvent.pointerDown(handle('s')!, { pointerId: 7, clientX: 300, clientY: 300 });
    fireEvent.click(screen.getByLabelText('Expand window'));
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300, clientY: 340 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 300, clientY: 340 });
    fireEvent.click(screen.getByLabelText('Collapse window'));
    await waitFor(() => expect(geo()).toMatchObject({ left: 200, top: 300, width: 200, height: 200 }));
    expect(saved()).toBeNull();
  });

  it('a pointerdown inside the content does not start a resize', () => {
    renderPanel();
    const content = screen.getByTestId('panel-content');
    fireEvent.pointerDown(content, { pointerId: 4, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 200, clientY: 300 });
    expect(geo()).toMatchObject({ left: 200, top: 300, width: 200, height: 200 });
    expect(saved()).toBeNull();
  });
});
