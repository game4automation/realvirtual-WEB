// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fmu-ops — the editor verbs `attach-fmu` / `detach-fmu` (plan-498 F13).
 *
 * Both run THROUGH the document op protocol of {@link AssetDocument}
 * (`rv-asset-document.ts`), never by mutating nodes directly: an attach is the
 * `addComponent` op of an `Fmu` record, a detach its `removeComponent` op. The
 * executor then constructs / disposes the `RVFmu` instance, which creates /
 * removes the signal children. What that buys, without a line of extra
 * machinery:
 *  - Undo / Redo — the inverse payload (`prevFields`) is the whole record;
 *  - the Dirty state and the draft autosave;
 *  - draft replay after a page reload — the op log is replayed verbatim.
 *
 * What the op log canNOT carry is the package BYTES (ops are JSON). They go to
 *  1. the binary resource store, held by the document (`fmuDocumentResourceId`)
 *     for as long as it is open — also after a detach, so Undo finds them;
 *  2. the draft side-store (`putDraftFmuPackage`, rv-asset-draft-storage.ts),
 *     so a reload before the first save recovers them;
 *     {@link restoreFmuPackagesForOps} puts them back before a replay.
 *
 * The browser parse of `modelDescription.xml` happens BEFORE the op (lazy
 * module, `rv-fmu-model-description.ts`); this module never imports it.
 */

import type { AssetDocument } from '../editor/rv-asset-document';
import { assetOpHeader, dedupeComponentKey } from '../editor/rv-asset-ops';
import { putDraftFmuPackage, getDraftFmuPackage } from '../editor/rv-asset-draft-storage';
import { binaryResources, isFmuComponentKey } from '../engine/rv-binary-resources';
import type { RvOp } from './rv-unified-ops';
import type { FmuModelDescription } from '../engine/rv-fmu-model-description';
import type { EditTarget } from '../hmi/rv-edit-target';

/** Op-verb names (labels of the transaction / undo entry). */
export const ATTACH_FMU = 'attach-fmu';
export const DETACH_FMU = 'detach-fmu';

/** A package that passed the browser parse, ready to attach. */
export interface FmuPackage {
  fileName: string;
  sha256: string;
  bytes: Uint8Array;
  description: FmuModelDescription;
}

/** Why an attach was refused before any op ran. */
export class FmuAttachRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FmuAttachRefusedError';
  }
}

/** Binary-resource document id of an open editor document. */
export function fmuDocumentResourceId(documentId: string): string {
  return `asset-doc:${documentId}`;
}

/**
 * The `Fmu` extras record for a parsed package (plan-498 §2.3). `bufferView`
 * is -1 until the writer embeds the bytes on save.
 */
export function buildFmuExtras(
  pkg: FmuPackage,
  keep?: Partial<Record<'StepSize' | 'Tolerance' | 'AllowViewerToFmu' | 'RestartOnReset', unknown>>,
  prevOverrides?: unknown,
): Record<string, unknown> {
  const d = pkg.description;
  const embed: Record<string, unknown> = {
    fileName: pkg.fileName,
    sha256: pkg.sha256,
    guid: d.guid,
    modelName: d.modelName,
    fmiVersion: d.fmiVersion,
    byteLength: pkg.bytes.byteLength,
    bufferView: -1,
  };
  if (d.generationTool !== undefined) embed.generationTool = d.generationTool;
  if (d.generationDateAndTime !== undefined) embed.generationDateAndTime = d.generationDateAndTime;
  const out: Record<string, unknown> = {
    StepSize: keep?.StepSize ?? 0.01,
    Tolerance: keep?.Tolerance ?? 0.000001,
    AllowViewerToFmu: keep?.AllowViewerToFmu ?? true,
    FmuEmbed: embed,
    FmuVariables: d.variables.map((v) => (v.enumItems ? { ...v, enumItems: v.enumItems.map((it) => ({ ...it })) } : { ...v })),
  };
  // plan-502 — a re-attach keeps the author's start-value overrides BY NAME
  // (a changed vr does not matter). Entries the new package cannot take (name
  // missing, type changed, no longer overridable) stay in the map but are not
  // applied: RVFmu lists them as orphaned (`fmu-override-orphaned`, conflict
  // row with "Entfernen") and the provisioning never sends them.
  if (prevOverrides && typeof prevOverrides === 'object' && !Array.isArray(prevOverrides)
    && Object.keys(prevOverrides).length > 0) {
    out.FmuStartOverrides = { ...(prevOverrides as Record<string, unknown>) };
  }
  if (keep?.RestartOnReset !== undefined) out.RestartOnReset = keep.RestartOnReset;
  return out;
}

