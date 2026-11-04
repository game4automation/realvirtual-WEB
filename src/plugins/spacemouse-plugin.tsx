// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState } from 'react';
import { Alert, Box, Button, MenuItem, Select, Switch, Typography } from '@mui/material';
import { RestartAlt } from '@mui/icons-material';
import { Vector3, Raycaster, type Intersection, type Object3D } from 'three';
import { BaseViewerPlugin } from '../core/rv-base-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { PluginContext } from '../core/rv-plugin-context';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import {
  RVSpaceMouseParser, getSpaceMouseHID, SPACEMOUSE_FILTERS, type SpaceMouseDevice,
} from '../core/engine/rv-spacemouse-hid';
import {
  RVSpaceMouseNav, SIX_DOF_AXES, defaultSpaceMouseSettings, type SixDofNavInput, type SixDofSample,
  type SpaceMouseSettings, type SpaceMouseButton,
} from '../core/engine/rv-spacemouse-nav';
import { SPACEMOUSE_SETTINGS_KEY, readLocalStorage, writeLocalStorage } from '../core/hmi/rv-storage-keys';
import { loadVisualSettings } from '../core/hmi/visual-settings-store';
import { requestSettingsTab } from '../core/hmi/settings-tab-store';
import { isSettingsLocked } from '../core/hmi/rv-app-config';
import { FieldRow, SettingsSection, SliderRow, StatRow } from '../core/hmi/settings/settings-helpers';
import { ACCENT, ERROR, INK_MID, SUCCESS } from '../core/hmi/shared-sx';
import { CameraStartPosPlugin } from './camera-startpos-plugin';
import type { SpaceMouseConnectionStatus, SpaceMousePluginAPI } from '../core/types/plugin-types';

export type { SpaceMouseConnectionStatus, SpaceMousePluginAPI } from '../core/types/plugin-types';
const BUTTONS: SpaceMouseButton[] = ['Overview', 'Next', 'Previous', 'Mode', 'FitSelection'];
const NO_WEBHID = 'WebHID is not available in this browser.';
const CONNECT_FAILED = 'Could not connect to SpaceMouse. Try again.';

/** Connect SpaceMouse HID input to viewer navigation and settings. */
export class SpaceMousePlugin extends BaseViewerPlugin implements SpaceMousePluginAPI {
  readonly id = 'spacemouse';
  // Participation in selective models; registered as a core plugin in main.ts (plan-2215 Phase 8).
  readonly core = true;
  readonly navInput = new RVSpaceMouseNav();
  readonly parser = new RVSpaceMouseParser();
  readonly slots: UISlotEntry[] = [{ slot: 'settings-tab', label: 'SpaceMouse', component: SpaceMouseTab, order: 400 }];
  private viewer: RVViewer | null = null;
  private device: SpaceMouseDevice | null = null;
  private active = true;
  private focused = true;
  private generation = 0;
  private closing: Promise<void> = Promise.resolve();
  // The pending open; a second attach of the same device in the same generation joins it.
  private opening: { device: SpaceMouseDevice; generation: number; done: Promise<void> } | null = null;
  private groundY = 0;
  private groundKnown = false;
  // Set by SpaceMouse motion or a settings change; cleared once the eye height is reached.
  private walkPending = false;
  private station = 0;
  private readonly position = new Vector3();
  private readonly target = new Vector3();
  private readonly pivot = new Vector3();
  private readonly down = new Vector3(0, -1, 0);
  private readonly ray = new Raycaster();
  private readonly ground: Object3D[] = [];
  private readonly hits: Intersection[] = [];
  // The device picker is open (user-initiated connect).
  private requesting = false;
  // The last open attempt threw; cleared by detach() and by a new connect.
  private failed = false;

  get status(): SpaceMouseConnectionStatus {
    if (this.connected)
      return 'connected';
    if (!getSpaceMouseHID())
      return 'unavailable';
    if (this.requesting || this.opening)
      return 'connecting';
    return this.failed ? 'failed' : 'not-connected';
  }

  get message(): string {
    const status = this.status;
    return status === 'unavailable' ? NO_WEBHID : status === 'failed' ? CONNECT_FAILED : '';
  }

  get connected(): boolean {
    return this.device?.opened ?? false;
  }

