// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Problems codes a DES-unsuitable entry may carry (classified in tests/helpers/problem-code-classification.ts). */
export type DesUnsuitableCode = 'des-plc-not-event-suitable';

/**
 * One DES-unsuitable entry (plan-2207 F18): a program or root that must not run in event-driven DES,
 * reported by a subsystem through `DesSnapshotBlockers.register(…, unsuitable)`. Type-only module: the
 * eager registry imports it with `import type`, so it costs the startup path nothing.
 */
export interface DesUnsuitableEntry {
  /** User-facing subsystem name, e.g. 'PLC program'. */
  readonly system: string;
  /** Program name or node path. */
  readonly node: string;
  /** Problems code reported by the DES runner. */
  readonly code: DesUnsuitableCode;
  readonly line?: number;
  readonly column?: number;
  /** Rule id, e.g. 'D1'. */
  readonly rule: string;
  readonly message: string;
}
