// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-477 §9.1 — `FloatingPanel` learns three things, and the 21 panels that
 * already use it learn nothing.
 *
 * The first describe is the load-bearing one: every new prop is opt-in, so a
 * panel that passes none must behave exactly as it did — close button, Escape,
 * maximize/restore, re-anchor on reopen, geometry written on close. The rest
 * pin `closable={false}`, the new `collapsed` state (which is NOT the existing
 * `expanded` maximize), and geometry persistence at the end of a drag.
 */

import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { FloatingPanel } from '../src/core/hmi/FloatingPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { setContext, _resetStore } from '../src/core/hmi/ui-context-store';

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

// The anchor store remembers the last pointerdown process-wide, so without this
// a drag in one test would re-anchor the panel of the next one. These tests are
// about geometry they set explicitly.
vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

// ─── Harness ────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;
}

function renderPanel(props: Partial<React.ComponentProps<typeof FloatingPanel>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Wrapper>
      <FloatingPanel open onClose={onClose} title="Test Panel" panelId="test-panel" {...props}>
        <div data-testid="panel-content">content</div>
      </FloatingPanel>
    </Wrapper>,
  );
  return { ...utils, onClose };
}

function panelEl(): HTMLElement {
  const el = document.querySelector('[data-ui-panel]');
  if (!el) throw new Error('no panel rendered');
  return el as HTMLElement;
}

/**
 * Geometry as the browser resolves it. `sx` becomes an emotion class, never an
 * inline style, so `element.style.left` is empty for every one of these.
 */
function geo() {
  const cs = getComputedStyle(panelEl());
  return {
    left: parseFloat(cs.left),
    top: parseFloat(cs.top),
    width: parseFloat(cs.width),
    height: parseFloat(cs.height),
  };
}

/** Small enough to survive the clamp in the 414px-wide headless viewport. */
const SMALL = { defaultWidth: 200, defaultHeight: 150, minWidth: 200, defaultPosition: { x: 100, y: 100 } };

function dragHandle(): HTMLElement {
  return document.querySelector('[data-drag-handle]') as HTMLElement;
}

/** A complete drag of the title bar by (dx, dy). */
function dragBy(dx: number, dy: number) {
  const handle = dragHandle();
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
}

function geoKey(id = 'test-panel') { return `rv-panel-geo:${id}`; }
function collapsedKey(id = 'test-panel') { return `rv-panel-collapsed:${id}`; }

let capture: ReturnType<typeof vi.spyOn>;
let release: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  layout.mobile = false;
  // Synthetic pointer events carry an id no real pointer owns, so the real
  // implementation throws NotFoundError. The hooks only use capture to keep
  // the stream; nothing under test depends on it.
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
  release = vi.spyOn(Element.prototype, 'releasePointerCapture').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  capture.mockRestore();
  release.mockRestore();
  setContext('kiosk', false);
  _resetStore();
  localStorage.clear();
});

// ─── Baseline: the existing 21 panels ───────────────────────────────────

