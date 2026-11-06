// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-reconcile — the READ-ONLY reconciliation of model PLC signals against ONE CONNECT
 * interface (plan-589 §2.3, F6).
 *
 * ## What it is, and what it deliberately is not
 *
 * It answers one question per signal PLACE of an interface and per model signal: is this coupled,
 * and if not, what is in the way. It is pure (no React, no store, no fetch), and it **never
 * writes** — not the model, not CONNECT. Every repair is a separate, explicit action the user
 * clicks (plan-589 §"Wann laeuft der Abgleich?"). That is the difference to `rv-plc-automap`
 * (plan-545), whose report exists in order to be APPLIED; the legacy Apply survives only as the
 * explicit "Adopt legacy addresses" action.
 *
 * ## The one rule that makes the report trustworthy
 *
 * `mapped` means the runtime key is IDENTICAL on both sides: the model signal's runtime name
 * (`ModelPlcSignal.name`, the SignalStore key) equals `SignalConfig.Name` character for character.
 * Nothing is matched through a normalisation, ever — the gateway couples by that exact string, so a
 * normalised "match" would claim a data flow that does not exist (SOL R1 #11). TIA quoting variants
 * (`"DB".Member` vs. `DB.Member`) are real and worth showing, so they get their OWN category,
 * {@link ReconcileCategory} `name-variant`, carrying the other spelling as `suggestion`.
 *
 * ## Addresses: the gateway decides, not this file
 *
 * `no-address` is raised ONLY where `addressRuleFor(slot, schema) === 'required'` and the place
 * carries no address. An absent rule (an older gateway) is "never said" and raises nothing
 * (plan-589 §5.4) — which is also why the rule is read through `addressRuleFor` and never
 * reconstructed from the interface type here.
 */

import {
  addressRuleFor,
  collectInterfaceSlots,
  type IfaceSignalSlot,
} from './rv-iface-signal-slots';
import { normaliseTagName, type ModelPlcSignal } from './rv-plc-automap';
import type { ConnectInterface, ConnectSignalSchema } from '../hmi/connect-store';

// ── Types ──────────────────────────────────────────────────────────────

export const RECONCILE_CATEGORIES = [
  'mapped',
  'name-variant',
  'missing-in-plc',
  'plc-only',
  'type-mismatch',
  'no-address',
] as const;

/**
 * The state of one coupling:
 *   `mapped`         — identical name on both sides, type compatible, address where required
 *   `name-variant`   — only a quoting variant of the name matches (never a coupling)
 *   `missing-in-plc` — a model signal no place of this interface carries
 *   `plc-only`       — a place of this interface no model signal claims
 *   `type-mismatch`  — same name, incompatible direction / value kind / data type
 *   `no-address`     — same name, but the gateway requires an address this place has not got
 */
export type ReconcileCategory = typeof RECONCILE_CATEGORIES[number];

/** One row of the report. */
export interface ReconcileEntry {
  category: ReconcileCategory;
  /** Model runtime name (`missing-in-plc`) or the CONNECT signal name (every other category). */
  name: string;
  /** The interface place this row is about; absent for `missing-in-plc`. */
  slot?: IfaceSignalSlot;
  /** Model signal type (`PLCOutputBool`, …) where a model signal is involved. */
  modelType?: string;
  /** Model `OriginDataType` where a model signal is involved. */
  modelDataType?: string;
  /**
   * `name-variant`: the OTHER spelling (the model runtime name this place would couple to after a
   * rename). `plc-only`: {@link UNSUPPORTED_TYPE_HINT} when the model cannot register this type at
   * all, so the UI says so instead of offering a creation that would fail.
   */
  suggestion?: string;
  /** Node path of the model signal, for diagnostics and for jumping to it. */
  path?: string;
}

export interface ReconcileReport {
  interfaceId: string;
  interfaceType: string;
  counts: Record<ReconcileCategory, number>;
  entries: ReconcileEntry[];
}

/** Marker on a `plc-only` row the model can never hold (CONNECT Text/String — `SIGNAL_TYPES`). */
export const UNSUPPORTED_TYPE_HINT = 'unsupported type';

// ── Types: directions, value kinds, data types ─────────────────────────

/** `PLCInput…` → written BY the viewer, `PLCOutput…` → read by it. */
function direction(type: string): 'input' | 'output' | null {
  if (type.startsWith('PLCInput')) return 'input';
  if (type.startsWith('PLCOutput')) return 'output';
  return null;
}

/** Value kind of an rv wire type; `null` for a type neither side recognises. */
function valueKind(type: string): 'Bool' | 'Int' | 'Float' | 'Text' | null {
  if (type.endsWith('Bool')) return 'Bool';
  if (type.endsWith('Float')) return 'Float';
  if (type.endsWith('Int')) return 'Int';
  if (type.endsWith('Text') || type.endsWith('String')) return 'Text';
  return null;
}

/**
 * Source data type (`DINT`, `LREAL`, `Word`, `WSTRING`) → value kind.
 *
 * Deliberately NOT `dataTypeForKind` (SOL #12): that function INVENTS the Siemens type an Apply
 * should write from an address' size letter, which is the opposite direction and says nothing
 * about whether two declared types agree.
 */
const DATA_TYPE_KIND = new Map<string, 'Bool' | 'Int' | 'Float' | 'Text'>();
// IEC names, the OPC UA built-in names a CODESYS / OPC UA browse reports (`Boolean`, `SByte`,
// `Int16`, `Double`, ...) and the CONNECT value kinds themselves (`Bool`, `Int`, `Float`, `Text`).
for (const t of ['BOOL', 'BIT', 'X', 'BOOLEAN']) DATA_TYPE_KIND.set(t, 'Bool');
for (const t of [
  'INT', 'DINT', 'UDINT', 'UINT', 'SINT', 'USINT', 'LINT', 'ULINT',
  'BYTE', 'SBYTE', 'WORD', 'DWORD', 'LWORD', 'SHORT', 'USHORT', 'LONG', 'ULONG',
  'INT8', 'INT16', 'INT32', 'INT64', 'UINT8', 'UINT16', 'UINT32', 'UINT64', 'INTEGER',
]) DATA_TYPE_KIND.set(t, 'Int');
for (const t of ['REAL', 'LREAL', 'FLOAT', 'DOUBLE', 'SINGLE']) DATA_TYPE_KIND.set(t, 'Float');
for (const t of ['STRING', 'WSTRING', 'CHAR', 'WCHAR', 'TEXT']) DATA_TYPE_KIND.set(t, 'Text');

/**
 * Resolved kinds per RAW spelling (`'DINT'`, `'dint'`, `' Int '`), so the normalisation runs once
 * per distinct spelling instead of once per signal place. A tag table uses a handful of type
 * names; the cap only guards against a pathological free-text DataType column.
 */
const _rawKindCache = new Map<string, 'Bool' | 'Int' | 'Float' | 'Text' | null>();
const RAW_KIND_CACHE_CAP = 512;

/** Value kind a declared data type implies, or `null` when this file does not know the name. */
export function dataTypeKind(dataType: string | undefined | null): 'Bool' | 'Int' | 'Float' | 'Text' | null {
  if (typeof dataType !== 'string' || dataType === '') return null;
  const cached = _rawKindCache.get(dataType);
  if (cached !== undefined) return cached;
  const key = dataType.trim().toUpperCase();
  const kind = key ? DATA_TYPE_KIND.get(key) ?? null : null;
  if (_rawKindCache.size >= RAW_KIND_CACHE_CAP) _rawKindCache.clear();
  _rawKindCache.set(dataType, kind);
  return kind;
}

/**
 * Do a model signal and an interface place agree about what they carry?
 *
 *   `ok`       — direction, value kind and (both stated) data type agree
 *   `mismatch` — a stated difference: direction, value kind, or two data types of different kinds
 *   `unknown`  — something was not stated; a missing type is never a mismatch (plan-589 §2.3)
 *
 * The data type is compared only when BOTH sides carry one, and only through the equivalence table
 * above: a model `DINT` against a CONNECT `Int` is the normal, correct case and must not warn.
 */
export function signalTypeCompat(
  model: { type: string; originDataType?: string | undefined },
  plc: { type: string; dataType?: string | undefined },
  _schema?: ConnectSignalSchema | null,
): 'ok' | 'mismatch' | 'unknown' {
  return compatOf(model.type, model.originDataType, plc.type, plc.dataType);
}

/**
 * {@link signalTypeCompat} on bare strings — what the reconcile loop calls.
 *
 * Same rule, no argument objects: the loop runs once per interface place (100 000 in the §1
 * budget case), and two throw-away wrappers per place were measurable.
 */
function compatOf(
  modelType: string, modelDataType: string | undefined,
  plcType: string, plcDataType: string | undefined,
): 'ok' | 'mismatch' | 'unknown' {
  const modelDir = direction(modelType ?? '');
  const plcDir = direction(plcType ?? '');
  if (modelDir === null || plcDir === null) return 'unknown';
  if (modelDir !== plcDir) return 'mismatch';

  const modelKind = valueKind(modelType);
  const plcKind = valueKind(plcType);
  if (modelKind === null || plcKind === null) return 'unknown';
  if (modelKind !== plcKind) return 'mismatch';

  const modelData = dataTypeKind(modelDataType);
  const plcData = dataTypeKind(plcDataType);
  // "Only when both sides carry an origin type": anything unstated or unknown leaves the verdict
  // at `unknown` — the report must not turn its own ignorance into a warning.
  if (modelData === null || plcData === null) return 'unknown';
  return modelData === plcData ? 'ok' : 'mismatch';
}

/** rv wire types a model signal can actually be registered as (`SIGNAL_TYPES`). */
const MODEL_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  'PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt',
]);

