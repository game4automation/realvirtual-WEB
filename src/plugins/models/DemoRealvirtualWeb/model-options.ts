// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * model-options.ts — Selectable model options for the DemoRealvirtualWeb base model.
 *
 * Selector metadata only (id + label). What each option *does* is spelled out
 * imperatively in index.ts (`applyModelOption`) using the command helpers from
 * ../model-option-plugin.ts. main.ts eager-globs every `models/<name>/model-options.ts`
 * to build the selector, so this stays dependency-light (a type-only import is erased).
 */

import type { ModelOptionDef } from '../model-option-plugin';

/** Base GLB (filename without .glb) these options apply to. */
export const baseModel = 'DemoRealvirtualWeb';

/**
 * Selector entries — intentionally EMPTY (plan-373 F5).
 *
 * The two supplier variants are the same GLB with a different AAS mapping, so
 * three near-identical rows in the model list were more confusing than useful.
 * The generic expander in main.ts skips a module with no options, which is all
 * it takes to drop them from every model selection.
 */
export const modelOptions: ModelOptionDef[] = [];

/**
 * Deep-link-only variants: unreachable from the UI, still reachable — and
 * shareable and reload-stable — via `?option=<id>`. Behaviour lives in index.ts
 * `applyModelOption`; this list is what tells the URL contract which option ids
 * this base model actually understands (so a foreign one gets dropped instead of
 * leaking on to the next model).
 */
export const deepLinkOptions: ModelOptionDef[] = [
  { id: 'bosch', label: 'Bosch' },
  { id: 'sew', label: 'SEW' },
];
