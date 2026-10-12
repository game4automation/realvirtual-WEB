// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-556 Phase 1 — the recording HMI (`src/core/engine/rv-recording-hmi.ts`):
 *
 *  - the settle order (ticker flush → ONE commit barrier → animation freeze → rAF) makes every
 *    supported read-out show the frame's value right after the settle: a push consumer
 *    (`useThrottledSignalValue`), a consumer MOUNTED by the commit, the property inspector's
 *    `useSignalTick` / `useChangeGatedTick` and the ConnectPanel's `subscribeTick` pull consumer;
 *  - the wall-clock timers are REPLACED while recording and resume afterwards;
 *  - the PilotLamp blink phase follows the recording clock on both sides of the 250 ms boundary;
 *  - underlay, layer mode, panel ids / warnings, and the recording-shell inventory of App.tsx.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  _resetRecordingHmi, captureHmiSettle, commitBarrier, enterRecordingHmi, exitRecordingHmi, freezeAnimations,
  isRecordingHmiActive, recordingNow, recordingPanelIds, RECORDING_UNDERLAY_ID, setLayerMode, setUnderlay,
  validateHmiOpen, type RecordingHmiHost,
} from '../src/core/engine/rv-recording-hmi';
import { activeTimerCount, isRecordingTicks, subscribeTick } from '../src/hooks/shared-ui-ticker';
import { useThrottledSignalValue } from '../src/hooks/use-throttled-signal';
import { useSignalTick } from '../src/hooks/use-signal-tick';
import { useChangeGatedTick } from '../src/hooks/use-change-gated-tick';
import { isContextActive } from '../src/core/hmi/ui-context-store';
import { PilotLamp } from '../src/core/hmi/operator-devices/PilotLamp';
import { RecordingFrameProbe, RECORDING_SHELL_INVENTORY, recordingOverlayEntries } from '../src/core/hmi/App';
import { OperatorPanelController } from '../src/core/hmi/operator-devices/operator-panel-model';
import { allowRecordingOverlay } from '../src/core/engine/rv-recording-hmi';
import appSource from '../src/core/hmi/App.tsx?raw';
import type { UISlotEntry } from '../src/core/rv-ui-plugin';

const host = (over: Partial<RecordingHmiHost> = {}): RecordingHmiHost => {
  const active: Record<'left' | 'right', string | null> = { left: null, right: null };
  return {
    leftPanelManager: {
      open: (id) => { active.left = id; },
      close: (id) => { if (active.left === id) active.left = null; if (active.right === id) active.right = null; },
      getActive: (side) => active[side],
    },
    webOperatorPanels: { getEntries: () => [{ panelId: 'op-station' }] },
    operatorPanelPluginIds: () => ['op-plugin'],
    ...over,
  };
};

beforeEach(() => { _resetRecordingHmi(); });
afterEach(() => {
  cleanup();
  _resetRecordingHmi();
  document.getElementById('rv-viewport')?.remove();
});

/** A pull consumer like the ConnectPanel rows (`useSignalActivityValue`): subscribeTick → setState. */
function usePulled(read: () => number): number {
  const [v, setV] = useState(read);
  useEffect(() => subscribeTick(() => setV(read())), [read]);
  return v;
}

function Probe({ store }: { store: SignalStore }) {
  const pushed = useThrottledSignalValue(store, 'A');
  useSignalTick(store, 200);
  const gated = useChangeGatedTick({ read: () => store.get('G') });
  const pulled = usePulled(readP);
  return (
    <div>
      <span data-testid="push">{String(pushed)}</span>
      {/* the inspector pattern: a tick re-renders, the render reads the store */}
      <span data-testid="tick">{String(store.get('T'))}</span>
      <span data-testid="gated">{String(store.get('G'))}:{gated > 0 ? 'changed' : 'initial'}</span>
      <span data-testid="pull">{pulled}</span>
      {typeof pushed === 'number' && pushed >= 5 && <Mounted store={store} />}
      <RecordingFrameProbe />
    </div>
  );
}

let pulledValue = 0;
function readP(): number { return pulledValue; }

/** Mounted by the commit of the frame that raised A — a NEW ticker consumer in that frame. */
function Mounted({ store }: { store: SignalStore }) {
  const b = useThrottledSignalValue(store, 'B');
  return <span data-testid="mounted">{String(b)}</span>;
}