describe('baseline — a panel that passes no new prop is unchanged', () => {
  it('renders the close button and closes on click', () => {
    const { onClose } = renderPanel();
    const close = screen.getByLabelText('Close window');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no collapse button and no landmark role by default', () => {
    renderPanel();
    expect(screen.queryByLabelText('Collapse panel')).toBeNull();
    expect(screen.queryByLabelText('Expand panel')).toBeNull();
    expect(panelEl().getAttribute('role')).toBeNull();
    expect(panelEl().getAttribute('aria-label')).toBeNull();
  });

  it('maximizes and restores through the expand button', async () => {
    renderPanel(SMALL);
    const before = geo().width;

    // Maximizing animates (`transition: all 0.25s`), so the resolved width
    // arrives a few frames after the click.
    fireEvent.click(screen.getByLabelText('Expand window'));
    await waitFor(() => expect(geo().width).toBeGreaterThan(before));

    fireEvent.click(screen.getByLabelText('Collapse window'));
    await waitFor(() => expect(geo().width).toBe(before));
  });

  it('renders the resize handle by default and a fixed height', () => {
    renderPanel({ ...SMALL, defaultHeight: 320 });
    expect(document.querySelector('[data-resize-handle]')).not.toBeNull();
    expect(geo().height).toBe(320);
  });

  it('writes its geometry when it closes, and nothing at the end of a drag', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Wrapper>
          <button type="button" onClick={() => setOpen(o => !o)}>toggle</button>
          <FloatingPanel open={open} onClose={() => setOpen(false)} title="T" panelId="test-panel"
            {...SMALL}>
            <div />
          </FloatingPanel>
        </Wrapper>
      );
    }
    render(<Host />);

    dragBy(40, 30);
    // A closable panel still uses the close path, not the drag end (F3).
    expect(localStorage.getItem(geoKey())).toBeNull();

    fireEvent.click(screen.getByText('toggle'));
    const saved = JSON.parse(localStorage.getItem(geoKey())!);
    expect(saved.x).toBe(140);
    expect(saved.y).toBe(130);
  });

  it('re-anchors when it reopens', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Wrapper>
          <button type="button" onClick={() => setOpen(o => !o)}>toggle</button>
          <FloatingPanel open={open} onClose={() => setOpen(false)} title="T" panelId="reopen-panel"
            {...SMALL}>
            <div />
          </FloatingPanel>
        </Wrapper>
      );
    }
    render(<Host />);
    dragBy(50, 0);
    expect(geo().left).toBe(150);

    fireEvent.click(screen.getByText('toggle'));   // close → saves 150
    expect(document.querySelector('[data-ui-panel]')).toBeNull();
    fireEvent.click(screen.getByText('toggle'));   // reopen → restores it
    expect(geo().left).toBe(150);
  });
});

// ─── closable = false (F1) ──────────────────────────────────────────────

describe('closable=false — a panel that is always there', () => {
  it('renders no close button and ignores Escape', () => {
    const { onClose } = renderPanel({ closable: false });
    expect(screen.queryByLabelText('Close window')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders even when open is false — and still drags', () => {
    render(
      <Wrapper>
        <FloatingPanel open={false} closable={false} title="T" panelId="test-panel" {...SMALL}>
          <div data-testid="panel-content">c</div>
        </FloatingPanel>
      </Wrapper>,
    );
    expect(screen.getByTestId('panel-content')).toBeTruthy();

    dragBy(60, 40);
    expect(geo().left).toBe(160);
    expect(geo().top).toBe(140);
  });

  it('stays inside the viewport when the window is resized, with open=false', () => {
    render(
      <Wrapper>
        <FloatingPanel open={false} closable={false} title="T" panelId="test-panel"
          defaultPosition={{ x: window.innerWidth - 60, y: 40 }} defaultWidth={200} defaultHeight={150}>
          <div />
        </FloatingPanel>
      </Wrapper>,
    );
    act(() => { fireEvent(window, new Event('resize')); });
    expect(geo().left + 200).toBeLessThanOrEqual(window.innerWidth);
  });

  it('needs no onClose at all', () => {
    expect(() => render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="test-panel"><div /></FloatingPanel>
      </Wrapper>,
    )).not.toThrow();
  });
});

// ─── Geometry persistence at drag/resize end (§2.5, F3) ─────────────────

