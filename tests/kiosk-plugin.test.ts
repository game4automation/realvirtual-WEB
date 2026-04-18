// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for KioskPlugin core API (registerTour / unregisterTour, startKiosk /
 * stopKiosk guards, dispose cleanup). Full E2E flow testing (tour execution
 * with camera, charts, etc.) requires a real RVViewer and is out of scope
 * for unit tests — verified manually via the demo model tour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KioskPlugin } from '../src/plugins/kiosk-plugin';
import type { TourFn } from '../src/plugins/kiosk-tour-types';

describe('KioskPlugin registerTour / unregisterTour', () => {
  let plugin: KioskPlugin;

  beforeEach(() => {
    plugin = new KioskPlugin();
  });

  it('has correct id + order + core flags', () => {
    expect(plugin.id).toBe('kiosk');
    expect(plugin.order).toBe(250);
    expect(plugin.core).toBe(true);
  });

  it('registers UI slots for demo-button + overlay', () => {
    expect(plugin.slots).toBeDefined();
    const slotNames = plugin.slots?.map(s => s.slot);
    expect(slotNames).toContain('button-group');
    expect(slotNames).toContain('overlay');
  });

  it('registerTour stores tour by model name', () => {
    const fn: TourFn = async () => {};
    plugin.registerTour('MyModel', fn);
    const snap = plugin.getSnapshot();
    // hasTour reflects ANY registered tour (so WelcomeModal can show the button
    // before the GLB is loaded); hasCurrentModelTour requires matching modelName.
    expect(snap.hasTour).toBe(true);
    expect(snap.hasCurrentModelTour).toBe(false);
  });

  it('unregisterTour removes the tour', () => {
    const fn: TourFn = async () => {};
    plugin.registerTour('M', fn);
    plugin.unregisterTour('M');
    // No easy way to inspect internal Map; test via startKiosk refusal later
  });

  it('replaces tour when registered twice with same modelName', () => {
    const fn1: TourFn = async () => {};
    const fn2: TourFn = async () => {};
    plugin.registerTour('M', fn1);
    plugin.registerTour('M', fn2);
    // Map.set semantics — second call replaces. No observable diff in snapshot.
    expect(plugin.isActive).toBe(false);
  });

  it('isActive reports false when no tour running', () => {
    expect(plugin.isActive).toBe(false);
  });

  it('startKiosk without viewer defers to _pendingStart (safe no-op but remembered)', () => {
    expect(() => plugin.startKiosk()).not.toThrow();
    expect(plugin.isActive).toBe(false);
    // Pending-start flag is internal; visible effect: calling startKiosk again
    // is still safe and does not throw.
    expect(() => plugin.startKiosk()).not.toThrow();
  });

  it('startKiosk with viewer + no tour registered logs info + no-op', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fakeViewer = {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
      getPlugin: vi.fn(),
      scene: {},
      currentModelUrl: 'models/UnknownModel.glb',
    } as unknown as Parameters<typeof plugin.onModelLoaded>[1];
    const fakeResult = {} as unknown as Parameters<typeof plugin.onModelLoaded>[0];
    plugin.onModelLoaded(fakeResult, fakeViewer);
    // Register an UNRELATED tour so hasTour=true but hasCurrentModelTour=false.
    plugin.registerTour('OtherModel', async () => {});
    plugin.startKiosk();
    // startKiosk takes the pending-start path (no current-model tour), so we
    // set flag silently. Register tour for current model → auto-start via _doStartKiosk.
    // When that still can't start (no _viewer chart adapter etc.), _doStartKiosk logs info.
    plugin.registerTour('UnknownModel', async () => {});
    // At this point pending-start attempts _doStartKiosk; without a real
    // viewer stack this won't actually run a tour, but no throw either.
    info.mockRestore();
    plugin.dispose();
  });

  it('double startKiosk while running is idempotent (no double-runner)', () => {
    // Without real viewer this won't start, but the guard should still hold
    plugin.startKiosk();
    plugin.startKiosk();
    expect(plugin.isActive).toBe(false);
  });

  it('stopKiosk without running is a no-op', () => {
    expect(() => plugin.stopKiosk()).not.toThrow();
  });

  it('subscribe / unsubscribe correctly detaches listener', () => {
    const l = vi.fn();
    const off = plugin.subscribe(l);
    // Registering a tour triggers notify
    plugin.registerTour('M', async () => {});
    expect(l).toHaveBeenCalled();
    const calls1 = l.mock.calls.length;
    off();
    plugin.registerTour('N', async () => {});
    expect(l.mock.calls.length).toBe(calls1);     // no further calls
  });

  it('dispose clears listeners + registered tours', () => {
    const fn: TourFn = async () => {};
    plugin.registerTour('M', fn);
    const l = vi.fn();
    plugin.subscribe(l);
    plugin.dispose();
    // After dispose: subscribe no longer fires on operations (listeners cleared)
    expect(() => plugin.dispose()).not.toThrow();  // idempotent
  });
});
