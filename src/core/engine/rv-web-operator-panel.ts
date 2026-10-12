// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-operator-panel.ts — the operator panel as DATA in the model (plan-543).
 *
 * A `WebOperatorPanel` component on any node carries a plan-542
 * `OperatorPanelConfig` as a JSON string (`Config`). The viewer-owned
 * {@link WebOperatorPanelHost} turns every such component of the loaded model
 * (main model and placements) into one operator window; a station needs no
 * code. The panel is authored in the web editor (JSON field), by MCP
 * (`web_editor_add_component` + `web_editor_set_field`, guide
 * `web_help("operator-panel")`) or by a build script, and travels with the GLB.
 *
 *  - **Component** {@link RVWebOperatorPanel} — pure data, `Web*` convention
 *    (UI-only marker, no Unity runtime function). `init` / `reapplyConfig` /
 *    `dispose` announce themselves on a change channel, so an editor add, a
 *    field edit or a removal reaches the host without a reload.
 *  - **Host** {@link WebOperatorPanelHost} — React-free. Scans the registry,
 *    keeps one {@link OperatorPanelController} per component (signals in,
 *    snapshot out, operator writes as `hmi`), rebuilds a controller only when
 *    its component's fields changed, reports unusable configs in the Problems
 *    panel, and publishes the entry list the overlay
 *    (`hmi/operator-devices/WebOperatorPanelHost.tsx`) renders.
 *
 * Engine layer: no viewer import — the host talks to a narrow target.
 */

import type { Object3D } from 'three';
import type { ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent, setComponentInstance } from './rv-component-registry';
import type { NodeRegistry } from './rv-node-registry';
import { parseWebOperatorPanelConfig } from './rv-extras-validator';
import {
  OperatorPanelController, type OperatorPanelHostViewer,
} from '../hmi/operator-devices/operator-panel-model';
import { clearProblem, clearProblemsOfCode, reportProblem } from '../hmi/problems-store';

/** Component type key. */
export const WEB_OPERATOR_PANEL_TYPE = 'WebOperatorPanel';

/** Problems-panel code of an unusable panel config. */
export const WEB_OPERATOR_PANEL_PROBLEM = 'web-operator-panel-config';

/** Screen corner a panel window first appears in; several panels per corner stack. */
export const WEB_OPERATOR_PANEL_DOCKS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type WebOperatorPanelDock = (typeof WEB_OPERATOR_PANEL_DOCKS)[number];

/** Normalise an authored `Dock`; unknown → `top-left` (the schema default). */
export function parseDock(raw: unknown): WebOperatorPanelDock {
  return (WEB_OPERATOR_PANEL_DOCKS as readonly unknown[]).includes(raw) ? raw as WebOperatorPanelDock : 'top-left';
}

// ─── Change channel ────────────────────────────────────────────────────

const _changeListeners = new Set<() => void>();

/** Subscribe to "a WebOperatorPanel was created, edited or disposed"; returns the unsubscribe. */
export function subscribeWebOperatorPanelChanges(cb: () => void): () => void {
  _changeListeners.add(cb);
  return () => { _changeListeners.delete(cb); };
}

function announceChange(): void {
  for (const cb of _changeListeners) {
    try { cb(); } catch (e) { console.warn('[WebOperatorPanel] change listener failed:', e); }
  }
}

// ─── Component ─────────────────────────────────────────────────────────

/** UI-only marker for realvirtual WEB 3D-HMI: an operator panel window described as JSON. */
export class RVWebOperatorPanel implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(WEB_OPERATOR_PANEL_TYPE);

  readonly node: Object3D;
  isOwner = true;
  /** Window title; empty = the config's `title`. */
  Title = '';
  /** The `OperatorPanelConfig` as a JSON string. */
  Config = '';
  Dock: WebOperatorPanelDock = 'top-left';
  StartCollapsed = false;
  /** True after {@link dispose} (component removed); the host drops it. */
  disposed = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(): void {
    this.Dock = parseDock(this.Dock);
    this.disposed = false;
    announceChange();
  }

  /** IMPLEMENTS RVComponent::reapplyConfig — an editor / MCP field edit. */
  reapplyConfig(): void {
    this.Dock = parseDock(this.Dock);
    announceChange();
  }

  dispose(): void {
    this.disposed = true;
    announceChange();
  }

  /**
   * The authored config: the JSON string, or — when an MCP `valueJson`
   * carried the object itself — that object as stored in the node's extras
   * (the string field would read "[object Object]").
   */
  get configSource(): unknown {
    if (typeof this.Config === 'string' && this.Config !== '[object Object]') return this.Config;
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return rv?.[WEB_OPERATOR_PANEL_TYPE]?.Config ?? this.Config;
  }
}

registerComponent({
  type: WEB_OPERATOR_PANEL_TYPE,
  displayName: 'Web Operator Panel',
  schema: RVWebOperatorPanel.schema,
  capabilities: { authorable: true, ui: { badge: '#5c6bc0' } },
  create: (node) => new RVWebOperatorPanel(node),
  afterCreate: (instance, node) => setComponentInstance(node, instance),
});

// ─── Host ──────────────────────────────────────────────────────────────

/** One operator window of the loaded model. Replaced (new object) when its component changes. */
export interface WebOperatorPanelEntry {
  /** Node path of the component — the entry's identity. */
  readonly nodePath: string;
  /** Window id (remembered position / collapsed state): the config `id`, unique per model. */
  readonly panelId: string;
  /** `Title`, else the config's title, else "Operator panel". */
  readonly title: string;
  readonly dock: WebOperatorPanelDock;
  /** Position in its dock's stack (0 = first). */
  readonly dockIndex: number;
  readonly startCollapsed: boolean;
  readonly controller: OperatorPanelController;
  readonly component: RVWebOperatorPanel;
  /** Config problems (JSON, structure, unknown signals); empty = usable. */
  readonly errors: readonly string[];
}