describe('geometry persistence for a panel that never closes', () => {
  it('writes at the end of a drag', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="test-panel" {...SMALL}><div /></FloatingPanel>
      </Wrapper>,
    );
    dragBy(25, 15);
    const saved = JSON.parse(localStorage.getItem(geoKey())!);
    expect(saved).toMatchObject({ x: 125, y: 115 });
  });

  it('writes at the end of a resize', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="test-panel"
          defaultPosition={{ x: 100, y: 100 }} defaultWidth={500} defaultHeight={300}>
          <div />
        </FloatingPanel>
      </Wrapper>,
    );
    const handle = document.querySelector('[data-resize-handle]') as HTMLElement;
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 800, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 860, clientY: 550 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 860, clientY: 550 });

    const saved = JSON.parse(localStorage.getItem(geoKey())!);
    expect(saved.w).toBe(560);
    expect(saved.h).toBe(350);
  });

  it('does NOT write on a pointerup that belongs to someone else', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="test-panel" {...SMALL}><div /></FloatingPanel>
      </Wrapper>,
    );
    // A click that started in the 3D scene: the window-level pointerup is seen
    // by every mounted panel, and must end nothing (F3).
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 10, clientY: 10 });
    expect(localStorage.getItem(geoKey())).toBeNull();
  });

  it('does NOT write the maximized geometry', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="test-panel" {...SMALL}><div /></FloatingPanel>
      </Wrapper>,
    );
    fireEvent.click(screen.getByLabelText('Expand window'));
    dragBy(10, 10);
    expect(localStorage.getItem(geoKey())).toBeNull();
  });

  it('does NOT write while collapsed', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} collapsible title="T" panelId="test-panel" {...SMALL}><div /></FloatingPanel>
      </Wrapper>,
    );
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    dragBy(10, 10);
    expect(localStorage.getItem(geoKey())).toBeNull();
  });
});

// ─── collapsed (F2, §2.4) ───────────────────────────────────────────────