  get deviceName(): string {
    return this.device?.productName ?? '';
  }

  get lastAxes(): Readonly<SixDofSample> {
    return this.parser.sample;
  }

  get settings(): SpaceMouseSettings {
    return this.navInput.settings;
  }

  override init(viewer: RVViewer, context?: PluginContext): void {
    super.init(viewer, context);
    this.viewer = viewer;
    try {
      const stored = JSON.parse(readLocalStorage(SPACEMOUSE_SETTINGS_KEY) ?? 'null');
      if (stored)
        this.configure(stored);
    } catch { /* defaults */ }
    const hid = getSpaceMouseHID();
    hid?.addEventListener('connect', this.resume);
    hid?.addEventListener('disconnect', this.disconnect);
    window.addEventListener('blur', this.suspend);
    window.addEventListener('focus', this.focus);
    document.addEventListener('visibilitychange', this.visibility);
    this.sub(() => {
      hid?.removeEventListener('connect', this.resume);
      hid?.removeEventListener('disconnect', this.disconnect);
      window.removeEventListener('blur', this.suspend);
      window.removeEventListener('focus', this.focus);
      document.removeEventListener('visibilitychange', this.visibility);
    });
    this.sub(viewer.on('plugins-changed', event => {
      if (event.id !== this.id)
        return;
      if (event.kind === 'disabled')
        this.onDeactivate();
      if (event.kind === 'enabled')
        this.onActivate();
    }));
    void this.reconnect();
    if (new URLSearchParams(location.search).has('spacemouse'))
      queueMicrotask(() => {
        if (!this.viewer)
          return;
        const index = viewer.uiRegistry.getSettingsTabs().findIndex(e => e.pluginId === this.id);
        if (index >= 0) {
          requestSettingsTab(100 + index);
          viewer.leftPanelManager.open('settings', 420);
        }
      });
  }

  configure(values: Partial<SpaceMouseSettings>): void {
    const s = this.settings;
    for (const key of ['Sensitivity', 'DeadZone', 'Smoothing', 'EyeHeight'] as const) {
      const bounds = key === 'Sensitivity' ? [0.1, 5]
        : key === 'DeadZone' ? [0, 30]
        : key === 'Smoothing' ? [0, 0.95]
        : [500, 3000];
      const v = values[key];
      if (typeof v === 'number' && Number.isFinite(v))
        s[key] = Math.max(bounds[0], Math.min(bounds[1], v));
    }
    if (values.Mode === 'Orbit' || values.Mode === 'Fly')
      s.Mode = values.Mode;
    for (const key of ['DominantAxis', 'LockHorizon', 'WalkMode'] as const)
      if (typeof values[key] === 'boolean')
        s[key] = values[key];
    for (const key of ['InvertTranslation', 'InvertRotation'] as const)
      if (Array.isArray(values[key]))
        s[key] = [0, 1, 2].map(i => values[key]?.[i] === true);
    for (const key of ['Button1', 'Button2'] as const)
      if (BUTTONS.includes(values[key]!))
        s[key] = values[key]!;
    this.navInput.reset();
    this.walkPending = true;
    this.save();
  }

  private save(): void {
    try {
      writeLocalStorage(SPACEMOUSE_SETTINGS_KEY, JSON.stringify(this.settings));
    } catch { /* session only */ }
  }

  private reset(): void {
    this.parser.reset();
    this.navInput.reset();
  }

  private detach(): void {
    this.generation++;
    this.failed = false;
    this.reset();
    const old = this.device;
    this.device = null;
    old?.removeEventListener('inputreport', this.report);
    if (old?.opened)
      this.closing = old.close().catch(() => { });
  }

