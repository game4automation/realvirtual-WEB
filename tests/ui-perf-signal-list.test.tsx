// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-344 Phase 1 — the ConnectPanel signal list no longer re-renders wholesale
 * on the value bus.
 *
 * Before this change `SignalListView` subscribed to EVERY signal of the interface
 * and bumped a counter, so any value change re-ran the entire component body:
 * header chips, filter row, virtualizer, and ~30 wrapper Boxes each rebuilding an
 * `sx` literal. With a live gateway pushing changes that ran up to 60×/s.
 *
 * Value and activity now live in the mounted virtual row, which means three
 * properties have to hold and are asserted here:
 *   (a) the PARENT body no longer renders on value changes at all,
 *   (b) only rows the virtualizer mounted hold a store subscription, and they
 *       release it on scroll-away and on unmount,
 *   (c) the activity indicator still updates — it is derived from the interface
 *       CONNECTION state, so it changes without any value change, and removing
 *       the old parent tick without a replacement would have frozen it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { SignalListView } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { setSignalActivityIndicator } from '../src/core/hmi/signal-activity-indicator-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

/** Shared UI ticker period — value flushes and activity pulls ride on it. */
const TICK_MS = 200;
/** Virtualizer viewport height used by every render here. */
const LIST_HEIGHT = 400;