/** What the host needs from the viewer. */
export interface WebOperatorPanelHostTarget extends OperatorPanelHostViewer {
  readonly registry: NodeRegistry | null | undefined;
}

interface Slot {
  component: RVWebOperatorPanel;
  signature: string;
  controller: OperatorPanelController;
}

const signatureOf = (c: RVWebOperatorPanel): string => {
  const src = c.configSource;
  return [c.Title, c.Dock, c.StartCollapsed ? '1' : '0', typeof src === 'string' ? src : JSON.stringify(src)].join('\u0000');
};

const problemId = (nodePath: string): string => `${WEB_OPERATOR_PANEL_PROBLEM}:${nodePath}`;

/**
 * Viewer-owned: one {@link OperatorPanelController} per `WebOperatorPanel` in
 * the loaded model. The viewer calls {@link reset} on model load, {@link rescan}
 * when placements come or go and {@link clear} on model clear; component
 * changes arrive through the change channel. No per-frame work.
 */
export class WebOperatorPanelHost {
  private readonly _slots = new Map<string, Slot>();
  private _entries: readonly WebOperatorPanelEntry[] = [];
  private readonly _listeners = new Set<() => void>();
  private _scheduled = false;
  private readonly _offChannel: () => void;

  constructor(private readonly target: WebOperatorPanelHostTarget) {
    this._offChannel = subscribeWebOperatorPanelChanges(() => this.requestRescan());
  }

  /** The windows to render, in dock order. A new array on every change. */
  get entries(): readonly WebOperatorPanelEntry[] { return this._entries; }

  subscribe = (cb: () => void): (() => void) => {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  };

  getEntries = (): readonly WebOperatorPanelEntry[] => this._entries;

  /** Model loaded: rebuild every controller against the new signals. */
  reset(): void {
    this._stopAll();
    this.rescan();
  }

  /** Reconcile with the registry: start new panels, rebuild edited ones, drop removed ones. */
  rescan(): void {
    this._scheduled = false;
    const reg = this.target.registry;
    const found = reg ? reg.getAll<RVWebOperatorPanel>(WEB_OPERATOR_PANEL_TYPE) : [];
    let changed = false;
    const seen = new Set<string>();
    for (const { path, instance } of found) {
      if (!(instance instanceof RVWebOperatorPanel) || instance.disposed) continue;
      seen.add(path);
      const signature = signatureOf(instance);
      const prev = this._slots.get(path);
      if (prev && prev.component === instance && prev.signature === signature) continue;
      prev?.controller.stop();
      this._slots.set(path, { component: instance, signature, controller: this._createController(instance, path) });
      changed = true;
    }
    for (const [path, slot] of this._slots) {
      if (seen.has(path)) continue;
      slot.controller.stop();
      this._slots.delete(path);
      clearProblem(problemId(path));
      changed = true;
    }
    if (changed || this._entries.length !== this._slots.size) this._publish();
  }

  /** Model cleared: every window goes. */
  clear(): void {
    this._stopAll();
    clearProblemsOfCode(WEB_OPERATOR_PANEL_PROBLEM);
    if (this._entries.length > 0) {
      this._entries = [];
      this._notify();
    }
  }

  dispose(): void {
    this.clear();
    this._offChannel();
    this._listeners.clear();
  }

  private _createController(c: RVWebOperatorPanel, path: string): OperatorPanelController {
    const parsed = parseWebOperatorPanelConfig(c.configSource);
    const controller = new OperatorPanelController(parsed.raw, {
      errors: parsed.errors,
      id: `web-operator-panel:${path}`,
    });
    controller.start(this.target);
    return controller;
  }

  private _stopAll(): void {
    for (const slot of this._slots.values()) slot.controller.stop();
    this._slots.clear();
  }

  /** {@link rescan} on the next microtask (coalesced) — after the caller's registry changes settled. */
  requestRescan(): void {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => { if (this._scheduled) this.rescan(); });
  }

  private _publish(): void {
    const used = new Set<string>();
    const perDock = new Map<WebOperatorPanelDock, number>();
    const entries: WebOperatorPanelEntry[] = [];
    const paths = [...this._slots.keys()].sort();
    for (const nodePath of paths) {
      const { component, controller } = this._slots.get(nodePath)!;
      const config = controller.config;
      let panelId = config?.id ?? `web-operator-panel:${nodePath}`;
      for (let n = 2; used.has(panelId); n++) panelId = `${config?.id ?? 'web-operator-panel'}#${n}`;
      used.add(panelId);
      const dock = parseDock(component.Dock);
      const dockIndex = perDock.get(dock) ?? 0;
      perDock.set(dock, dockIndex + 1);
      const errors = controller.getSnapshot().errors;
      const title = component.Title || config?.title || 'Operator panel';
      entries.push({
        nodePath, panelId, title, dock, dockIndex,
        startCollapsed: component.StartCollapsed === true,
        controller, component, errors,
      });
      if (errors.length > 0) {
        reportProblem({
          id: problemId(nodePath),
          severity: 'warning',
          code: WEB_OPERATOR_PANEL_PROBLEM,
          title: `Operator panel "${title}" cannot be used`,
          detail: `${nodePath}: ${errors.slice(0, 6).join('; ')}${errors.length > 6 ? ` … and ${errors.length - 6} more` : ''}`,
          nodePath,
        });
      } else {
        clearProblem(problemId(nodePath));
      }
    }
    this._entries = entries;
    this._notify();
  }

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}