  private suspend = (): void => {
    this.focused = false;
    this.detach();
  };
  private focus = (): void => {
    this.focused = true;
    this.resume();
  };
  private visibility = (): void => {
    if (document.hidden)
      this.suspend();
    else
      this.focus();
  };
  private resume = (): void => {
    void this.reconnect();
  };
  private disconnect = (event: Event): void => {
    const device = (event as Event & {
      device: SpaceMouseDevice;
    }).device;
    if (device === this.device || device === this.opening?.device)
      this.detach();
  };
  async connect(): Promise<void> {
    const hid = getSpaceMouseHID();
    if (!hid || !this.active || this.requesting || this.connected)
      return;
    this.failed = false;
    this.requesting = true;
    let devices: SpaceMouseDevice[] = [];
    try {
      devices = await hid.requestDevice({ filters: SPACEMOUSE_FILTERS });
    } catch (error) {
      // A cancelled picker is not a failure: back to Not connected without a message.
      const name = (error as { name?: string } | null)?.name;
      if (name !== 'NotFoundError' && name !== 'AbortError')
        this.failed = true;
    } finally {
      this.requesting = false;
    }
    if (devices[0])
      await this.attach(devices[0]);
  }

  private async reconnect(): Promise<void> {
    const hid = getSpaceMouseHID();
    if (!hid || !this.active || !this.focused || document.hidden || this.device)
      return;
    const generation = this.generation;
    try {
      const devices = await hid.getDevices();
      if (generation !== this.generation || !this.active)
        return;
      const device = devices.find(d => SPACEMOUSE_FILTERS.some(f => f.vendorId === d.vendorId));
      if (device)
        await this.attach(device);
    } catch {
      if (generation === this.generation)
        this.failed = true;
    }
  }

  private attach(device: SpaceMouseDevice): Promise<void> {
    const pending = this.opening;
    if (pending && pending.device === device && pending.generation === this.generation)
      return pending.done;
    if (device === this.device && device.opened)
      return Promise.resolve();
    this.detach();
    const generation = this.generation;
    const done = this.open(device, generation, pending?.done);
    const entry = { device, generation, done };
    this.opening = entry;
    void done.finally(() => {
      if (this.opening === entry)
        this.opening = null;
    });
    return done;
  }

  /** Open after the previous attempt and close have settled; a stale or disposed attempt closes again. */
  private async open(device: SpaceMouseDevice, generation: number, previous?: Promise<void>): Promise<void> {
    try {
      await previous;
      await this.closing;
      if (generation !== this.generation || !this.active)
        return;
      if (!device.opened)
        await device.open();
      if (generation !== this.generation || !this.active) {
        if (device.opened)
          await device.close();
        return;
      }
      this.device = device;
      this.reset();
      this.failed = false;
      device.addEventListener('inputreport', this.report);
    } catch {
      // The cause is not known (device in use, permission, unplugged); the UI only suggests remedies.
      if (generation === this.generation)
        this.failed = true;
    }
  }

  private blocked(): boolean {
    const v = this.viewer;
    return !this.active || !this.focused || !v || v.isCapturing || document.hidden ||
      !!v.getPlugin<{
        isActive: boolean;
      } & BaseViewerPlugin>('fpv')?.isActive ||
      !!v.renderer.xr?.isPresenting ||
      !!v.getPlugin<{
        isPresenting: boolean;
      } & BaseViewerPlugin>('webxr')?.isPresenting;
  }

  private report = (event: Event): void => {
    if (this.blocked()) {
      this.reset();
      return;
    }
    const e = event as Event & {
      reportId: number;
      data: DataView;
    };
    const previous = this.parser.buttons;
    if (!this.parser.parse(e.reportId, e.data))
      return;
    this.navInput.feed(this.parser.sample, 'spacemouse');
    const pressed = this.parser.buttons & ~previous;
    if (pressed & 1)
      this.button(this.settings.Button1);
    if (pressed & 2)
      this.button(this.settings.Button2);
  };
  onBeforeFrame(dtSeconds: number, _nowMs: number): void {
    const v = this.viewer;
    if (!v)
      return;
    if (this.blocked()) {
      this.reset();
      return;
    }
    this.pivot.copy(v.navController?.pivot ?? v.controls.target);
    const moved = this.navInput.step(dtSeconds, v.camera, v.controls.target, this.pivot);
    if (moved)
      v.cancelCameraAnimation();
    // Walk holds the eye height every frame until it converges, also after the input ends.
    if (moved)
      this.walkPending = true;
    const walked = this.walkPending && this.navInput.mode === 'Fly' && this.settings.WalkMode &&
      !v.isCameraAnimating && !v.navController?.gestureActive && this.snapGround(dtSeconds, moved);
    if (!walked)
      this.walkPending = false;
    if (!moved && !walked)
      return;
    if (walked)
      this.pivot.copy(v.controls.target);
    // Like a drag or wheel input: drop pending OrbitControls damping so it cannot drift on afterwards.
    v.navController?.flushDamping();
    // Keep the orbit pivot (possibly beside the view axis) instead of replacing it by the target.
    v.navController?.resetPivot(this.pivot);
    v.markRenderDirty();
  }

