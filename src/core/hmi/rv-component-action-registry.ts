// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-action-registry.ts — Plugin registry for component action
 * buttons in the Property Inspector.
 *
 * Any component type can contribute one or more action buttons that render
 * at the bottom of its `ComponentSection`. Actions are clickable buttons —
 * not field editors — so they're the right primitive for one-shot operations
 * ("Invert X", "Jog Forward", "Reset Sensor", "Recalibrate"…) rather than
 * value editing.
 *
 * Self-registration pattern, same shape as `fieldRendererRegistry`:
 *
 * ```ts
 * componentActionRegistry.register('Splat', [
 *   {
 *     id: 'invertX',
 *     label: 'Invert X',
 *     icon: SwapHoriz,
 *     isActive: (ctx) => ctx.node.scale.x < 0,
 *     onClick: (ctx) => { /* mutate node + emit event *\/ },
 *   },
 * ]);
 * ```
 *
 * Multiple registrations against the same component type append — i.e. a
 * second `register('Drive', [...])` adds to the existing Drive actions
 * rather than replacing them. This way unrelated plugins can each
 * contribute their own buttons.
 */

import type { ComponentType } from 'react';
import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';

/** Context handed to every action callback (isActive + onClick). */
export interface ComponentActionContext {
  /** The Three.js node owning the component data. */
  readonly node: Object3D;
  /** Full hierarchy path of the node (stable identifier across renders). */
  readonly nodePath: string;
  /** Live viewer instance — use for `emit`, `markRenderDirty`, registry lookups. */
  readonly viewer: RVViewer;
  /** The component's `userData.realvirtual[componentType]` data snapshot. */
  readonly componentData: Record<string, unknown>;
  /** The CONCRETE component key of the section, including any `_N` dedup
   *  suffix (e.g. `Drive_1`) — actions registered against the base type use
   *  this to address the exact instance (asset editor Remove). */
  readonly componentType: string;
}

/**
 * One action button registered against a component type.
 *
 * `isActive` is optional — when it returns `true`, the button renders with
 * a filled / highlighted style so toggle-like actions ("currently inverted")
 * have a clear visual state without needing a separate boolean field.
 */
export interface ComponentAction {
  /** Unique within its component type. Used as React key + analytics tag. */
  readonly id: string;
  /** Short button label (1–3 words). Falls back to id when omitted. A function
   *  form receives the ctx per render — used by two-click confirm actions
   *  ("Unbind all" → "Confirm unbind all", plan-325). */
  readonly label?: string | ((ctx: ComponentActionContext) => string);
  /** Optional MUI icon component rendered before the label. */
  readonly icon?: ComponentType<{ sx?: object }>;
  /** Optional tooltip — explains the effect of clicking. */
  readonly tooltip?: string;
  /** When `true`, the button uses the active/filled style. Defaults to off. */
  readonly isActive?: (ctx: ComponentActionContext) => boolean;
  /** Sort order within the component's action row. Lower = earlier. Default 100. */
  readonly order?: number;
  /** Hidden when this returns `false`. Defaults to always visible. */
  readonly visible?: (ctx: ComponentActionContext) => boolean;
  /**
   * Optional color override for the button border / fill. Use this to
   * convey axis or status semantics (e.g. X=red, Y=green, Z=blue for the
   * Three.js axis convention). When omitted, the theme primary color is
   * used. Accepts any CSS color string.
   */
  readonly color?: string;
  /** Action handler. Called on button click. */
  onClick(ctx: ComponentActionContext): void;
}

class ComponentActionRegistry {
  private actions = new Map<string, ComponentAction[]>();

  /**
   * Add one or more actions to a component type. Multiple registrations
   * accumulate (different plugins can each contribute buttons).
   */
  register(componentType: string, actions: readonly ComponentAction[]): void {
    if (actions.length === 0) return;
    const existing = this.actions.get(componentType) ?? [];
    this.actions.set(componentType, [...existing, ...actions]);
  }

  /** All actions for a component type, sorted by `order` (default 100). */
  get(componentType: string): readonly ComponentAction[] {
    const list = this.actions.get(componentType);
    if (!list) return EMPTY;
    // Sort copy — keeps registration order stable for equal `order`s.
    return [...list].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** True if any action is registered for this type. Cheap pre-check. */
  has(componentType: string): boolean {
    return (this.actions.get(componentType)?.length ?? 0) > 0;
  }
}

const EMPTY: readonly ComponentAction[] = Object.freeze([]);

/** Singleton instance — import this everywhere. */
export const componentActionRegistry = new ComponentActionRegistry();