describe('collapsed is not maximized', () => {
  it('unmounts the content, keeps the title bar, keeps width and position', () => {
    renderPanel({ ...SMALL, collapsible: true });
    const before = geo();
    expect(screen.getByTestId('panel-content')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Collapse panel'));

    expect(screen.queryByTestId('panel-content')).toBeNull();
    expect(screen.getByText('Test Panel')).toBeTruthy();
    const after = geo();
    expect(after.width).toBe(before.width);
    expect(after.left).toBe(before.left);
    // Height follows the title bar instead of the configured one.
    expect(after.height).toBeLessThan(before.height);
    expect(after.height).toBeLessThanOrEqual(40);
  });

  it('reports itself through aria-expanded / aria-controls', () => {
    renderPanel({ collapsible: true });
    const btn = screen.getByLabelText('Collapse panel');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const contentId = btn.getAttribute('aria-controls')!;
    expect(document.getElementById(contentId)).not.toBeNull();

    fireEvent.click(btn);
    expect(screen.getByLabelText('Expand panel').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(contentId)).toBeNull();
  });

  it('leaves maximize when it collapses', async () => {
    renderPanel({ ...SMALL, collapsible: true });
    const normalW = geo().width;
    fireEvent.click(screen.getByLabelText('Expand window'));
    await waitFor(() => expect(geo().width).not.toBe(normalW));

    fireEvent.click(screen.getByLabelText('Collapse panel'));
    fireEvent.click(screen.getByLabelText('Expand panel'));
    await waitFor(() => expect(geo().width).toBe(normalW));
  });

  it('is not offered at all without `collapsible`', () => {
    renderPanel();
    expect(screen.queryByLabelText('Collapse panel')).toBeNull();
  });

  it('never maximizes on two quick clicks of the collapse button (F9)', () => {
    renderPanel({ ...SMALL, collapsible: true });
    const normalW = geo().width;
    const btn = screen.getByLabelText('Collapse panel');

    fireEvent.pointerUp(btn, { pointerId: 3 });
    fireEvent.pointerUp(btn, { pointerId: 3 });

    expect(geo().width).toBe(normalW);
  });
});

describe('persistCollapsed', () => {
  it('writes the key and reads it back on remount', () => {
    renderPanel({ collapsible: true, persistCollapsed: true });
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    expect(localStorage.getItem(collapsedKey())).toBe('1');

    cleanup();
    renderPanel({ collapsible: true, persistCollapsed: true });
    expect(screen.queryByTestId('panel-content')).toBeNull();
    expect(screen.getByLabelText('Expand panel')).toBeTruthy();
  });

  it('starts collapsed on mobile', () => {
    layout.mobile = true;
    renderPanel({ collapsible: true, persistCollapsed: true });
    expect(screen.queryByTestId('panel-content')).toBeNull();
  });

  it('lets a stored value beat the mobile default', () => {
    layout.mobile = true;
    localStorage.setItem(collapsedKey(), '0');
    renderPanel({ collapsible: true, persistCollapsed: true });
    expect(screen.getByTestId('panel-content')).toBeTruthy();
  });

  it('writes nothing without persistCollapsed', () => {
    renderPanel({ collapsible: true });
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    expect(localStorage.getItem(collapsedKey())).toBeNull();
  });
});

// ─── Kiosk override (F14 / A1) ──────────────────────────────────────────

describe('kiosk override', () => {
  it('forces collapsed while kiosk is active and restores afterwards, persisting nothing', () => {
    renderPanel({ collapsible: true, persistCollapsed: true });
    expect(screen.getByTestId('panel-content')).toBeTruthy();

    act(() => { setContext('kiosk', true); });
    expect(screen.queryByTestId('panel-content')).toBeNull();
    expect(screen.getByText('Test Panel')).toBeTruthy();
    expect(localStorage.getItem(collapsedKey())).toBe('0');

    act(() => { setContext('kiosk', false); });
    expect(screen.getByTestId('panel-content')).toBeTruthy();
  });

  it('does not touch a panel that is not collapsible', () => {
    renderPanel();
    act(() => { setContext('kiosk', true); });
    expect(screen.getByTestId('panel-content')).toBeTruthy();
  });
});

// ─── autoHeight / resizable (F4) ────────────────────────────────────────

describe('autoHeight and resizable', () => {
  it('renders no resize handle with resizable=false', () => {
    renderPanel({ ...SMALL, resizable: false });
    expect(document.querySelector('[data-resize-handle]')).toBeNull();
  });

  it('takes its height from the content with autoHeight', () => {
    renderPanel({ ...SMALL, autoHeight: true, defaultHeight: 900 });
    expect(geo().height).toBeLessThan(900);
    expect(geo().height).toBeLessThan(120);
  });

  it('passes role and aria-label through when given', () => {
    renderPanel({ role: 'region', 'aria-label': 'Ribbon Tension' });
    expect(panelEl().getAttribute('role')).toBe('region');
    expect(panelEl().getAttribute('aria-label')).toBe('Ribbon Tension');
  });
});

// ─── A4: first mount clamps against the window, not a portal root ───────

describe('A4 — first mount geometry', () => {
  it('clamps an off-screen default position into the window on the very first render', () => {
    render(
      <Wrapper>
        <FloatingPanel open closable={false} title="T" panelId="a4-panel"
          defaultPosition={{ x: 99999, y: 99999 }} defaultWidth={200} defaultHeight={150}>
          <div />
        </FloatingPanel>
      </Wrapper>,
    );
    const { left, top } = geo();
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(top)).toBe(true);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
  });
});

// ─── Close and unmount save the same normal rectangle ───────────────────