  /** Ease the camera toward ground + EyeHeight; returns false once within 1 mm (no correction). */
  private snapGround(dt: number, moved: boolean): boolean {
    const v = this.viewer!;
    if (moved || !this.groundKnown)
      this.findGround();
    const y = this.groundY + this.settings.EyeHeight / 1000;
    const error = y - v.camera.position.y;
    if (Math.abs(error) < 0.001)
      return false;
    let delta = error * (1 - Math.exp(-8 * dt));
    if (Math.abs(error - delta) < 0.001)
      delta = error;
    v.camera.position.y += delta;
    v.controls.target.y += delta;
    v.camera.updateMatrixWorld();
    return true;
  }

  /** Ground below the camera, as the FPV ground selection; idle frames reuse the cached height. */
  private findGround(): void {
    const v = this.viewer!;
    this.groundKnown = true;
    this.ground.length = 0;
    for (const child of v.scene.children)
      if ((child as Object3D & {
        isMesh?: boolean;
      }).isMesh && Math.abs(child.rotation.x + Math.PI / 2) < 0.01)
        this.ground.push(child);
    this.position.copy(v.camera.position);
    this.position.y += 10;
    this.ray.set(this.position, this.down);
    this.ray.far = 50;
    this.hits.length = 0;
    this.ray.intersectObjects(this.ground, false, this.hits);
    if (this.hits[0])
      this.groundY = this.hits[0].point.y;
    else if (!this.ground.length)
      this.groundY = 0;
  }

  button(action: SpaceMouseButton): void {
    const v = this.viewer;
    if (!v)
      return;
    if (action === 'Mode') {
      this.navInput.mode = this.navInput.mode === 'Orbit' ? 'Fly' : 'Orbit';
      this.walkPending = true;
      this.save();
      return;
    }
    v.cancelCameraAnimation();
    if (action === 'Overview') {
      const preset = v.getPlugin<CameraStartPosPlugin>('camera-startpos')?.resolvePreset(v);
      if (preset) {
        this.position.set(preset.px, preset.py, preset.pz);
        this.target.set(preset.tx, preset.ty, preset.tz);
        v.animateCameraTo(this.position, this.target);
      } else
        v.fitToNodes(v.scene.children);
    } else if (action === 'FitSelection') {
      const nodes = v.selectionManager.getSnapshot().selectedPaths
        .map(p => v.registry?.getNode(p))
        .filter((n): n is Object3D => !!n);
      if (nodes.length)
        v.fitToNodes(nodes);
    } else {
      const cameras = loadVisualSettings().cameras;
      for (let i = 0; i < cameras.length; i++) {
        this.station = (this.station + (action === 'Next' ? 1 : cameras.length - 1)) % cameras.length;
        const bm = cameras[this.station];
        if (!bm)
          continue;
        this.position.set(bm.px, bm.py, bm.pz);
        this.target.set(bm.tx, bm.ty, bm.tz);
        v.animateCameraTo(this.position, this.target);
        break;
      }
    }
  }

  onDeactivate(): void {
    this.active = false;
    this.detach();
  }

  onActivate(): void {
    this.active = true;
    void this.reconnect();
  }

  override onModelCleared(_viewer: RVViewer): void {
    this.reset();
    this.groundKnown = false;
  }