describe('settle order: flush → one barrier → freeze → rAF (F4, Phase-1 gate)', () => {
  it('every supported read-out shows the frame value right after ONE settle — also a consumer the commit mounted', async () => {
    const store = new SignalStore();
    store.set('A', 1); store.set('B', 7); store.set('T', 1); store.set('G', 1);
    render(<Probe store={store} />);
    enterRecordingHmi(host());
    expect(isRecordingTicks()).toBe(true);
    // One video frame: the simulation wrote new values; the settle must show all of them.
    await act(async () => {
      store.set('A', 5); store.set('B', 9); store.set('T', 2); store.set('G', 3);
      pulledValue = 4;
      await captureHmiSettle(1000);
    });
    expect(screen.getByTestId('push').textContent).toBe('5');
    expect(screen.getByTestId('tick').textContent).toBe('2');
    expect(screen.getByTestId('gated').textContent).toBe('3:changed');
    expect(screen.getByTestId('pull').textContent).toBe('4');
    // mounted in this frame's commit — reads its store value on mount
    expect(screen.getByTestId('mounted').textContent).toBe('9');
    await act(async () => {
      store.set('B', 11);
      await captureHmiSettle(1033);
    });
    expect(screen.getByTestId('mounted').textContent).toBe('11');
    expect(recordingNow()).toBe(1033);
  });

  it('nothing moves between two settles: the wall-clock timers are replaced while recording', async () => {
    const store = new SignalStore();
    store.set('A', 1);
    render(<Probe store={store} />);
    expect(activeTimerCount()).toBeGreaterThan(0);
    enterRecordingHmi(host());
    expect(activeTimerCount()).toBe(0);
    await act(async () => {
      store.set('A', 2);
      await new Promise((r) => setTimeout(r, 450)); // > 2 ticks of 200 ms
    });
    expect(screen.getByTestId('push').textContent).toBe('1');
    exitRecordingHmi(host());
    expect(isRecordingTicks()).toBe(false);
    expect(activeTimerCount()).toBeGreaterThan(0);
    // the wall clock drives the read-outs again
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(screen.getByTestId('push').textContent).toBe('2');
  });

  it('commit barrier: acknowledged by the probe after React committed; without a probe it resolves at once', async () => {
    expect(await commitBarrier(1000)).toBe(-1);
    render(<RecordingFrameProbe />);
    let ack = -2;
    await act(async () => { ack = await commitBarrier(1000); });
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(ack).toBeLessThan(1000);
  });

  it('a settle step that never commits is bounded by its timeout', async () => {
    // A probe that is subscribed but never acknowledges.
    const { subscribeRecordingFrame } = await import('../src/core/engine/rv-recording-hmi');
    const off = subscribeRecordingFrame(() => undefined);
    await expect(captureHmiSettle(0, { timeoutMs: 50 })).rejects.toThrow(/did not commit/);
    off();
  });
});

describe('animation freeze at the recording clock (F4/N1)', () => {
  it('PilotLamp blink: lit before 250 ms, dark after, at rate 0; the blink runs again after the recording', async () => {
    render(<div><PilotLamp name="Fault" color="red" on flash /><RecordingFrameProbe /></div>);
    enterRecordingHmi(host());
    const lamp = screen.getByRole('img', { name: /Fault lamp/ });
    await act(async () => { await captureHmiSettle(233); });
    const anim = document.getAnimations().find((a) => (a as CSSAnimation).animationName === 'rv-operator-lamp-flash')!;
    expect(anim).toBeTruthy();
    expect(anim.playbackRate).toBe(0);
    expect(anim.currentTime).toBe(233);
    const lit = getComputedStyle(lamp).boxShadow;
    await act(async () => { await captureHmiSettle(267); });
    const dark = getComputedStyle(lamp).boxShadow;
    expect(lit).not.toBe('none');
    expect(dark).toBe('none');
    // two settles at the same clock give the same phase (determinism)
    await act(async () => { await captureHmiSettle(233); });
    expect(getComputedStyle(lamp).boxShadow).toBe(lit);
    exitRecordingHmi(host());
    expect(anim.playbackRate).toBe(1);
  });

  it('freezeAnimations returns the number of animations it froze', () => {
    expect(freezeAnimations(0)).toBe(0);
  });
});

describe('underlay + layer mode (F5/F6)', () => {
  it('shows the snapshot above the hidden #rv-viewport and restores it', async () => {
    const vp = document.createElement('div');
    vp.id = 'rv-viewport';
    document.body.appendChild(vp);
    const c = new OffscreenCanvas(8, 6);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 6);
    setUnderlay(await createImageBitmap(c), { bottomCss: 8 });
    const u = document.getElementById(RECORDING_UNDERLAY_ID) as HTMLCanvasElement;
    expect(u).toBeTruthy();
    expect([u.width, u.height]).toEqual([8, 6]);
    expect(u.style.zIndex).toBe('999');
    expect(u.style.height).toContain('8px');
    expect(vp.style.visibility).toBe('hidden');
    setLayerMode(true);
    expect(getComputedStyle(u).visibility).toBe('hidden');
    expect(getComputedStyle(document.body).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    setLayerMode(false);
    expect(getComputedStyle(u).visibility).toBe('visible');
    setUnderlay(null);
    expect(document.getElementById(RECORDING_UNDERLAY_ID)).toBeNull();
    expect(vp.style.visibility).toBe('');
  });
});

