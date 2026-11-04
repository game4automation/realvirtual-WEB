// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-ops-limits — the size limits of CONNECT's write core (`POST /config/ops`), checked in the
 * browser BEFORE anything expensive (the per-row address check of a table import) and before a batch
 * is sent (plan-2025 P7 review fix 8).
 *
 * The values are CONNECT's own (`Api/ConfigOpsEndpoints.cs` `MaxOps` / `MaxBodyBytes`,
 * `Core/ConfigOps.cs` `MaxSignalsPerOp`). A batch over a limit is refused here with a message that
 * says which limit and by how much — it is never split silently: a batch is atomic, and two batches
 * would be two commits the user did not ask for.
 *
 * Pure: no store, no fetch.
 */

import type { ConnectConfigOp } from './connect-store';

/** Most operations in one batch (`ConfigOpsEndpoints.MaxOps`). */
export const CONNECT_OPS_MAX_OPS = 10_000;
/** Most signals one operation may carry (`ConfigOps.MaxSignalsPerOp`). */
export const CONNECT_OPS_MAX_SIGNALS_PER_OP = 20_000;
/** Largest request body in UTF-8 bytes (`ConfigOpsEndpoints.MaxBodyBytes`, 4 MiB). */
export const CONNECT_OPS_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * INPUT PROTECTION, not a CONNECT limit: the most raw table rows an import preview accepts at all.
 * Raw rows are no batch measure - unchanged, kept and rejected rows write nothing - so the real
 * limits (MaxOps, MaxSignalsPerOp, MaxBodyBytes) are checked on the batch actually built. This only
 * stops absurd inputs before the per-row gateway validation starts.
 */
export const CONNECT_IMPORT_MAX_RAW_ROWS = 200_000;

/** Room for `expectedRevision` / `expectedInstance` around the ops array. */
const ENVELOPE_RESERVE_BYTES = 256;

/** Signals one operation carries (signal lists, a topic, an interface body with its topics). */
export function signalsInOp(op: ConnectConfigOp): number {
  let n = (op.signals?.length ?? 0) + (op.topicConfig?.signals?.length ?? 0);
  const body = op.interface;
  if (body) n += (body.signals?.length ?? 0) + (body.topics ?? []).reduce((a, t) => a + (t?.signals?.length ?? 0), 0);
  return n;
}

/** UTF-8 length of a string. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The first limit an operation COUNT breaks, or null. Cheap: usable before the operations exist
 * (an upper bound such as the number of table rows).
 */
export function opCountLimitError(count: number, what = 'operations'): string | null {
  if (count <= CONNECT_OPS_MAX_OPS) return null;
  return `${count} ${what} — CONNECT accepts at most ${CONNECT_OPS_MAX_OPS} changes in one batch. `
    + 'Nothing was sent. Split the input into smaller parts and import them one after the other.';
}

/** The input-protection refusal for an import table with absurdly many raw rows, or null. */
export function rawRowLimitError(rows: number): string | null {
  if (rows <= CONNECT_IMPORT_MAX_RAW_ROWS) return null;
  return `${rows} rows - the import accepts at most ${CONNECT_IMPORT_MAX_RAW_ROWS} rows per file as input protection. `
    + 'Nothing was checked or sent. Split the file into smaller parts and import them one after the other.';
}

/** The first limit a batch breaks, or null when CONNECT will accept its size. */
export function configOpsLimitError(ops: readonly ConnectConfigOp[]): string | null {
  const count = opCountLimitError(ops.length);
  if (count) return count;
  for (let i = 0; i < ops.length; i++) {
    const n = signalsInOp(ops[i]);
    if (n > CONNECT_OPS_MAX_SIGNALS_PER_OP) {
      return `Operation ${i + 1} (${ops[i].op}) carries ${n} signals — CONNECT accepts at most `
        + `${CONNECT_OPS_MAX_SIGNALS_PER_OP} signals in one operation. Nothing was sent.`;
    }
  }
  const bytes = utf8Bytes(JSON.stringify({ ops })) + ENVELOPE_RESERVE_BYTES;
  if (bytes > CONNECT_OPS_MAX_BODY_BYTES) {
    const mib = (b: number) => (b / (1024 * 1024)).toFixed(1);
    return `The change is ${mib(bytes)} MiB — CONNECT accepts at most ${mib(CONNECT_OPS_MAX_BODY_BYTES)} MiB in one batch. `
      + 'Nothing was sent. Split the input into smaller parts and import them one after the other.';
  }
  return null;
}