  override dispose(): void {
    this.active = false;
    this.detach();
    this.viewer = null;
    super.dispose();
  }
}
const STATUS_VIEW: Record<SpaceMouseConnectionStatus, { text: string; color: string }> = {
  'not-connected': { text: 'Not connected', color: INK_MID },
  connecting: { text: 'Connecting…', color: ACCENT },
  connected: { text: 'Connected', color: SUCCESS },
  unavailable: { text: 'Unavailable', color: INK_MID },
  failed: { text: 'Connection failed', color: ERROR },
};
const BUTTON_LABELS: Record<SpaceMouseButton, string> = {
  Overview: 'Overview',
  Next: 'Next Camera',
  Previous: 'Previous Camera',
  Mode: 'Toggle Orbit / Fly',
  FitSelection: 'Fit Selection',
};
const AXIS_LABELS: Record<(typeof SIX_DOF_AXES)[number], string> = {
  tx: 'Translation X',
  ty: 'Translation Y',
  tz: 'Translation Z',
  rx: 'Rotation X',
  ry: 'Rotation Y',
  rz: 'Rotation Z',
};
const CAPTION_SX = { color: 'text.disabled', display: 'block', fontSize: 10, lineHeight: 1.3 } as const;

function axisText(value: number): string {
  if (Math.abs(value) < 0.005)
    return '0.00';
  return (value > 0 ? '+' : '') + value.toFixed(2);
}

