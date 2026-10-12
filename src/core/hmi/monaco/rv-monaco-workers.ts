// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-monaco-workers.ts — the ONE `MonacoEnvironment.getWorker` of the page
 * (plan-555 Phase 1).
 *
 * Several lazy Monaco loaders share one global environment: the script editor
 * (TypeScript worker), the JSON field editor (JSON worker) and — in internal
 * builds — the private ST editor (generic worker only). Before this registry
 * each loader wrote `self.MonacoEnvironment` itself, and whichever loaded last
 * decided which workers the others got (the private ST loader overwrote it
 * unconditionally).
 *
 * Now every loader registers factories per worker LABEL:
 *
 *  - `registerMonacoWorker(['typescript', 'javascript'], () => new TsWorker())`
 *  - `registerMonacoWorker(['*'], () => new EditorWorker())` — the fallback
 *    for every label nobody claimed (Monaco asks for `editorWorkerService`).
 *
 * **First wins** per label: a second registration of a label is a no-op, so
 * the load order of the loaders never matters. The dispatcher is installed
 * idempotently on the first registration.
 *
 * This module imports nothing from `monaco-editor` (guarded by
 * tests/plc-import-boundary.node.test.ts) — the factories come as closures
 * from the loaders, whose `?worker` imports stay dynamic.
 */

/** Creates a fresh worker for a label. */
export type MonacoWorkerFactory = () => Worker;

/** The label that answers every label without its own factory. */
export const MONACO_FALLBACK_WORKER_LABEL = '*';

interface MonacoEnvironmentLike {
  getWorker?: (workerId: string, label: string) => Worker;
  [key: string]: unknown;
}

/**
 * The registry lives on the global object, not in this module: a dev server
 * that serves the module under two URLs (public alias and the private
 * package's relative path) must still yield ONE registry.
 */
const REGISTRY_KEY = '__rvMonacoWorkerFactories';

type Holder = { [REGISTRY_KEY]?: Map<string, MonacoWorkerFactory>; MonacoEnvironment?: MonacoEnvironmentLike };

function holder(): Holder {
  return self as unknown as Holder;
}

function registry(): Map<string, MonacoWorkerFactory> {
  const h = holder();
  let map = h[REGISTRY_KEY];
  if (!map) {
    map = new Map();
    h[REGISTRY_KEY] = map;
  }
  return map;
}

/** Marks the dispatcher so a second module instance recognises it. */
const DISPATCH_MARK = '__rvMonacoWorkerDispatch';

function dispatch(_workerId: string, label: string): Worker {
  const map = registry();
  const factory = map.get(label) ?? map.get(MONACO_FALLBACK_WORKER_LABEL);
  if (!factory) {
    throw new Error(`[rv-monaco-workers] no Monaco worker registered for label '${label}' and no '*' fallback — register one before creating an editor`);
  }
  return factory();
}
(dispatch as unknown as Record<string, boolean>)[DISPATCH_MARK] = true;

function installDispatcher(): void {
  const h = holder();
  const env = h.MonacoEnvironment;
  const current = env?.getWorker as (((id: string, label: string) => Worker) & Record<string, unknown>) | undefined;
  if (current && current[DISPATCH_MARK]) return;
  h.MonacoEnvironment = { ...(env ?? {}), getWorker: dispatch };
}

/**
 * Registers a worker factory for each of `labels` (first wins — a label that
 * already has a factory keeps it) and installs the shared dispatcher.
 */
export function registerMonacoWorker(labels: readonly string[], factory: MonacoWorkerFactory): void {
  const map = registry();
  for (const label of labels) {
    if (!map.has(label)) map.set(label, factory);
  }
  installDispatcher();
}

/** True when a factory is registered for `label` (exactly, without the fallback). */
export function hasMonacoWorker(label: string): boolean {
  return registry().has(label);
}

/** Test seam: forgets every registration and the installed environment. */
export function resetMonacoWorkersForTest(): void {
  const h = holder();
  delete h[REGISTRY_KEY];
  delete h.MonacoEnvironment;
}