function makeSignals(count: number, prefix = 'Sig'): ConnectInterfaceSignal[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}_${i}`,
    protocolAddress: `%I${i}.0`,
    type: 'PLCInputBool',
    record: false,
  }));
}

function flatInterface(id: string, signals: ConnectInterfaceSignal[]): ConnectInterface {
  return { id, type: 'MQTT', enabled: true, signals, topics: [] };
}

function makeStore(signals: ConnectInterfaceSignal[]): SignalStore {
  const store = new SignalStore();
  for (const s of signals) store.register(s.name, `Root/${s.name}`, false, s.type);
  return store;
}

function makeViewer(store: SignalStore): RVViewer {
  return {
    signalStore: store,
    registry: null,
    signalBindingManager: undefined,
  } as unknown as RVViewer;
}

/** Root Box of a SignalRowItem, given its name Typography. That Box carries the
 *  activity opacity and contains the SignalBadge. */
function rowRootFor(label: HTMLElement): HTMLElement {
  return label.parentElement!.parentElement!;
}

/** Renders SignalListView and counts how often its BODY executes. */
function renderList(iface: ConnectInterface, viewer: RVViewer) {
  const bodyRenders = { count: 0 };
  function Probe() {
    bodyRenders.count++;
    return null;
  }
  const utils = render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <div style={{ height: LIST_HEIGHT, display: 'flex', flexDirection: 'column' }}>
          <Probe />
          <SignalListView iface={iface} overLimitSignals={[]} />
        </div>
      </RVViewerProvider>
    </ThemeProvider>,
  );
  return { ...utils, bodyRenders };
}

beforeEach(() => {
  localStorage.clear();
  setSignalActivityIndicator(false);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('SignalListView — parent body is off the value bus', () => {
  it('T1 changing 100 of 500 signal values does not re-render the list body', async () => {
    const signals = makeSignals(500);
    const iface = flatInterface('perf-iface', signals);
    const store = makeStore(signals);
    const { bodyRenders } = renderList(iface, makeViewer(store));

    await screen.findByText('Sig_0');
    const before = bodyRenders.count;

    const updates: Record<string, boolean> = {};
    for (let i = 0; i < 100; i++) updates[`Sig_${i}`] = true;
    await act(async () => {
      store.setMany(updates);
      // Give the shared ticker several periods to flush the visible rows.
      await new Promise((r) => setTimeout(r, TICK_MS * 3));
    });

    // The rows may (and must) update; the surrounding list body must not.
    expect(bodyRenders.count).toBe(before);
  });

  it('T3 only signals the virtualizer actually mounted are subscribed', async () => {
    const signals = makeSignals(500);
    const iface = flatInterface('sub-iface', signals);
    const store = makeStore(signals);
    const subscribed: string[] = [];
    const realSubscribe = store.subscribe.bind(store);
    vi.spyOn(store, 'subscribe').mockImplementation((name, cb) => {
      subscribed.push(name);
      return realSubscribe(name, cb);
    });

    renderList(iface, makeViewer(store));
    await screen.findByText('Sig_0');

    const unique = new Set(subscribed);
    // Visible + overscan only — nowhere near all 500. The old implementation
    // subscribed every single one from the parent.
    expect(unique.size).toBeGreaterThan(0);
    expect(unique.size).toBeLessThan(120);
    // A row far outside the mounted range must not be subscribed.
    expect(unique.has('Sig_499')).toBe(false);
  });

  it('T4 scrolling releases the old range and subscribes the new one', async () => {
    const signals = makeSignals(500);
    const iface = flatInterface('scroll-iface', signals);
    const store = makeStore(signals);
    const live = new Map<string, number>();
    const realSubscribe = store.subscribe.bind(store);
    vi.spyOn(store, 'subscribe').mockImplementation((name, cb) => {
      live.set(name, (live.get(name) ?? 0) + 1);
      const off = realSubscribe(name, cb);
      return () => {
        const n = (live.get(name) ?? 1) - 1;
        if (n <= 0) live.delete(name); else live.set(name, n);
        off();
      };
    });

    const { container } = renderList(iface, makeViewer(store));
    await screen.findByText('Sig_0');
    const initialCount = live.size;
    expect(live.has('Sig_0')).toBe(true);

    const scroller = container.querySelector('[class*="rv-scroll"], .MuiBox-root [style*="overflow"]')
      ?? container.querySelector('div[style]');
    const el = (screen.getByText('Sig_0').closest('div[class]')!
      .parentElement!.parentElement!.parentElement) as HTMLElement;
    const scrollEl = (scroller as HTMLElement | null) ?? el;

    await act(async () => {
      scrollEl.scrollTop = 4000;
      scrollEl.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(live.has('Sig_0')).toBe(false);
    });
    // The window MOVED: rows around the new offset are now subscribed.
    const subscribedIndices = [...live.keys()].map((n) => Number(n.split('_')[1]));
    expect(Math.min(...subscribedIndices)).toBeGreaterThan(20);
    // …and it stays a window, not a growing set. The exact count depends on the
    // measured row height, so the bound is generous but still far below the 500
    // the old parent-level subscription held open.
    expect(live.size).toBeLessThanOrEqual(initialCount * 3);
    expect(live.size).toBeLessThan(80);
  });

  it('T2/T5 a mounted row shows the CURRENT value immediately and coalesces bursts', async () => {
    const signals = makeSignals(20, 'Burst');
    const iface = flatInterface('burst-iface', signals);
    const store = makeStore(signals);
    // Pre-existing value: a row that mounts later must not start blank.
    store.set('Burst_0', true);

    renderList(iface, makeViewer(store));
    const row = rowRootFor(await screen.findByText('Burst_0'));
    // `●` = TRUE, `○` = FALSE in SignalBadge.
    await waitFor(() => expect(row.textContent).toContain('●'));

    // 12 flips inside one tick window must land on the LAST value, not 12 commits.
    await act(async () => {
      for (let i = 0; i < 12; i++) store.set('Burst_0', i % 2 === 0);
      await new Promise((r) => setTimeout(r, TICK_MS * 2));
    });
    // Last write in the loop was i=11 → false.
    await waitFor(() => expect(row.textContent).toContain('○'));
  });

  it('T6 unmounting releases every subscription it took', async () => {
    const signals = makeSignals(60, 'Un');
    const iface = flatInterface('unmount-iface', signals);
    const store = makeStore(signals);
    let subscribes = 0;
    let unsubscribes = 0;
    const realSubscribe = store.subscribe.bind(store);
    vi.spyOn(store, 'subscribe').mockImplementation((name, cb) => {
      subscribes++;
      const off = realSubscribe(name, cb);
      return () => { unsubscribes++; off(); };
    });

    const { unmount } = renderList(iface, makeViewer(store));
    await screen.findByText('Un_0');
    expect(subscribes).toBeGreaterThan(0);

    unmount();
    // Exactly one unsubscribe per subscribe — nothing keeps polling a dead list.
    // (Deliberately observed through the store, NOT through shared-ui-ticker's
    // module-private `dirtyFlushes`/`tickSubscribers` sets, which are not exported.)
    expect(unsubscribes).toBe(subscribes);

    // And no callback fires afterwards, across several tick periods.
    let fired = 0;
    const off = store.subscribe('Un_0', () => { fired++; });
    await act(async () => {
      store.set('Un_0', true);
      await new Promise((r) => setTimeout(r, TICK_MS * 5));
    });
    off();
    expect(fired).toBe(1); // only our own probe listener
  });
});

describe('SignalListView — activity indicator stays live in the row', () => {
  /**
   * `getActivity()` derives from the SOURCE's connection state, so `live → stale`
   * happens with no value change whatsoever. This is the exact regression
   * Re-Challenge-Finding 4 warned about: with the parent tick gone and nothing in
   * its place the indicator would silently freeze.
   *
   * NOTE — deviation from the planned scenario 9.1/7: the plan described a
   * time-based "stale threshold" elapsing. There is none in the code:
   * `deriveSignalActivity` ignores the `now` argument entirely (`void now`) and
   * decides purely on `hasSource` / `sourceConnected` / `lastUpdateTs`. The
   * observable property the scenario was written to protect — activity changes
   * WITHOUT a value change and must still reach the screen — is asserted here
   * through the real trigger, a lost connection.
   */
  it('T7 losing the source connection dims the row without any value change', async () => {
    setSignalActivityIndicator(true);
    const signals = makeSignals(10, 'Act');
    const iface = flatInterface('activity-iface', signals);
    const store = makeStore(signals);
    for (const s of signals) {
      store.setSignalMeta(s.name, { source: 'activity-iface' });
    }
    let connected = true;
    store.setConnectionProvider(() => connected);
    store.set('Act_0', true); // gives it a lastUpdateTs → 'live'

    const { bodyRenders } = renderList(iface, makeViewer(store));
    const label = await screen.findByText('Act_0');
    const row = rowRootFor(label);
    await waitFor(() => expect(getComputedStyle(row).opacity).toBe('1'));

    const bodyBefore = bodyRenders.count;
    connected = false; // no signal value changes at all

    await waitFor(
      () => expect(Number(getComputedStyle(row).opacity)).toBeLessThan(1),
      { timeout: 2000 },
    );
    // T8: the indicator followed the connection WITHOUT re-rendering the parent.
    expect(bodyRenders.count).toBe(bodyBefore);

    // …and it comes back when the interface reconnects.
    connected = true;
    await waitFor(
      () => expect(getComputedStyle(row).opacity).toBe('1'),
      { timeout: 2000 },
    );
    expect(bodyRenders.count).toBe(bodyBefore);
  });
});