/**
 * The model signal type a CONNECT place of type `slotType` would need, or `null` when the model
 * cannot hold it (Text/String — `SIGNAL_TYPES`, `rv-signal-construction.ts:76`). A `null` is what
 * turns a `plc-only` row into {@link UNSUPPORTED_TYPE_HINT} instead of a creatable signal.
 */
export function modelSignalTypeFor(slotType: string | undefined | null): string | null {
  if (typeof slotType !== 'string') return null;
  const t = slotType.trim();
  return MODEL_SIGNAL_TYPES.has(t) ? t : null;
}

// ── Reconcile ──────────────────────────────────────────────────────────

function emptyCounts(): Record<ReconcileCategory, number> {
  const counts = {} as Record<ReconcileCategory, number>;
  for (const c of RECONCILE_CATEGORIES) counts[c] = 0;
  return counts;
}

/**
 * Lookup tables over one model signal list: exact runtime name, and quoting variant.
 *
 * Both map to the POSITION in the model array, not to the signal object: the position doubles as
 * the key of the "claimed" bitmap below, which keeps the inner loop free of a second string hash
 * per place.
 */
interface ModelIndex {
  byName: Map<string, number>;
  byVariant: Map<string, number>;
  length: number;
}

/**
 * The index, memoised per model ARRAY.
 *
 * The panel reconciles the same `collectModelPlcSignals()` result against every interface, so
 * without this the 20 000-signal index would be rebuilt five times for one report run — which is
 * where the §1 budget was actually spent. Keyed on the array identity and held weakly: a model
 * that was swapped out is collectable, and a mutated array would need a new array anyway (the
 * collector always returns a fresh one).
 */
