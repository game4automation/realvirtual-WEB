// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Vector3, type Object3D } from 'three';

export type RVEmbedDirectorVector3 = readonly [number, number, number];
export type RVEmbedDirectorPoint = readonly [number, number];

export interface RVEmbedDirectorCameraPose {
  position: RVEmbedDirectorVector3;
  target: RVEmbedDirectorVector3;
}

type MutableDirectorVector3 = [number, number, number];

interface MutableDirectorCameraPose extends RVEmbedDirectorCameraPose {
  position: MutableDirectorVector3;
  target: MutableDirectorVector3;
}

export type RVEmbedDirectorCameraAction =
  | string
  | RVEmbedDirectorCameraPose
  | {
      focus: string;
      padding?: number;
    };

export interface RVEmbedDirectorGhostCursorAction {
  moveTo: string | RVEmbedDirectorPoint;
  duration?: number;
  visible?: boolean;
}

export interface RVEmbedDirectorDragAction {
  node: string;
  to: RVEmbedDirectorVector3;
  duration?: number;
}

export interface RVEmbedDirectorClickAction {
  node: string;
}

export interface RVEmbedDirectorContextMenuAction {
  at?: string;
  items?: readonly string[];
  open?: boolean;
}

export interface RVEmbedDirectorSignalAction {
  name: string;
  value: boolean | number;
}

export interface RVEmbedDirectorOverlayAction {
  event: string;
  detail?: unknown;
}

export type RVEmbedDirectorStep =
  | { wait: number }
  | { camera: RVEmbedDirectorCameraAction; duration?: number }
  | { ghostCursor: RVEmbedDirectorGhostCursorAction }
  | { drag: RVEmbedDirectorDragAction; duration?: number }
  | { click: string | RVEmbedDirectorClickAction }
  | { contextMenu: RVEmbedDirectorContextMenuAction }
  | { signal: RVEmbedDirectorSignalAction }
  | { overlay: string | RVEmbedDirectorOverlayAction }
  | { loop: boolean };

export type RVEmbedDirectorScript =
  | readonly RVEmbedDirectorStep[]
  | {
      steps: readonly RVEmbedDirectorStep[];
      loop?: boolean;
    };

export interface RVEmbedDirectorStepDetail {
  step: RVEmbedDirectorStep;
  index: number;
  iteration: number;
}

export interface RVEmbedDirectorErrorDetail extends RVEmbedDirectorStepDetail {
  error: unknown;
  message: string;
  recoverable: boolean;
}

export interface RVEmbedGhostCursorState {
  visible: boolean;
  x: number;
  y: number;
}

export type RVEmbedDirectorActionDetail =
  | {
      type: 'click';
      nodePath: string;
      position: RVEmbedDirectorPoint;
    }
  | {
      type: 'drag';
      nodePath: string;
      position: RVEmbedDirectorPoint;
      transform: RVEmbedDirectorVector3;
    }
  | {
      type: 'contextMenu';
      open: boolean;
      nodePath?: string;
      items: readonly string[];
      position?: RVEmbedDirectorPoint;
    }
  | {
      type: 'overlay';
      event: string;
      detail?: unknown;
    };

export interface RVEmbedDirectorEvents {
  step?(detail: RVEmbedDirectorStepDetail): void;
  error?(detail: RVEmbedDirectorErrorDetail): void;
  ghostCursor?(state: RVEmbedGhostCursorState): void;
  action?(detail: RVEmbedDirectorActionDetail): void;
}

export interface RVEmbedDirectorHost {
  readonly signal: AbortSignal;
  resolveNode(path: string): Object3D | null;
  resolveCamera(action: RVEmbedDirectorCameraAction): RVEmbedDirectorCameraPose | null;
  getCameraPose(): RVEmbedDirectorCameraPose;
  setCameraPose(pose: RVEmbedDirectorCameraPose): void;
  projectNode(node: Object3D): RVEmbedDirectorPoint;
  writeSignal(name: string, value: boolean | number): void;
  readonly events?: RVEmbedDirectorEvents;
}

export interface RVEmbedDirectorApi {
  run(script: RVEmbedDirectorScript): void;
  stop(): void;
}

interface NormalizedScript {
  steps: readonly RVEmbedDirectorStep[];
  loop: boolean;
}

interface ActiveOperation {
  kind: 'wait' | 'camera' | 'ghostCursor' | 'drag';
  elapsed: number;
  duration: number;
  apply?: (progress: number) => void;
}

