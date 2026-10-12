// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-logic-step-registry.ts — extension seam for LogicStep types that the
 * public engine does not know (plan-729).
 *
 * `RVLogicEngine.buildStep()` maps the built-in `LogicStep_*` types in a
 * `switch`. A step whose runtime lives in a plugin — e.g. the private
 * `LogicStep_MechanismPath`, which drives a private `MechanismPath` — cannot be
 * a `case` there without the public core importing a private type (license
 * cut). Instead the plugin registers a builder here, and the `default:` branch
 * of `buildStep()` asks this registry before it warns.
 *
 * Purely structural: two functions and a map. Without any registration — a
 * community build — the registry stays empty and an unknown step type keeps
 * its old behaviour (`console.warn` + no step).
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVLogicStep } from './rv-logic-step';

/** What a builder gets — exactly the locals `buildStep()` has at hand. */
export interface LogicStepBuildCtx {
  /** The step's own rv_extras block (`rv[stepType]`), `{}` when absent. */
  data: Record<string, unknown>;
  /** The node carrying the step. */
  node: Object3D;
  /** The `LogicStep_*` key that selected this builder. */
  stepType: string;
  registry: NodeRegistry;
  signalStore: SignalStore;
  /**
   * The subtree the steps were authored in — pass it to `registry.resolve()`
   * as the name-fallback boundary (same meaning as in `buildStep()`).
   */
  scope: Object3D | null;
}

/** Builds one leaf step, or returns null when the data cannot produce one. */
export type LogicStepBuilder = (ctx: LogicStepBuildCtx) => RVLogicStep | null;

const builders = new Map<string, LogicStepBuilder>();

/**
 * Register the builder for one `LogicStep_*` type. A second registration for
 * the same type replaces the first (a re-registered feature after an HMR or a
 * viewer re-create), and the returned function removes exactly this builder.
 */
export function registerLogicStepBuilder(type: string, builder: LogicStepBuilder): () => void {
  builders.set(type, builder);
  return () => {
    if (builders.get(type) === builder) builders.delete(type);
  };
}

/** The builder registered for `type`, or undefined. */
export function getLogicStepBuilder(type: string): LogicStepBuilder | undefined {
  return builders.get(type);
}

/** Registered plugin step types — diagnostics and tests. */
export function getRegisteredLogicStepTypes(): string[] {
  return [...builders.keys()];
}