function SpaceMouseTab({ viewer }: UISlotProps) {
  const plugin = viewer.getPlugin<SpaceMousePlugin>('spacemouse');
  const [, update] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => update(n => n + 1), 100);
    return () => clearInterval(timer);
  }, []);
  if (!plugin)
    return <Alert severity="info">SpaceMouse is not available.</Alert>;
  const s = plugin.settings;
  const locked = isSettingsLocked();
  const status = plugin.status;
  const view = STATUS_VIEW[status];
  const fly = s.Mode === 'Fly';
  const change = (values: Partial<SpaceMouseSettings>) => {
    plugin.configure(values);
    update(n => n + 1);
  };
  const connect = () => {
    const done = plugin.connect();
    update(n => n + 1);
    void done.finally(() => update(n => n + 1));
  };
  const invert = (key: 'InvertTranslation' | 'InvertRotation', index: number, checked: boolean) => {
    const values = s[key].slice();
    values[index] = checked;
    change({ [key]: values });
  };
  const toggle = (key: 'DominantAxis' | 'LockHorizon' | 'WalkMode', label: string, hint: string, off = false) => (
    <FieldRow label={label} hint={hint}>
      <Switch
        size="small"
        checked={s[key]}
        onChange={(_, checked) => change({ [key]: checked })}
        disabled={locked || off}
        slotProps={{ input: { 'aria-label': label } }}
      />
    </FieldRow>
  );
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="spacemouse-connection" title="Connection">
        <Box role="status" aria-live="polite">
          <StatRow label="Status" value={view.text} color={view.color} />
        </Box>
        {status === 'connected' && (
          <StatRow label="Device" value={plugin.deviceName || 'SpaceMouse'} />
        )}
        <Box>
          <Button
            size="small"
            variant="outlined"
            onClick={connect}
            disabled={status === 'unavailable' || status === 'connecting' || status === 'connected'}
            sx={{ textTransform: 'none' }}
          >
            {status === 'connecting' ? 'Connecting…' : 'Connect SpaceMouse'}
          </Button>
        </Box>
        {status === 'unavailable' && <Alert severity="info">WebHID is not available in this browser.</Alert>}
        {status === 'failed' && (
          <Alert severity="error">
            {CONNECT_FAILED}
            <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
              If another application is using the device, close it. You may need to quit 3DxWare before reconnecting.
            </Typography>
          </Alert>
        )}
        {status !== 'unavailable' && status !== 'connected' && (
          <Typography variant="caption" sx={CAPTION_SX}>
            Connect your SpaceMouse and select it in the device picker.
          </Typography>
        )}
      </SettingsSection>

      <SettingsSection id="spacemouse-navigation" title="Navigation">
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="small"
            variant="text"
            onClick={() => change(defaultSpaceMouseSettings())}
            disabled={locked}
            startIcon={<RestartAlt />}
            sx={{ fontSize: 11, textTransform: 'none', py: 0, minWidth: 0 }}
          >
            Reset defaults
          </Button>
        </Box>
        <FieldRow label="Mode" hint="Orbit rotates around the navigation pivot. Fly moves through the scene.">
          <Select
            size="small"
            fullWidth
            value={s.Mode}
            onChange={e => change({ Mode: e.target.value as SpaceMouseSettings['Mode'] })}
            disabled={locked}
            SelectDisplayProps={{ 'aria-label': 'Mode' }}
          >
            <MenuItem value="Orbit">Orbit</MenuItem>
            <MenuItem value="Fly">Fly</MenuItem>
          </Select>
        </FieldRow>
        <SliderRow
          label="Sensitivity"
          min={0.1}
          max={5}
          step={0.1}
          value={s.Sensitivity}
          onChange={(_, v) => change({ Sensitivity: v as number })}
          disabled={locked}
          format={v => v.toFixed(1)}
          hint="Scales translation and rotation speed."
        />
        <SliderRow
          label="Dead Zone"
          min={0}
          max={30}
          step={1}
          value={s.DeadZone}
          onChange={(_, v) => change({ DeadZone: v as number })}
          disabled={locked}
          format={v => `${v.toFixed(0)} %`}
          hint="Ignores small movements around the neutral position."
        />
        <SliderRow
          label="Smoothing"
          min={0}
          max={0.95}
          step={0.01}
          value={s.Smoothing}
          onChange={(_, v) => change({ Smoothing: v as number })}
          disabled={locked}
          hint="Higher values smooth input more. Zero disables smoothing."
        />
        {toggle('DominantAxis', 'Dominant Axis', 'Uses only the strongest input axis.')}
        {toggle('LockHorizon', 'Lock Horizon',
          'Keeps the camera level and prevents roll. Roll is only available in Fly mode.')}
        {toggle('WalkMode', 'Walk Mode',
          'Fly mode only. Keeps movement horizontal and maintains eye height above the ground.', !fly)}
        <SliderRow
          label="Eye Height"
          min={500}
          max={3000}
          step={10}
          value={s.EyeHeight}
          onChange={(_, v) => change({ EyeHeight: v as number })}
          disabled={locked || !fly || !s.WalkMode}
          format={v => `${v.toFixed(0)} mm`}
          hint="Height above the ground in Walk Mode."
        />
      </SettingsSection>

      <SettingsSection id="spacemouse-axis-direction" title="Axis Direction">
        <Typography variant="caption" sx={CAPTION_SX}>Reverse the direction of individual input axes.</Typography>
        {(['InvertTranslation', 'InvertRotation'] as const).map(key => [0, 1, 2].map(i => {
          const label = `Invert ${key === 'InvertTranslation' ? 'Translation' : 'Rotation'} ${'XYZ'[i]}`;
          return (
            <FieldRow key={label} label={label}>
              <Switch
                size="small"
                checked={s[key][i]}
                onChange={(_, checked) => invert(key, i, checked)}
                disabled={locked}
                slotProps={{ input: { 'aria-label': label } }}
              />
            </FieldRow>
          );
        }))}
      </SettingsSection>

      <SettingsSection id="spacemouse-buttons" title="Buttons">
        {(['Button1', 'Button2'] as const).map((key, i) => (
          <FieldRow key={key} label={`Button ${i + 1}`}>
            <Select
              size="small"
              fullWidth
              value={s[key]}
              onChange={e => change({ [key]: e.target.value as SpaceMouseButton })}
              disabled={locked}
              SelectDisplayProps={{ 'aria-label': `Button ${i + 1}` }}
            >
              {BUTTONS.map(b => <MenuItem key={b} value={b}>{BUTTON_LABELS[b]}</MenuItem>)}
            </Select>
          </FieldRow>
        ))}
        <Typography variant="caption" sx={CAPTION_SX}>
          Overview restores the start view, or fits the scene if no start view is saved.
          Next and Previous use saved cameras.
        </Typography>
      </SettingsSection>

      <SettingsSection id="spacemouse-live-input" title="Live Input" defaultExpanded={false}>
        <Typography variant="caption" sx={CAPTION_SX}>
          Normalized device input before dead zone, smoothing and axis inversion.
        </Typography>
        {SIX_DOF_AXES.map(axis => (
          <StatRow
            key={axis}
            label={AXIS_LABELS[axis]}
            value={status === 'connected' ? axisText(plugin.lastAxes[axis]) : '—'}
          />
        ))}
        {status !== 'connected' && (
          <Typography variant="caption" sx={CAPTION_SX}>
            No live input. Connect SpaceMouse to view axis values.
          </Typography>
        )}
      </SettingsSection>
    </Box>
  );
}