/**
 * plan-512 F11 — the `FmuUnits` record of a parsed package: its
 * `UnitDefinitions` (unit name → FMI BaseUnit). Empty when the package defines
 * none. Written by {@link attachFmu} next to {@link buildFmuExtras}; kept out of
 * `buildFmuExtras` itself so the shipped demo recipe (which predates the field)
 * still describes its file byte for byte.
 */
export function fmuUnitsExtras(pkg: FmuPackage): Record<string, unknown> {
  const units = pkg.description.units;
  if (!units || Object.keys(units).length === 0) return {};
  const copy: Record<string, unknown> = {};
  for (const [name, u] of Object.entries(units)) copy[name] = { ...u };
  return { FmuUnits: copy };
}

/**
 * Validate a parsed package for attaching: FMI 2.0 Co-Simulation (the parser
 * already refuses anything else) with a win64 binary — CONNECT executes win64
 * only (plan-498 NF "Plattform").
 */
export function checkFmuAttachable(pkg: FmuPackage): void {
  const d = pkg.description;
  if (d.fmiVersion !== '2.0' || !d.coSimulation) {
    throw new FmuAttachRefusedError(`${pkg.fileName} is not an FMI 2.0 Co-Simulation FMU.`);
  }
  if (!d.hasWin64Binary) {
    throw new FmuAttachRefusedError(
      `${pkg.fileName} has no binaries/win64/${d.modelIdentifier || '<model>'}.dll — realvirtual CONNECT runs win64 FMUs only.`,
    );
  }
}

/** The `Fmu*` component keys on a node. */
function fmuKeysOn(doc: AssetDocument, nodePath: string): string[] {
  const rv = doc.nodeExtras(nodePath);
  return rv ? Object.keys(rv).filter(isFmuComponentKey) : [];
}

/**
 * `attach-fmu`: attach a parsed package to the node at `nodePath`.
 *
 * A node already carrying an `Fmu` record (e.g. one added through the generic
 * "Add component" path, still without a package) has it REPLACED in the same
 * undo step, keeping its StepSize / Tolerance / AllowViewerToFmu. Returns the
 * component key.
 */
export async function attachFmu(doc: AssetDocument, nodePath: string, pkg: FmuPackage): Promise<string> {
  checkFmuAttachable(pkg);
  // Bytes first: the RVFmu constructed by the op looks them up in init().
  binaryResources.put(pkg.sha256, pkg.bytes, fmuDocumentResourceId(doc.id));
  await putDraftFmuPackage(pkg.sha256, pkg.bytes);

  const existing = fmuKeysOn(doc, nodePath)[0];
  if (!existing) {
    const rv = doc.nodeExtras(nodePath);
    const componentType = dedupeComponentKey(rv ?? undefined, 'Fmu');
    await doc.applyOp({
      ...assetOpHeader(), kind: 'addComponent', nodePath, componentType,
      fields: { ...buildFmuExtras(pkg), ...fmuUnitsExtras(pkg) },
    });
    return componentType;
  }
  const prevFields = { ...(doc.nodeExtras(nodePath)?.[existing] as Record<string, unknown> | undefined ?? {}) };
  await doc.withTransaction(ATTACH_FMU, async () => {
    await doc.applyOp({ ...assetOpHeader(), kind: 'removeComponent', nodePath, componentType: existing, prevFields });
    await doc.applyOp({
      ...assetOpHeader(), kind: 'addComponent', nodePath, componentType: existing,
      fields: {
        ...buildFmuExtras(pkg, prevFields as Record<string, unknown>, prevFields.FmuStartOverrides),
        ...fmuUnitsExtras(pkg),
      },
    });
  });
  return existing;
}

/**
 * `detach-fmu`: remove the `Fmu` component (and with it its signal children).
 * The package stays in the store while the document is open, so Undo restores
 * a runnable instance. No-op (false) when the node carries no FMU.
 */