const _modelIndexCache = new WeakMap<object, ModelIndex>();

/**
 * Is there no address here at all? `undefined`, `''` and whitespace-only all count — an OPC-UA
 * place with a blank NodeId is unbound, not bound to a space. Tested rather than trimmed so the
 * check allocates nothing in the 100 000-place case.
 */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value === '' || !/\S/.test(value);
}

/** Does `name` even have a quoting variant? Cheap pre-test for the regex in `normaliseTagName`. */
function mayBeQuoted(name: string): boolean {
  return name.includes('"') || name !== name.trim();
}

function modelIndexOf(model: readonly ModelPlcSignal[]): ModelIndex {
  const cached = _modelIndexCache.get(model as unknown as object);
  if (cached) return cached;
  const byName = new Map<string, number>();
  const byVariant = new Map<string, number>();
  for (let i = 0; i < model.length; i++) {
    const sig = model[i];
    if (!sig?.name) continue;
    if (!byName.has(sig.name)) byName.set(sig.name, i);
    if (!mayBeQuoted(sig.name)) continue;
    const variant = normaliseTagName(sig.name);
    if (variant !== sig.name && !byVariant.has(variant)) byVariant.set(variant, i);
  }
  const index: ModelIndex = { byName, byVariant, length: model.length };
  _modelIndexCache.set(model as unknown as object, index);
  return index;
}