describe('geometry persistence on unmount', () => {
  type HostProps = Partial<React.ComponentProps<typeof FloatingPanel>>;

  /** A host that unmounts the panel (like the AI prompt window) or closes it via `open`. */
  function Host(props: HostProps) {
    const [mounted, setMounted] = useState(true);
    const [open, setOpen] = useState(true);
    return (
      <Wrapper>
        <button type="button" onClick={() => setMounted(m => !m)}>mount</button>
        <button type="button" onClick={() => setOpen(o => !o)}>open</button>
        {mounted && (
          <FloatingPanel open={open} onClose={() => setOpen(false)} title="T" panelId="test-panel" {...SMALL} {...props}>
            <div data-testid="panel-content" />
          </FloatingPanel>
        )}
      </Wrapper>
    );
  }

  const saved = () => JSON.parse(localStorage.getItem(geoKey())!);

  function resizeBy(dw: number, dh: number) {
    const handle = document.querySelector('[data-resize-handle]') as HTMLElement;
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 300 + dw, clientY: 300 + dh });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 300 + dw, clientY: 300 + dh });
  }

  it('restores a moved and resized panel after unmount and remount', () => {
    render(<Host />);
    dragBy(40, 30);
    resizeBy(30, 70);

    fireEvent.click(screen.getByText('mount'));
    expect(saved()).toEqual({ x: 140, y: 130, w: 230, h: 220 });

    fireEvent.click(screen.getByText('mount'));
    expect(geo()).toMatchObject({ left: 140, top: 130, width: 230, height: 220 });
  });

  it('saves the latest normal rectangle, not the maximized one, when unmounted while maximized', async () => {
    render(<Host />);
    dragBy(40, 30);
    fireEvent.click(screen.getByLabelText('Expand window'));
    await waitFor(() => expect(geo().width).toBeGreaterThan(200));

    fireEvent.click(screen.getByText('mount'));
    expect(saved()).toEqual({ x: 140, y: 130, w: 200, h: 150 });
  });

  it('close via open={false} saves the same normal rectangle as unmount, even while maximized', async () => {
    render(<Host />);
    dragBy(40, 30);
    fireEvent.click(screen.getByLabelText('Expand window'));
    await waitFor(() => expect(geo().width).toBeGreaterThan(200));

    fireEvent.click(screen.getByText('open'));
    expect(saved()).toEqual({ x: 140, y: 130, w: 200, h: 150 });
  });

  it('ignores a move while collapsed and keeps the collapsed preference', () => {
    render(<Host collapsible persistCollapsed />);
    dragBy(40, 30);
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    dragBy(20, 20);

    fireEvent.click(screen.getByText('mount'));
    expect(saved()).toEqual({ x: 140, y: 130, w: 200, h: 150 });
    expect(localStorage.getItem(collapsedKey())).toBe('1');
  });

  it('writes nothing for a panel only ever used in the mobile layout', () => {
    layout.mobile = true;
    render(<Host />);
    dragBy(10, 10);
    fireEvent.click(screen.getByText('mount'));
    expect(localStorage.getItem(geoKey())).toBeNull();
  });

  it('keeps the desktop rectangle through a breakpoint change to mobile', () => {
    const { rerender } = render(<Host />);
    dragBy(40, 30);
    layout.mobile = true;
    rerender(<Host />);
    dragBy(10, 10);
    // The breakpoint change itself is not an unmount and writes nothing.
    expect(localStorage.getItem(geoKey())).toBeNull();

    fireEvent.click(screen.getByText('mount'));
    expect(saved()).toEqual({ x: 140, y: 130, w: 200, h: 150 });
  });

  it('saves the current rectangle after a breakpoint change from mobile to desktop, without a drag', () => {
    layout.mobile = true;
    const { rerender } = render(<Host />);
    layout.mobile = false;
    rerender(<Host />);
    const { left, top, width, height } = geo();

    fireEvent.click(screen.getByText('mount'));
    expect(saved()).toEqual({ x: left, y: top, w: width, h: height });
  });

  it('does not overwrite seeded geometry with defaults under StrictMode', () => {
    const seeded = { x: 120, y: 110, w: 210, h: 230 };
    localStorage.setItem(geoKey(), JSON.stringify(seeded));
    const { unmount } = render(<StrictMode><Host /></StrictMode>);
    expect(geo()).toMatchObject({ left: 120, top: 110, width: 210, height: 230 });

    unmount();
    expect(saved()).toEqual(seeded);
  });
});