describe('enter / exit (F2/F3)', () => {
  it('activates the recording context, pins UI zoom, expands requested operator panels and restores all of it', () => {
    localStorage.setItem('rv-panel-collapsed:op-station', '1');
    const h = host();
    const r = enterRecordingHmi(h, { open: ['op-station', 'connect'] });
    expect(isRecordingHmiActive()).toBe(true);
    expect(isContextActive('recording')).toBe(true);
    expect(localStorage.getItem('rv-panel-collapsed:op-station')).toBe('0');
    expect(h.leftPanelManager!.getActive('left')).toBe('connect');
    expect(r.warnings).toEqual([]);
    expect(document.getElementById('rv-recording-hmi-style')?.textContent).toMatch(/rv-watermark/);
    exitRecordingHmi(h);
    expect(isRecordingHmiActive()).toBe(false);
    expect(isContextActive('recording')).toBe(false);
    expect(localStorage.getItem('rv-panel-collapsed:op-station')).toBe('1');
    expect(h.leftPanelManager!.getActive('left')).toBeNull();
    expect(document.getElementById('rv-recording-hmi-style')).toBeNull();
    localStorage.removeItem('rv-panel-collapsed:op-station');
  });

  it('warns about a visible side panel that is not supported (it is not recorded)', () => {
    const h = host();
    h.leftPanelManager!.open('hierarchy', 300);
    const r = enterRecordingHmi(h);
    expect(r.warnings).toEqual(['unsupported panel visible: hierarchy (it is not part of the recording)']);
  });

  it('--hmi-open accepts operator panel ids and supported side panels only, naming the supported list', () => {
    const h = host();
    expect(recordingPanelIds(h)).toEqual({ operator: ['op-plugin', 'op-station'], side: ['connect'] });
    expect(validateHmiOpen(h, ['op-station', 'connect'])).toBeNull();
    expect(validateHmiOpen(h, ['hierarchy'])).toBe('--hmi-open: unsupported panel id "hierarchy" — supported: op-plugin, op-station, connect.');
  });
});

describe('recording shell inventory (F3)', () => {
  it('every element FullHmiShell (and the App root) mounts is listed as kept or hidden', () => {
    const full = appSource.slice(appSource.indexOf('function FullHmiShell('), appSource.indexOf('// ─── Recording shell'));
    const root = appSource.slice(appSource.indexOf('export function App()'), appSource.indexOf('/** Dedicated gate subtree'));
    const names = new Set<string>();
    for (const src of [full, root]) {
      for (const m of src.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) names.add(m[1]);
    }
    // Rendered by both shells / not chrome: the theme wrapper and the shell switch itself.
    for (const n of ['ThemeProvider', 'CssBaseline', 'ConnectEmbedMinimalShell', 'FullHmiShell', 'RecordingHmiShell', 'C', 'Comp']) names.delete(n);
    const missing = [...names].filter((n) => !(n in RECORDING_SHELL_INVENTORY));
    expect(missing).toEqual([]);
    expect(RECORDING_SHELL_INVENTORY.TopBar).toBe('hidden');
    expect(RECORDING_SHELL_INVENTORY.ConnectPanel).toBe('kept');
  });

  it('the overlay slot keeps operator panels (model + plugin) and the allow-list, nothing else', () => {
    const Dummy = () => null;
    const entries: UISlotEntry[] = [
      { slot: 'overlay', component: Dummy, pluginId: 'web-operator-panels' },
      { slot: 'overlay', component: Dummy, pluginId: 'op-plugin' },
      { slot: 'overlay', component: Dummy, pluginId: 'save-dialogs' },
      { slot: 'overlay', component: Dummy, pluginId: 'my-readout' },
    ];
    const plugins: Record<string, unknown> = { 'op-plugin': { controller: new OperatorPanelController({ id: 'op-plugin', title: 'x', buttons: [], selectors: [], estops: [], stackLight: [] }) } };
    const viewer = { getPlugin: (id: string) => plugins[id] } as never;
    expect(recordingOverlayEntries(entries, viewer).map((e) => e.pluginId)).toEqual(['web-operator-panels', 'op-plugin']);
    allowRecordingOverlay('my-readout');
    expect(recordingOverlayEntries(entries, viewer).map((e) => e.pluginId)).toEqual(['web-operator-panels', 'op-plugin', 'my-readout']);
  });
});