export async function detachFmu(doc: AssetDocument, nodePath: string, componentType?: string): Promise<boolean> {
  const key = componentType ?? fmuKeysOn(doc, nodePath)[0];
  if (!key) return false;
  const prevFields = { ...(doc.nodeExtras(nodePath)?.[key] as Record<string, unknown> | undefined ?? {}) };
  await doc.applyOp({ ...assetOpHeader(), kind: 'removeComponent', nodePath, componentType: key, prevFields });
  return true;
}

// ─── Start-value overrides (plan-502 F6) ────────────────────────────────

/** Field name of the override map on an `Fmu` record. */
export const FMU_START_OVERRIDES_FIELD = 'FmuStartOverrides';

function overrideString(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function plainMap(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/**
 * Store `value` as the start-value override of variable `name` — ONE `setField`
 * op on `Fmu.FmuStartOverrides` through the active edit target (Undo, Dirty,
 * draft). `prev` is the map as it is now (`RVFmu.FmuStartOverrides`). A no-op
 * (false) when the stored value is already `value` or no target is available.
 */
export function setFmuStartOverride(
  target: EditTarget,
  nodePath: string,
  name: string,
  value: string | number | boolean,
  prev: unknown,
  componentType = 'Fmu',
): boolean {
  if (!target.available || !name) return false;
  const before = plainMap(prev);
  const text = overrideString(value);
  if (before[name] === text) return false;
  const next = { ...before, [name]: text };
  target.setField(nodePath, componentType, FMU_START_OVERRIDES_FIELD, next, Object.keys(before).length > 0 ? before : undefined);
  return true;
}

/**
 * Remove the override of variable `name` — a `setField` with the remaining map,
 * or an `unsetField` when it was the last one (the map is then `{}` again).
 * No-op (false) when no override is stored for `name`.
 */
export function clearFmuStartOverride(
  target: EditTarget,
  nodePath: string,
  name: string,
  prev: unknown,
  componentType = 'Fmu',
): boolean {
  if (!target.available) return false;
  const before = plainMap(prev);
  if (!Object.prototype.hasOwnProperty.call(before, name)) return false;
  const next = { ...before };
  delete next[name];
  if (Object.keys(next).length === 0) target.unsetField(nodePath, componentType, FMU_START_OVERRIDES_FIELD, before);
  else target.setField(nodePath, componentType, FMU_START_OVERRIDES_FIELD, next, before);
  return true;
}

/** Every package SHA an op log references through an `Fmu*` record. */
export function fmuShasOfOps(ops: readonly RvOp[]): string[] {
  const shas = new Set<string>();
  for (const op of ops) {
    const o = op as unknown as Record<string, unknown>;
    const collect = (fields: unknown): void => {
      const embed = (fields as Record<string, unknown> | undefined)?.FmuEmbed as Record<string, unknown> | undefined;
      if (typeof embed?.sha256 === 'string' && embed.sha256) shas.add(embed.sha256);
    };
    if (typeof o.componentType === 'string' && isFmuComponentKey(o.componentType)) {
      collect(o.fields);
      collect(o.prevFields);
    }
    // Composite / transaction entries carry their children.
    if (Array.isArray(o.ops)) for (const s of fmuShasOfOps(o.ops as RvOp[])) shas.add(s);
  }
  return [...shas];
}

/**
 * Put every package an op log needs back into the store before it is
 * replayed — from the store itself (still open elsewhere) or the draft side-
 * store. Returns the SHAs that could NOT be recovered (those instances load as
 * `unsupported`).
 */
export async function restoreFmuPackagesForOps(ops: readonly RvOp[], documentId: string): Promise<string[]> {
  const holder = fmuDocumentResourceId(documentId);
  const missing: string[] = [];
  for (const sha of fmuShasOfOps(ops)) {
    if (binaryResources.retain(sha, holder)) continue;
    const bytes = await getDraftFmuPackage(sha);
    if (bytes) binaryResources.put(sha, bytes, holder);
    else missing.push(sha);
  }
  if (missing.length > 0) {
    console.warn(`[fmu-ops] ${missing.length} FMU package(s) of the draft could not be recovered: ${missing.join(', ')}`);
  }
  return missing;
}