const DEFAULT_TWEEN_MS = 600;
const DEFAULT_CURSOR_TWEEN_MS = 400;
const MAX_IMMEDIATE_STEPS_PER_TICK = 1_000;

/**
 * Sim-time timeline interpreter for rv-embed demonstrations.
 *
 * The director owns no timers and no animation-frame callbacks. The embedding
 * viewer advances it exclusively from SimulationLoop fixed updates.
 */
export class RVEmbedDirector implements RVEmbedDirectorApi {
  private script: NormalizedScript | null = null;
  private active: ActiveOperation | null = null;
  private index = 0;
  private iteration = 0;
  private running = false;
  private disposed = false;
  private ghostCursor: RVEmbedGhostCursorState = { visible: false, x: 0, y: 0 };
  private ghostNodePath: string | null = null;
  private contextMenuOpen = false;

  constructor(private readonly host: RVEmbedDirectorHost) {
    host.signal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  get isRunning(): boolean {
    return this.running;
  }

  run(script: RVEmbedDirectorScript): void {
    if (this.disposed || this.host.signal.aborted) return;
    this.stop();
    try {
      this.script = normalizeScript(script);
      this.index = 0;
      this.iteration = 0;
      this.running = true;
    } catch (error) {
      this.reportError(error, false, this.currentDetail(invalidStep(script)));
    }
  }

  stop(): void {
    this.running = false;
    this.active = null;
    this.script = null;
    this.index = 0;
    this.iteration = 0;
    this.hideGhostCursor();
    this.closeContextMenu();
  }

  /** Advance the active script by fixed-step simulation time in seconds. */
  tick(dt: number): void {
    if (!this.running || this.disposed || this.host.signal.aborted || !this.script) return;
    let remaining = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    let immediateSteps = 0;

    while (this.running && this.script) {
      if (this.active) {
        remaining = this.advanceActive(remaining);
        if (this.active || remaining <= 0) return;
        continue;
      }

      if (this.index >= this.script.steps.length) {
        if (this.script.loop) {
          this.index = 0;
          this.iteration++;
        } else {
          this.finish();
          return;
        }
      }

      if (++immediateSteps > MAX_IMMEDIATE_STEPS_PER_TICK) {
        this.fail(new Error('RVEmbedDirector loop has no time-consuming action'));
        return;
      }

      const step = this.script.steps[this.index];
      const detail = this.currentDetail(step);
      this.host.events?.step?.(detail);
      try {
        if (this.executeStep(step)) {
          this.index++;
        }
      } catch (error) {
        this.fail(error, detail);
        return;
      }
    }
  }

  /**
   * Snap a running tween to its end state before handing control to the user.
   * Waits are cancelled, while camera/drag/cursor tweens apply progress 1.
   */
  takeover(): void {
    if (!this.running) return;
    this.active?.apply?.(1);
    this.stop();
  }

  private executeStep(step: RVEmbedDirectorStep): boolean {
    if (!isRecord(step)) throw new Error('RVEmbedDirector step must be an object');

    if ('wait' in step) {
      this.startOperation('wait', requiredDuration(step.wait, 'wait'));
      return false;
    }
    if ('camera' in step) {
      const end = this.host.resolveCamera(step.camera);
      if (!end) throw new Error(`RVEmbedDirector camera target not found: ${cameraLabel(step.camera)}`);
      const start = this.host.getCameraPose();
      const current: MutableDirectorCameraPose = {
        position: [...start.position],
        target: [...start.target],
      };
      this.startOperation(
        'camera',
        optionalDuration(step.duration, DEFAULT_TWEEN_MS),
        (progress) => {
          interpolatePoseInto(current, start, end, easeInOut(progress));
          this.host.setCameraPose(current);
          this.refreshGhostCursor();
        },
      );
      return false;
    }
    if ('ghostCursor' in step) {
      const action = requireRecord(step.ghostCursor, 'ghostCursor');
      const target = this.resolveCursorTarget(action.moveTo);
      const start = this.ghostCursor.visible
        ? [this.ghostCursor.x, this.ghostCursor.y] as const
        : [target[0] - 48, target[1] + 32] as const;
      this.ghostNodePath = typeof action.moveTo === 'string' ? action.moveTo : null;
      this.showGhostCursor(start[0], start[1]);
      this.startOperation(
        'ghostCursor',
        optionalDuration(action.duration, DEFAULT_CURSOR_TWEEN_MS),
        (progress) => {
          const eased = easeInOut(progress);
          this.showGhostCursor(
            start[0] + (target[0] - start[0]) * eased,
            start[1] + (target[1] - start[1]) * eased,
            action.visible !== false,
          );
        },
      );
      return false;
    }
    if ('drag' in step) {
      const action = requireRecord(step.drag, 'drag');
      const nodePath = requiredString(action.node, 'drag.node');
      const node = this.host.resolveNode(nodePath);
      if (!node) {
        this.skipMissingNode('drag', nodePath, step);
        return false;
      }
      const end = requiredVector3(action.to, 'drag.to');
      const start = node.position.clone();
      this.ghostNodePath = nodePath;
      this.showGhostCursor(...this.host.projectNode(node));
      this.startOperation(
        'drag',
        optionalDuration(action.duration ?? step.duration, DEFAULT_TWEEN_MS),
        (progress) => {
          node.position.lerpVectors(start, end, easeInOut(progress));
          node.updateMatrixWorld(true);
          const position = this.host.projectNode(node);
          this.showGhostCursor(...position);
          this.host.events?.action?.({
            type: 'drag',
            nodePath,
            position,
            transform: [node.position.x, node.position.y, node.position.z],
          });
        },
      );
      return false;
    }
    if ('click' in step) {
      const nodePath = typeof step.click === 'string'
        ? requiredString(step.click, 'click')
        : requiredString(requireRecord(step.click, 'click').node, 'click.node');
      const node = this.host.resolveNode(nodePath);
      if (!node) {
        this.skipMissingNode('click', nodePath, step);
        return false;
      }
      const position = this.host.projectNode(node);
      this.showGhostCursor(...position);
      this.host.events?.action?.({ type: 'click', nodePath, position });
      this.index++;
      return false;
    }
    if ('contextMenu' in step) {
      const action = requireRecord(step.contextMenu, 'contextMenu');
      if (action.open === false) {
        this.closeContextMenu();
        return true;
      }
      const nodePath = requiredString(action.at, 'contextMenu.at');
      const node = this.host.resolveNode(nodePath);
      if (!node) throw new Error(`RVEmbedDirector contextMenu node not found: ${nodePath}`);
      const position = this.host.projectNode(node);
      const items = Array.isArray(action.items)
        ? action.items.map((item) => String(item))
        : [];
      this.contextMenuOpen = true;
      this.showGhostCursor(...position);
      this.host.events?.action?.({
        type: 'contextMenu',
        open: true,
        nodePath,
        items,
        position,
      });
      return true;
    }
    if ('signal' in step) {
      const action = requireRecord(step.signal, 'signal');
      const name = requiredString(action.name, 'signal.name');
      if (typeof action.value !== 'boolean' && typeof action.value !== 'number') {
        throw new Error('RVEmbedDirector signal.value must be a boolean or number');
      }
      this.host.writeSignal(name, action.value);
      return true;
    }
    if ('overlay' in step) {
      const action = typeof step.overlay === 'string'
        ? { event: step.overlay }
        : requireRecord(step.overlay, 'overlay');
      const event = requiredString(action.event, 'overlay.event');
      this.host.events?.action?.({ type: 'overlay', event, detail: action.detail });
      return true;
    }
    if ('loop' in step) {
      if (step.loop) {
        this.index = 0;
        this.iteration++;
        return false;
      }
      return true;
    }

    throw new Error(`RVEmbedDirector unknown step at index ${this.index}`);
  }

  private startOperation(
    kind: ActiveOperation['kind'],
    durationMs: number,
    apply?: (progress: number) => void,
  ): void {
    this.active = {
      kind,
      elapsed: 0,
      duration: durationMs / 1_000,
      apply,
    };
    apply?.(durationMs === 0 ? 1 : 0);
    if (durationMs === 0) {
      this.active = null;
      this.index++;
    }
  }

  private advanceActive(dt: number): number {
    const active = this.active;
    if (!active) return dt;
    const available = Math.max(0, active.duration - active.elapsed);
    const consumed = Math.min(dt, available);
    active.elapsed += consumed;
    const progress = active.duration === 0 ? 1 : Math.min(active.elapsed / active.duration, 1);
    active.apply?.(progress);
    if (progress < 1) return 0;
    this.active = null;
    this.index++;
    return dt - consumed;
  }

  private resolveCursorTarget(value: unknown): RVEmbedDirectorPoint {
    if (typeof value === 'string') {
      const node = this.host.resolveNode(value);
      if (!node) throw new Error(`RVEmbedDirector ghostCursor node not found: ${value}`);
      return this.host.projectNode(node);
    }
    if (
      Array.isArray(value)
      && value.length === 2
      && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return [value[0], value[1]];
    }
    throw new Error('RVEmbedDirector ghostCursor.moveTo must be a node path or [x, y]');
  }

  private refreshGhostCursor(): void {
    if (!this.ghostCursor.visible || !this.ghostNodePath) return;
    const node = this.host.resolveNode(this.ghostNodePath);
    if (!node) return;
    this.showGhostCursor(...this.host.projectNode(node));
  }

  private skipMissingNode(action: 'drag' | 'click', nodePath: string, step: RVEmbedDirectorStep): void {
    this.reportError(
      new Error(`RVEmbedDirector ${action} node not found: ${nodePath}`),
      true,
      this.currentDetail(step),
    );
    this.index++;
  }

  private fail(error: unknown, detail?: RVEmbedDirectorStepDetail): void {
    const errorDetail = detail ?? this.currentDetail(invalidStep(error));
    this.stop();
    this.reportError(error, false, errorDetail);
  }

  private reportError(
    error: unknown,
    recoverable: boolean,
    detail: RVEmbedDirectorStepDetail,
  ): void {
    this.host.events?.error?.({
      ...detail,
      error,
      message: error instanceof Error ? error.message : String(error),
      recoverable,
    });
  }

  private currentDetail(step: RVEmbedDirectorStep): RVEmbedDirectorStepDetail {
    return {
      step,
      index: this.index,
      iteration: this.iteration,
    };
  }

  private finish(): void {
    this.running = false;
    this.active = null;
    this.script = null;
  }

  private showGhostCursor(x: number, y: number, visible = true): void {
    this.ghostCursor = { visible, x, y };
    this.host.events?.ghostCursor?.(this.ghostCursor);
  }

  private hideGhostCursor(): void {
    if (!this.ghostCursor.visible) return;
    this.ghostCursor = { ...this.ghostCursor, visible: false };
    this.ghostNodePath = null;
    this.host.events?.ghostCursor?.(this.ghostCursor);
  }

  private closeContextMenu(): void {
    if (!this.contextMenuOpen) return;
    this.contextMenuOpen = false;
    this.host.events?.action?.({ type: 'contextMenu', open: false, items: [] });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }
}

function normalizeScript(script: RVEmbedDirectorScript): NormalizedScript {
  if (Array.isArray(script)) {
    if (script.length === 0) throw new Error('RVEmbedDirector script must contain at least one step');
    return { steps: script, loop: false };
  }
  if (!isRecord(script) || !Array.isArray(script.steps) || script.steps.length === 0) {
    throw new Error('RVEmbedDirector script must be a step array or { steps, loop }');
  }
  return {
    steps: script.steps as readonly RVEmbedDirectorStep[],
    loop: script.loop === true,
  };
}

function interpolatePoseInto(
  target: MutableDirectorCameraPose,
  start: RVEmbedDirectorCameraPose,
  end: RVEmbedDirectorCameraPose,
  progress: number,
): void {
  interpolateVectorInto(target.position, start.position, end.position, progress);
  interpolateVectorInto(target.target, start.target, end.target, progress);
}

function interpolateVectorInto(
  target: MutableDirectorVector3,
  start: RVEmbedDirectorVector3,
  end: RVEmbedDirectorVector3,
  progress: number,
): void {
  target[0] = start[0] + (end[0] - start[0]) * progress;
  target[1] = start[1] + (end[1] - start[1]) * progress;
  target[2] = start[2] + (end[2] - start[2]) * progress;
}

function easeInOut(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function optionalDuration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return requiredDuration(value, 'duration');
}

function requiredDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`RVEmbedDirector ${field} must be a non-negative duration in milliseconds`);
  }
  return value;
}

function requiredVector3(value: unknown, field: string): Vector3 {
  if (
    !Array.isArray(value)
    || value.length !== 3
    || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw new Error(`RVEmbedDirector ${field} must be [x, y, z]`);
  }
  return new Vector3(value[0], value[1], value[2]);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`RVEmbedDirector ${field} must be a non-empty string`);
  }
  return value;
}

function requireRecord<T extends object>(value: T, field: string): T;
function requireRecord(value: unknown, field: string): Record<string, unknown>;
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`RVEmbedDirector ${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cameraLabel(action: RVEmbedDirectorCameraAction): string {
  if (typeof action === 'string') return action;
  if ('focus' in action) return action.focus;
  return 'pose';
}

function invalidStep(value: unknown): RVEmbedDirectorStep {
  return value as RVEmbedDirectorStep;
}