/**
 * Reconcile the loaded model's PLC signals with every signal place of ONE interface.
 *
 * Each place yields exactly one row; each model signal no place claimed (exactly or as a quoting
 * variant) yields one `missing-in-plc` row. Order is stable: places in config order (flat container
 * first, then topic by topic), then the unclaimed model signals in model order.
 *
 * Cost is O(model + places): the model index is built once per model array (memoised, see
 * {@link modelIndexOf}) and every place is a map lookup — 20 000 signals × 5 interfaces stays
 * inside the 50 ms budget (plan-589 §1). No nested scan exists anywhere in here.
 *
 * Precedence inside one place: a stated TYPE conflict wins over a missing address, because a
 * wrongly typed coupling stays broken after the address is filled in.
 */
export function reconcileSignals(
  model: readonly ModelPlcSignal[],
  iface: ConnectInterface,
  schema?: ConnectSignalSchema | null,
): ReconcileReport {
  const { byName, byVariant, length } = modelIndexOf(model);

  const entries: ReconcileEntry[] = [];
  /** 1 = some place of THIS interface claimed the model signal at that position. */
  const claimed = new Uint8Array(length);
  // A schema without any stated rule can never make an address mandatory, so the per-place rule
  // lookup is skipped entirely — the "older gateway" case costs nothing.
  const hasAddressRule = !!schema?.addressRule;

  for (const slot of collectInterfaceSlots(iface)) {
    const exactAt = byName.get(slot.name);
    if (exactAt !== undefined) {
      const exact = model[exactAt];
      claimed[exactAt] = 1;
      const compat = compatOf(exact.type, exact.originDataType, slot.type, slot.dataType);
      const category: ReconcileCategory = compat === 'mismatch'
        ? 'type-mismatch'
        : hasAddressRule && isBlank(slot.protocolAddress)
          && addressRuleFor(slot, schema) === 'required'
          ? 'no-address'
          : 'mapped';
      const entry: ReconcileEntry = { category, name: slot.name, slot, modelType: exact.type };
      if (exact.originDataType) entry.modelDataType = exact.originDataType;
      if (exact.path) entry.path = exact.path;
      entries.push(entry);
      continue;
    }

    const variantKey = mayBeQuoted(slot.name) ? normaliseTagName(slot.name) : slot.name;
    const variantAt = byName.get(variantKey) ?? byVariant.get(variantKey);
    if (variantAt !== undefined) {
      const variant = model[variantAt];
      claimed[variantAt] = 1;
      entries.push({
        category: 'name-variant',
        name: slot.name,
        slot,
        modelType: variant.type,
        ...(variant.originDataType ? { modelDataType: variant.originDataType } : {}),
        suggestion: variant.name,
        ...(variant.path ? { path: variant.path } : {}),
      });
      continue;
    }

    const creatable = modelSignalTypeFor(slot.type);
    entries.push({
      category: 'plc-only',
      name: slot.name,
      slot,
      ...(creatable === null ? { suggestion: UNSUPPORTED_TYPE_HINT } : {}),
    });
  }

  // Walking the index, not the array: its values are the FIRST position of each distinct name in
  // model order, so a name declared twice (one signal to the store) is reported once.
  for (const at of byName.values()) {
    if (claimed[at] === 1) continue;
    const sig = model[at];
    entries.push({
      category: 'missing-in-plc',
      name: sig.name,
      modelType: sig.type,
      ...(sig.originDataType ? { modelDataType: sig.originDataType } : {}),
      ...(sig.path ? { path: sig.path } : {}),
    });
  }

  const counts = emptyCounts();
  for (const e of entries) counts[e.category]++;

  return { interfaceId: iface.id, interfaceType: String(iface.type ?? ''), counts, entries };
}

/** Total of all rows — the denominator of the `mapped / total` badge. */
export function reconcileTotal(report: ReconcileReport): number {
  return report.entries.length;
}

/** The `plc-only` rows a "Create model signals" run would actually create. */
export function creatablePlcOnly(report: ReconcileReport): ReconcileEntry[] {
  return report.entries.filter(
    (e) => e.category === 'plc-only' && e.suggestion !== UNSUPPORTED_TYPE_HINT,
  );
}
