// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { createElement } from 'react';
import { render, within, cleanup, fireEvent, act } from '@testing-library/react';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { SpaceMousePlugin } from '../src/plugins/spacemouse-plugin';
import { saveVisualSettings, loadVisualSettings } from '../src/core/hmi/visual-settings-store';
import { SPACEMOUSE_SETTINGS_KEY, readLocalStorage, removeLocalStorage } from '../src/core/hmi/rv-storage-keys';
import { setAppConfig } from '../src/core/hmi/rv-app-config';
import { defaultSpaceMouseSettings } from '../src/core/engine/rv-spacemouse-nav';
class FakeDevice extends EventTarget {
  vendorId = 0x256f;
  productName = 'Test SpaceMouse';
  opened = false;
  open = vi.fn(async () => {
    this.opened = true;
  });
  close = vi.fn(async () => {
    this.opened = false;
  });
  send(id: number, values: number[]) {
    const data = new DataView(new ArrayBuffer(id === 3 ? 1 : values.length * 2));
    if (id === 3)
      data.setUint8(0, values[0]);
    else
      values.forEach((v, i) => data.setInt16(i * 2, v, true));
    this.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: id, data }));
  }
}
let handle: TestViewerHandle | undefined;
let hid: EventTarget & {
  getDevices: ReturnType<typeof vi.fn>;
  requestDevice: ReturnType<typeof vi.fn>;
};
let originalHidDescriptor: PropertyDescriptor | undefined;
let device: FakeDevice;
let plugin: SpaceMousePlugin;
// The viewer's render loop runs during every await; its OrbitControls.update() round trip
// (spherical <-> cartesian, lookAt) may move the camera by float noise only (~1e-16).
// A report-driven step moves it by about distance * speed * dt (~1), so 1e-9 still proves "no motion".
function expectStill(actual: Vector3, expected: Vector3) {
  expect(actual.distanceTo(expected)).toBeLessThan(1e-9);
}
function delayOpen(target: FakeDevice): () => void {
  let release = () => { };
  target.open.mockImplementation(() => new Promise<void>(resolve => {
    release = () => {
      target.opened = true;
      resolve();
    };
  }));
  return () => release();
}
function inputListeners(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => call[0] === 'inputreport').length;
}
/** Viewer + registered plugin, not connected; `withHid = false` simulates a browser without WebHID. */
async function mount(withHid = true) {
  device = new FakeDevice();
  hid = Object.assign(new EventTarget(), {
    getDevices: vi.fn(async () => []),
    requestDevice: vi.fn(async () => [device]),
  });
  originalHidDescriptor = Object.getOwnPropertyDescriptor(navigator, 'hid');
  Object.defineProperty(navigator, 'hid', { value: withHid ? hid : undefined, configurable: true });
  handle = await createTestViewer('webgl');
  plugin = new SpaceMousePlugin();
  handle.viewer.use(plugin, 'internal');
  return handle.viewer;
}
let ui: ReturnType<typeof within>;
function renderTab() {
  const tab = plugin.slots.find(e => e.slot === 'settings-tab')!;
  const result = render(createElement(tab.component, { viewer: handle!.viewer }));
  ui = within(result.container);
  return result;
}
function statusText(): string {
  return ui.getByRole('status').textContent ?? '';
}
function connectButton(): HTMLButtonElement {
  return ui.getByRole('button', { name: 'Connect SpaceMouse' }) as HTMLButtonElement;
}
function switchInput(label: string): HTMLInputElement {
  return ui.getByLabelText(label) as HTMLInputElement;
}
// SliderRow forwards no accessible name: find the range input in the row of its label.
function sliderInput(label: string): HTMLInputElement {
  return ui.getByText(label).parentElement!.querySelector('input')!;
}
async function setup() {
  const v = await mount();
  plugin.configure({ Smoothing: 0 });
  await plugin.connect();
  v.camera.position.set(0, 0, 10);
  v.camera.quaternion.identity();
  v.controls.target.set(0, 0, 0);
  v.navController?.resetPivot();
  return v;
}
afterEach(() => {
  cleanup();
  setAppConfig({});
  handle?.dispose();
  handle = undefined;
  if (originalHidDescriptor) {
    Object.defineProperty(navigator, 'hid', originalHidDescriptor);
  } else {
    delete (navigator as unknown as {
      hid?: unknown;
    }).hid;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeLocalStorage(SPACEMOUSE_SETTINGS_KEY);
});
describe('SpaceMousePlugin', () => {
  it('moves and marks dirty without a model while simulation is paused; capture discards input', async () => {
    const v = await setup();
    v.logicRunState = 'gated';
    expect(v.logicRunState).not.toBe('active');
    const dirty = vi.spyOn(v, 'markRenderDirty');
    const cancel = vi.spyOn(v, 'cancelCameraAnimation');
    device.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(1 / 60, 0);
    expect(v.camera.position.x).toBeGreaterThan(0);
    expect(dirty).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    const position = v.camera.position.clone();
    vi.spyOn(v, 'isCapturing', 'get').mockReturnValue(true);
    device.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(1 / 60, 1);
    expect(v.camera.position.equals(position)).toBe(true);
    vi.spyOn(v, 'isCapturing', 'get').mockReturnValue(false);
    plugin.onBeforeFrame(1 / 60, 2);
    expect(v.camera.position.equals(position)).toBe(true);
    plugin.navInput.feed({ tx: 1, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 }, 'external');
    plugin.onBeforeFrame(1 / 60, 3);
    expect(v.camera.position.x).toBeGreaterThan(position.x);
  });
  it('orbits around the controls pivot and supports Fly', async () => {
    const v = await setup();
    device.send(2, [0, 350, 0]);
    plugin.onBeforeFrame(0.1, 0);
    expect(v.camera.position.distanceTo(v.controls.target)).toBeCloseTo(10);
    expect(v.camera.position.x).not.toBe(0);
    plugin.configure({ Mode: 'Fly' });
    device.send(2, [0, 0, 0]);
    device.send(1, [0, 0, -350]);
    const before = v.camera.position.clone();
    plugin.onBeforeFrame(0.1, 1);
    expect(v.camera.position.distanceTo(before)).toBeGreaterThan(0);
  });
  it('orbits about a pivot beside the view axis without a jump in the next controls.update()', async () => {
    const v = await setup();
    const nav = v.navController!;
    expect(nav).toBeTruthy();
    const pivot = new Vector3(3, 1, 0);
    nav.resetPivot(pivot);
    const radius = v.camera.position.distanceTo(pivot);
    device.send(2, [0, 350, 0]);
    plugin.onBeforeFrame(0.1, 0);
    device.send(2, [0, 0, 0]);
    expect(v.camera.position.distanceTo(pivot)).toBeCloseTo(radius, 9);
    const rotated = v.camera.quaternion.clone();
    nav.tick(performance.now());
    v.controls.update();
    expect(v.camera.quaternion.angleTo(rotated)).toBeLessThan(1e-6);
    expect(nav.pivot.distanceTo(pivot)).toBeLessThan(1e-9);
    plugin.onBeforeFrame(0.1, 1);
    expect(nav.pivot.distanceTo(pivot)).toBeLessThan(1e-9);
  });
  it('joins a second reconnect while open() is pending and closes a device opened after dispose', async () => {
    const v = await setup();
    hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
    const slow = new FakeDevice();
    const release = delayOpen(slow);
    const listen = vi.spyOn(slow, 'addEventListener');
    hid.getDevices.mockResolvedValue([slow]);
    hid.dispatchEvent(new Event('connect'));
    await vi.waitFor(() => expect(slow.open).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('focus'));
    hid.dispatchEvent(new Event('connect'));
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await vi.waitFor(() => expect(plugin.connected).toBe(true));
    expect(slow.open).toHaveBeenCalledTimes(1);
    expect(slow.close).not.toHaveBeenCalled();
    expect(inputListeners(listen)).toBe(1);
    const before = v.camera.position.clone();
    slow.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(0.1, 0);
    expect(v.camera.position.x).toBeGreaterThan(before.x);
    const late = new FakeDevice();
    const releaseLate = delayOpen(late);
    const lateListen = vi.spyOn(late, 'addEventListener');
    hid.getDevices.mockResolvedValue([late]);
    const other = new SpaceMousePlugin();
    other.init(v);
    await vi.waitFor(() => expect(late.open).toHaveBeenCalledTimes(1));
    other.dispose();
    releaseLate();
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    expect(late.opened).toBe(false);
    expect(other.connected).toBe(false);
    expect(inputListeners(lateListen)).toBe(0);
  });
  it('walks to the eye height after the input ends and follows an EyeHeight change at rest', async () => {
    const v = await setup();
    const groundY = () => (plugin as unknown as { groundY: number }).groundY;
    plugin.configure({ Mode: 'Fly', WalkMode: true, EyeHeight: 1700 });
    device.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(1 / 60, 0);
    device.send(1, [0, 0, 0]);
    for (let i = 1; i <= 300; i++)
      plugin.onBeforeFrame(1 / 60, i);
    expect(Math.abs(v.camera.position.y - (groundY() + 1.7))).toBeLessThan(0.001);
    const dirty = vi.spyOn(v, 'markRenderDirty');
    plugin.onBeforeFrame(1 / 60, 301);
    expect(dirty).not.toHaveBeenCalled();
    plugin.configure({ EyeHeight: 1000 });
    for (let i = 302; i <= 600; i++)
      plugin.onBeforeFrame(1 / 60, i);
    expect(Math.abs(v.camera.position.y - (groundY() + 1))).toBeLessThan(0.001);
    expect(dirty).toHaveBeenCalled();
  });
  it('resets on disconnect, focus loss, hidden state and deactivation; reconnect requires a fresh report', async () => {
    const v = await setup();
    device.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(0.1, 0);
    hid.dispatchEvent(Object.assign(new Event('disconnect'), { device }));
    const before = v.camera.position.clone();
    plugin.onBeforeFrame(0.1, 1);
    expect(v.camera.position.equals(before)).toBe(true);
    expect(plugin.lastAxes.tx).toBe(0);
    const replacement = new FakeDevice();
    hid.getDevices.mockResolvedValue([replacement]);
    hid.dispatchEvent(new Event('connect'));
    await vi.waitFor(() => expect(plugin.connected).toBe(true));
    plugin.onBeforeFrame(0.1, 2);
    expectStill(v.camera.position, before);
    replacement.send(1, [350, 0, 0]);
    plugin.onBeforeFrame(0.1, 3);
    expect(v.camera.position.x).toBeGreaterThan(before.x);
    window.dispatchEvent(new Event('blur'));
    const paused = v.camera.position.clone();
    plugin.onBeforeFrame(0.1, 4);
    expect(v.camera.position.equals(paused)).toBe(true);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(plugin.connected).toBe(true));
    replacement.send(1, [350, 0, 0]);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    plugin.onBeforeFrame(0.1, 5);
    expectStill(v.camera.position, paused);
    hidden.mockRestore();
    plugin.onDeactivate();
    expect(plugin.lastAxes.tx).toBe(0);
    expect(Array.from(plugin.navInput.axes)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('yields to FPV and XR and clears held external input', async () => {
    const v = await setup();
    const getPlugin = vi.spyOn(v, 'getPlugin');
    const before = v.camera.position.clone();
    for (const owner of ['fpv', 'webxr']) {
      getPlugin.mockImplementation((id: string) => id === owner
        ? ({ id, isActive: true, isPresenting: true } as never)
        : undefined);
      plugin.navInput.feed({ tx: 1, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 }, 'external');
      plugin.onBeforeFrame(0.1, 0);
      expect(v.camera.position.equals(before)).toBe(true);
    }
    getPlugin.mockRestore();
    plugin.onBeforeFrame(0.1, 1);
    expect(v.camera.position.equals(before)).toBe(true);
  });
  it('handles station button edges, persists bounded settings, reports busy devices and closes on dispose', async () => {
    const v = await setup();
    const settings = loadVisualSettings();
    const original = settings.cameras;
    try {
      settings.cameras = [{ px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 }, { px: 4, py: 5, pz: 6, tx: 0, ty: 0, tz: 0 }];
      saveVisualSettings(settings);
      const animate = vi.spyOn(v, 'animateCameraTo');
      device.send(3, [2]);
      device.send(3, [2]);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.calls[0][0]).toEqual(new Vector3(4, 5, 6));
      plugin.configure({ Sensitivity: 100, EyeHeight: 1 });
      expect(plugin.settings.Sensitivity).toBe(5);
      expect(plugin.settings.EyeHeight).toBe(500);
      expect(JSON.parse(readLocalStorage(SPACEMOUSE_SETTINGS_KEY)!).Sensitivity).toBe(5);
      plugin.dispose();
      expect(device.close).toHaveBeenCalled();
      const busy = new FakeDevice();
      busy.open.mockRejectedValue(new Error('busy'));
      hid.requestDevice.mockResolvedValue([busy]);
      const other = new SpaceMousePlugin();
      other.init(v);
      await other.connect();
      expect(other.status).toBe('failed');
      expect(other.message).toBe('Could not connect to SpaceMouse. Try again.');
      other.dispose();
    }
    finally {
      settings.cameras = original;
      saveVisualSettings(settings);
    }
  });
});
describe('SpaceMouse settings tab', () => {
  it('returns to Not connected without an error when the device picker is cancelled or empty', async () => {
    await mount();
    hid.requestDevice.mockRejectedValueOnce(new DOMException('No device selected.', 'NotFoundError'));
    await plugin.connect();
    expect(plugin.status).toBe('not-connected');
    expect(plugin.message).toBe('');
    hid.requestDevice.mockResolvedValueOnce([]);
    await plugin.connect();
    expect(plugin.status).toBe('not-connected');
    renderTab();
    expect(statusText()).toContain('Not connected');
    expect(ui.queryByRole('alert')).toBeNull();
    expect(connectButton().disabled).toBe(false);
  });
  it('shows Connecting, then Connected with the device name, and disables the button meanwhile', async () => {
    await mount();
    const release = delayOpen(device);
    renderTab();
    fireEvent.click(connectButton());
    await vi.waitFor(() => expect(statusText()).toContain('Connecting…'));
    expect((ui.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(device.open).toHaveBeenCalledTimes(1));
    await act(async () => release());
    await vi.waitFor(() => expect(statusText()).toContain('Connected'));
    expect(ui.getByText('Test SpaceMouse')).toBeTruthy();
    expect(connectButton().disabled).toBe(true);
  });
  it('reports a failed open() as Connection failed with a remedy hint; detach clears it', async () => {
    await mount();
    device.open.mockRejectedValue(new Error('NotAllowedError'));
    await plugin.connect();
    expect(plugin.status).toBe('failed');
    renderTab();
    expect(statusText()).toContain('Connection failed');
    const alert = ui.getByRole('alert');
    expect(alert.textContent).toContain('Could not connect to SpaceMouse. Try again.');
    expect(alert.textContent).toContain('You may need to quit 3DxWare before reconnecting.');
    expect(alert.ownerDocument.body.textContent).not.toMatch(/belegt|3D-Maus/);
    window.dispatchEvent(new Event('blur'));
    expect(plugin.status).toBe('not-connected');
    expect(plugin.message).toBe('');
    window.dispatchEvent(new Event('focus'));
  });
  it('without WebHID shows Unavailable and disables the connect button', async () => {
    await mount(false);
    expect(plugin.status).toBe('unavailable');
    expect(plugin.message).toBe('WebHID is not available in this browser.');
    renderTab();
    expect(statusText()).toContain('Unavailable');
    expect(connectButton().disabled).toBe(true);
    expect(ui.getByText('WebHID is not available in this browser.')).toBeTruthy();
  });
  it('enables Walk Mode only in Fly and Eye Height only in Fly with Walk Mode', async () => {
    await mount();
    renderTab();
    expect(switchInput('Walk Mode').disabled).toBe(true);
    expect(sliderInput('Eye Height').disabled).toBe(true);
    act(() => plugin.configure({ Mode: 'Fly' }));
    await vi.waitFor(() => expect(switchInput('Walk Mode').disabled).toBe(false));
    expect(sliderInput('Eye Height').disabled).toBe(true);
    fireEvent.click(switchInput('Walk Mode'));
    expect(plugin.settings.WalkMode).toBe(true);
    await vi.waitFor(() => expect(sliderInput('Eye Height').disabled).toBe(false));
    expect(ui.getByText('1700 mm')).toBeTruthy();
  });
  it('Reset defaults restores every SpaceMouse setting and persists it', async () => {
    await mount();
    plugin.configure({
      Mode: 'Fly', Sensitivity: 3, DeadZone: 20, Smoothing: 0.1, DominantAxis: true, LockHorizon: false,
      WalkMode: true, EyeHeight: 900, InvertTranslation: [true, true, true], InvertRotation: [true, false, true],
      Button1: 'FitSelection', Button2: 'Mode',
    });
    renderTab();
    fireEvent.click(ui.getByRole('button', { name: 'Reset defaults' }));
    expect({ ...plugin.settings }).toEqual(defaultSpaceMouseSettings());
    expect(JSON.parse(readLocalStorage(SPACEMOUSE_SETTINGS_KEY)!)).toEqual(defaultSpaceMouseSettings());
  });
  it('disables every setting and Reset defaults while settings are locked', async () => {
    setAppConfig({ lockSettings: true });
    await mount();
    plugin.configure({ Mode: 'Fly', WalkMode: true });
    renderTab();
    expect((ui.getByRole('button', { name: 'Reset defaults' }) as HTMLButtonElement).disabled).toBe(true);
    for (const label of ['Dominant Axis', 'Lock Horizon', 'Walk Mode', 'Invert Translation X', 'Invert Rotation Z'])
      expect(switchInput(label).disabled).toBe(true);
    for (const label of ['Sensitivity', 'Dead Zone', 'Smoothing', 'Eye Height'])
      expect(sliderInput(label).disabled).toBe(true);
    expect(ui.getByLabelText('Mode').getAttribute('aria-disabled')).toBe('true');
    expect(connectButton().disabled).toBe(false);
  });
  it('shows dashes without a device and two-decimal axis values when connected', async () => {
    await mount();
    renderTab();
    expect(ui.getAllByText('—')).toHaveLength(6);
    expect(ui.getByText('No live input. Connect SpaceMouse to view axis values.')).toBeTruthy();
    await act(async () => plugin.connect());
    device.send(1, [175, 0, -350]);
    await vi.waitFor(() => expect(ui.getByText('+0.50')).toBeTruthy());
    expect(ui.getByText('-1.00')).toBeTruthy();
    expect(ui.queryByText('No live input. Connect SpaceMouse to view axis values.')).toBeNull();
  });
});
