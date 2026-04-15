// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVBehavior — MonoBehaviour-like base class for viewer plugins.
 *
 * Manages the viewer reference lifecycle, provides convenience getters
 * for drives/sensors/signals, and handles cleanup registration.
 *
 * Subclasses override lifecycle hooks instead of raw interface methods:
 *   onStart()              — model loaded (like Start)
 *   onDestroy()            — model cleared / dispose (like OnDestroy)
 *   onPreFixedUpdate(dt)   — 60Hz, before drive physics (set targets)
 *   onLateFixedUpdate(dt)  — 60Hz, after drive physics (read results)
 *   onFrame(frameDt)       — per render frame (visual updates)
 *
 * Generic component discovery mirrors Unity's GetComponent API:
 *   find<T>(type, path)              — GetComponent at path
 *   findAll<T>(type)                 — FindObjectsOfType
 *   findInParent<T>(node, type)      — GetComponentInParent
 *   findInChildren<T>(node, type)    — GetComponentInChildren
 *   findAllInChildren<T>(node, type) — GetComponentsInChildren
 */

import type { RVViewerPlugin } from './rv-plugin';
import type { UISlotEntry } from './rv-ui-plugin';
import type { LoadResult } from './engine/rv-scene-loader';
import type { RVViewer } from './rv-viewer';
import type { RVDrive } from './engine/rv-drive';
import type { RVSensor } from './engine/rv-sensor';
import type { RVDrivesPlayback } from './engine/rv-drives-playback';
import type { SignalStore } from './engine/rv-signal-store';
import type { RVTransportManager } from './engine/rv-transport-manager';
import type { Object3D, Scene } from 'three';

export abstract class RVBehavior implements RVViewerPlugin {
  abstract readonly id: string;
  readonly order?: number;
  readonly slots?: UISlotEntry[];

  // ── Protected state ──

  /** The viewer instance. Available after onStart, null after onDestroy. */
  protected viewer: RVViewer | null = null;

  /** Accumulated simulation time in seconds (auto-tracked in onFixedUpdatePost). */
  protected elapsed = 0;

  private _cleanups: (() => void)[] = [];

  // ── Convenience getters (like MonoBehaviour.transform, .gameObject) ──

  protected get drives(): RVDrive[] { return this.viewer?.drives ?? []; }
  protected get sensors(): RVSensor[] { return this.viewer?.transportManager?.sensors ?? []; }
  protected get playback(): RVDrivesPlayback | null { return this.viewer?.playback ?? null; }
  protected get signals(): SignalStore | null { return this.viewer?.signalStore ?? null; }
  protected get transportManager(): RVTransportManager | null { return this.viewer?.transportManager ?? null; }
  protected get scene(): Scene | null { return this.viewer?.scene ?? null; }

  // ── Generic component discovery (like GetComponent<T>) ──

  /** Get a component by type and hierarchy path. Like GetComponent at a specific path. */
  protected find<T = unknown>(type: string, path: string): T | null {
    return this.viewer?.registry?.getByPath<T>(type, path) ?? null;
  }

  /** Get all components of a type across the scene. Like FindObjectsOfType. */
  protected findAll<T = unknown>(type: string): { path: string; instance: T }[] {
    return this.viewer?.registry?.getAll<T>(type) ?? [];
  }

  /** Walk up from node to find a component. Like GetComponentInParent. */
  protected findInParent<T = unknown>(node: Object3D, type: string): T | null {
    return this.viewer?.registry?.findInParent<T>(node, type) ?? null;
  }

  /** Walk down from node to find first child with component. Like GetComponentInChildren. */
  protected findInChildren<T = unknown>(node: Object3D, type: string): T | null {
    return this.viewer?.registry?.findInChildren<T>(node, type) ?? null;
  }

  /** Walk down from node to find all children with component. Like GetComponentsInChildren. */
  protected findAllInChildren<T = unknown>(node: Object3D, type: string): { path: string; instance: T }[] {
    return this.viewer?.registry?.findAllInChildren<T>(node, type) ?? [];
  }

  /** Get a Three.js node by hierarchy path. */
  protected getNode(path: string): Object3D | null {
    return this.viewer?.registry?.getNode(path) ?? null;
  }

  // ── Signal access (by name — primary) ──
  // Signal ID = Signal.Name (custom unique name, if set) or node name (GameObject name).
  // Path-based access is available via getSignalByPath / setSignalByPath for internal use.

  /** Read a boolean signal by name. */
  protected getSignalBool(name: string): boolean {
    return this.viewer?.signalStore?.getBool(name) ?? false;
  }

  /** Read a float signal by name. */
  protected getSignalFloat(name: string): number {
    return this.viewer?.signalStore?.getFloat(name) ?? 0;
  }

  /** Read an int signal by name. */
  protected getSignalInt(name: string): number {
    return this.viewer?.signalStore?.getInt(name) ?? 0;
  }

  /** Write a signal value by name. */
  protected setSignal(name: string, value: boolean | number): void {
    this.viewer?.signalStore?.set(name, value);
  }

  /** Subscribe to signal changes by name. Cleanup is automatic on model clear / dispose. */
  protected onSignalChanged(name: string, cb: (value: boolean | number) => void): void {
    const unsub = this.viewer?.signalStore?.subscribe(name, cb);
    if (unsub) this._cleanups.push(unsub);
  }

  // ── Signal access (by path — secondary) ──

  /** Read a signal value by hierarchy path. */
  protected getSignalByPath(path: string): boolean | number | undefined {
    return this.viewer?.signalStore?.getByPath(path);
  }

  /** Write a signal value by hierarchy path. */
  protected setSignalByPath(path: string, value: boolean | number): void {
    this.viewer?.signalStore?.setByPath(path, value);
  }

  // ── Helper methods ──

  /** Register a cleanup function. Called automatically on model clear and dispose. */
  protected addCleanup(fn: () => void): void {
    this._cleanups.push(fn);
  }

  /** Emit a viewer event with null-safety. */
  protected emit(event: string, data?: unknown): void {
    this.viewer?.emit(event, data);
  }

  // ── Lifecycle for subclasses (override these) ──

  /** Called after model loaded and viewer reference set. Like Start(). */
  protected onStart?(result: LoadResult): void;

  /** Called before cleanup on model clear or dispose. Like OnDestroy(). */
  protected onDestroy?(): void;

  /** 60Hz, before drive physics. Use to set drive targets, replay, CAM. */
  protected onPreFixedUpdate?(dt: number): void;

  /** 60Hz, after drive physics + transport. Use to read results, record, monitor. */
  protected onLateFixedUpdate?(dt: number): void;

  /** Per render frame. Use for visual-only updates (camera, highlights, UI state). */
  protected onFrame?(frameDt: number): void;

  // ── RVViewerPlugin interface implementation ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.elapsed = 0;
    this.onStart?.(result);
  }

  onModelCleared(): void {
    this.onDestroy?.();
    this._runCleanups();
    this.viewer = null;
    this.elapsed = 0;
  }

  onFixedUpdatePre(dt: number): void {
    this.onPreFixedUpdate?.(dt);
  }

  onFixedUpdatePost(dt: number): void {
    this.elapsed += dt;
    this.onLateFixedUpdate?.(dt);
  }

  onRender(frameDt: number): void {
    this.onFrame?.(frameDt);
  }

  dispose(): void {
    if (this.viewer) this.onDestroy?.();
    this._runCleanups();
    this.viewer = null;
  }

  private _runCleanups(): void {
    for (const fn of this._cleanups) fn();
    this._cleanups = [];
  }
}
