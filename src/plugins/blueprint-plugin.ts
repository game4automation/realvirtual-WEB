// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BlueprintPlugin — Copy-paste template for new RVBehavior plugins.
 *
 * Shows all available lifecycle hooks, getters, and helper methods.
 * Delete what you don't need and rename the class + id.
 *
 * Registration:  viewer.use(new BlueprintPlugin());
 */

import { RVBehavior } from '../core/rv-behavior';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { debug } from '../core/engine/rv-debug';

export class BlueprintPlugin extends RVBehavior {
  readonly id = 'blueprint';

  // Optional: execution order (lower = earlier). Default is undefined (no ordering).
  // readonly order = 50;

  // Optional: UI slots for HMI layout (React components in named positions).
  // readonly slots: UISlotEntry[] = [
  //   { slot: 'button-group', component: MyButton, order: 50 },
  //   { slot: 'kpi-bar', component: MyKpiCard, order: 10 },
  // ];

  // ── Your state ──

  private _counter = 0;

  // ── Lifecycle hooks ──

  /** Called once after the GLB model is loaded. Viewer, drives, sensors, signals are ready. */
  protected onStart(result: LoadResult): void {
    // Access drives, sensors, signals via convenience getters:
    debug('loader', `[${this.id}] Model loaded — ${this.drives.length} drives, ${this.sensors.length} sensors`);

    // Find a specific drive by name
    // const conveyor = this.drives.find(d => d.name === 'ConveyorDrive');

    // Read a signal by name (primary addressing)
    // const isRunning = this.getSignalBool('ConveyorStart');

    // Read a float/int signal
    // const speed = this.getSignalFloat('TargetSpeed');
    // const count = this.getSignalInt('PartCount');

    // Write a signal
    // this.setSignal('ConveyorStart', true);

    // Subscribe to signal changes (auto-cleaned up on model clear)
    // this.onSignalChanged('ConveyorStart', (value) => {
    //   console.log(`ConveyorStart changed to ${value}`);
    // });

    // Path-based signal access (for internal/GLB object references)
    // const val = this.getSignalByPath('Cell/Signals/ConveyorStart');
    // this.setSignalByPath('Cell/Signals/ConveyorStart', true);

    // Generic component discovery (like GetComponent<T>)
    // const drive = this.find<RVDrive>('Drive', 'Cell/Conveyor');
    // const allDrives = this.findAll<RVDrive>('Drive');

    // Get a Three.js node by path
    // const node = this.getNode('Cell/Conveyor');

    // Register custom cleanup (runs on model clear + dispose)
    // this.addCleanup(() => { /* cleanup resources */ });

    // Emit a custom viewer event
    // this.emit('my-custom-event', { detail: 'hello' });
  }

  /** Called before cleanup when model is cleared or plugin is disposed. */
  protected onDestroy(): void {
    debug('loader', `[${this.id}] Destroyed`);
  }

  /** 60Hz fixed update, BEFORE drive physics. Set drive targets, replay, CAM here. */
  // Uncomment if needed — only define hooks you actually use.
  // protected onPreFixedUpdate(dt: number): void {
  //   // dt is fixed timestep in seconds (1/60)
  // }

  /** 60Hz fixed update, AFTER drive physics + transport. Read results, record, monitor. */
  // protected onLateFixedUpdate(dt: number): void {
  //   // this.elapsed is auto-tracked (total simulation time in seconds)
  //   this._counter++;
  // }

  /** Per render frame. Visual-only updates (camera, highlights, UI state). */
  // protected onFrame(frameDt: number): void {
  //   // frameDt is actual frame delta (variable)
  // }
}
