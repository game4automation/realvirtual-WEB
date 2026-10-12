// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fmu-model-description — read an FMU's `modelDescription.xml` in the
 * browser (plan-498 F1).
 *
 * **LAZY MODULE.** It pulls in `fflate` and `fast-xml-parser`, which have no
 * business in the load path. Import it ONLY with a dynamic
 * `import('…/rv-fmu-model-description')` from the editor attach action;
 * `tests/bundle-splitting.test.ts` fails when it reaches the entry chunk.
 *
 * Bounded by design: exactly ONE zip entry is decompressed (the model
 * description), and only when its declared size is under
 * {@link MAX_MODEL_DESCRIPTION_BYTES}; the package itself is capped at
 * {@link MAX_FMU_BYTES}. Everything else in the archive is only LISTED (to
 * find the win64 binary), never inflated. CONNECT parses the package again on
 * upload and is authoritative for execution (plan-498 decision log).
 */

import { unzipSync, type UnzipFileInfo, type Unzipped, type UnzipOptions } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

/** Largest `.fmu` the browser accepts for authoring (bytes). */
export const MAX_FMU_BYTES = 256 * 1024 * 1024;
/** Largest `modelDescription.xml` the browser inflates (bytes, uncompressed). */
export const MAX_MODEL_DESCRIPTION_BYTES = 16 * 1024 * 1024;

const MODEL_DESCRIPTION = 'modelDescription.xml';

// ─── Types ──────────────────────────────────────────────────────────────

/** FMI 2.0 variable type as authored. */
export type FmuVariableType = 'Real' | 'Integer' | 'Boolean' | 'String' | 'Enumeration';
/** The causalities an `Fmu` component keeps (others — `independent`, `local` — are dropped). */
export type FmuCausality = 'input' | 'output' | 'parameter' | 'calculatedParameter';

/** One `FmuVariables[]` record (plan-498 §2.3). */
export interface FmuVariable {
  name: string;
  valueReference: number;
  causality: FmuCausality;
  variability: string;
  type: FmuVariableType;
  start?: string;
  unit?: string;
  description?: string;
  /** FMI 2.0 `initial` attribute as authored (plan-502 F5). */
  initial?: 'exact' | 'approx' | 'calculated';
  /** `min` of the type element or its declared SimpleType (numeric types only). */
  min?: number;
  /** `max` of the type element or its declared SimpleType (numeric types only). */
  max?: number;
  /** `declaredType` — the name of the `TypeDefinitions/SimpleType`. */
  declaredType?: string;
  /** Enumeration items of the declared SimpleType (Enumeration variables only). */
  enumItems?: FmuEnumItem[];
}

/** One `<Item>` of an FMI 2.0 enumeration SimpleType. */
export interface FmuEnumItem {
  name: string;
  value: number;
  description?: string;
}

/** What {@link readModelDescription} returns. */
export interface FmuModelDescription {
  modelName: string;
  guid: string;
  fmiVersion: string;
  generationTool?: string;
  generationDateAndTime?: string;
  description?: string;
  /** `<CoSimulation modelIdentifier>` — the binary's base name. */
  modelIdentifier: string;
  coSimulation: boolean;
  /** `binaries/win64/<modelIdentifier>.dll` is in the zip directory. */
  hasWin64Binary: boolean;
  variables: FmuVariable[];
  /**
   * plan-512 F11 — `<UnitDefinitions>`: unit name → its FMI `BaseUnit` (only
   * the exponents that are non-zero, `factor`/`offset` only when not 1/0).
   * Absent when the package defines no units.
   */
  units?: Record<string, FmuBaseUnit>;
}

/** One FMI 2.0 `BaseUnit` (plan-512): SI exponents plus factor/offset. */
export interface FmuBaseUnit {
  kg?: number; m?: number; s?: number; A?: number; K?: number; mol?: number; cd?: number; rad?: number;
  factor?: number;
  offset?: number;
}

/** Why a package was refused. */
export type FmuParseErrorCode =
  | 'too-large'
  | 'not-a-zip'
  | 'no-model-description'
  | 'model-description-too-large'
  | 'xml'
  | 'fmi-version'
  | 'no-cosimulation';

export class FmuParseError extends Error {
  constructor(readonly code: FmuParseErrorCode, message: string) {
    super(message);
    this.name = 'FmuParseError';
  }
}

/** Injection seam for tests (the zip reader). */
export interface ReadModelDescriptionOptions {
  unzip?: (data: Uint8Array, opts: UnzipOptions) => Unzipped;
}

// ─── Parsing ────────────────────────────────────────────────────────────

const KEPT_CAUSALITIES: ReadonlySet<string> = new Set(['input', 'output', 'parameter', 'calculatedParameter']);
const TYPE_KEYS: readonly FmuVariableType[] = ['Real', 'Integer', 'Boolean', 'String', 'Enumeration'];

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** One `TypeDefinitions/SimpleType`, reduced to what the inspector needs. */
interface SimpleTypeInfo {
  unit?: string;
  min?: number;
  max?: number;
  items?: FmuEnumItem[];
}

const BASE_UNIT_KEYS = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd', 'rad'] as const;

/** `UnitDefinitions/Unit` by name (plan-512 F11). Never throws; a unit without `BaseUnit` is dropped. */
function readUnitDefinitions(defs: unknown): Record<string, FmuBaseUnit> {
  const out: Record<string, FmuBaseUnit> = {};
  if (!defs || typeof defs !== 'object') return out;
  const list = (defs as Record<string, unknown>).Unit;
  if (!Array.isArray(list)) return out;
  for (const raw of list as Array<Record<string, unknown>>) {
    const name = str(raw?.name);
    const base = raw?.BaseUnit;
    if (!name || !base || typeof base !== 'object') continue;
    const attrs = base as Record<string, unknown>;
    const unit: FmuBaseUnit = {};
    for (const k of BASE_UNIT_KEYS) {
      const v = num(attrs[k]);
      if (v !== undefined && v !== 0) unit[k] = v;
    }
    const factor = num(attrs.factor);
    if (factor !== undefined && factor !== 1) unit.factor = factor;
    const offset = num(attrs.offset);
    if (offset !== undefined && offset !== 0) unit.offset = offset;
    out[name] = unit;
  }
  return out;
}

/** `TypeDefinitions/SimpleType` by name (plan-502 F5). Never throws. */
function readSimpleTypes(defs: unknown): Map<string, SimpleTypeInfo> {
  const out = new Map<string, SimpleTypeInfo>();
  if (!defs || typeof defs !== 'object') return out;
  const list = (defs as Record<string, unknown>).SimpleType;
  if (!Array.isArray(list)) return out;
  for (const raw of list as Array<Record<string, unknown>>) {
    const name = str(raw?.name);
    if (!name) continue;
    const typeKey = TYPE_KEYS.find((t) => t in raw);
    if (!typeKey) continue;
    const el = raw[typeKey];
    const attrs = (el && typeof el === 'object' ? el : {}) as Record<string, unknown>;
    const info: SimpleTypeInfo = {};
    const unit = str(attrs.unit);
    if (unit !== undefined) info.unit = unit;
    const min = num(attrs.min);
    if (min !== undefined) info.min = min;
    const max = num(attrs.max);
    if (max !== undefined) info.max = max;
    if (typeKey === 'Enumeration' && Array.isArray(attrs.Item)) {
      const items: FmuEnumItem[] = [];
      for (const it of attrs.Item as Array<Record<string, unknown>>) {
        const itemName = str(it?.name);
        const value = num(it?.value);
        if (!itemName || value === undefined || !Number.isInteger(value)) continue;
        const item: FmuEnumItem = { name: itemName, value };
        const d = str(it.description);
        if (d !== undefined) item.description = d;
        items.push(item);
      }
      info.items = items;
    }
    out.set(name, info);
  }
  return out;
}

/**
 * Read and validate the model description of an FMU package.
 *
 * Throws {@link FmuParseError} for anything that cannot be attached: over the
 * size limits, not a zip, no `modelDescription.xml`, broken XML, an FMI version
 * other than 2.0, or no `<CoSimulation>` element. The win64 binary is REPORTED
 * (`hasWin64Binary`), not enforced — the attach action decides.
 */
export async function readModelDescription(
  file: ArrayBuffer | Uint8Array,
  opts: ReadModelDescriptionOptions = {},
): Promise<FmuModelDescription> {
  const data = file instanceof Uint8Array ? file : new Uint8Array(file);
  if (data.byteLength > MAX_FMU_BYTES) {
    throw new FmuParseError('too-large', `FMU is ${data.byteLength} bytes — the browser limit is ${MAX_FMU_BYTES}`);
  }

  const entryNames: string[] = [];
  let descriptionTooLarge = false;
  const unzip = opts.unzip ?? unzipSync;
  let unzipped: Unzipped;
  try {
    unzipped = unzip(data, {
      // Called once per entry with its CENTRAL-DIRECTORY info; only the model
      // description is ever inflated, and only when it is small enough.
      filter: (info: UnzipFileInfo) => {
        entryNames.push(info.name);
        if (info.name !== MODEL_DESCRIPTION) return false;
        if (info.originalSize > MAX_MODEL_DESCRIPTION_BYTES) {
          descriptionTooLarge = true;
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    // The literal 'Not a readable FMU (zip) archive' is the lazy-chunk marker of
    // `tests/bundle-splitting.test.ts` — keep it unique in src/.
    throw new FmuParseError('not-a-zip', `Not a readable FMU (zip) archive: ${(e as Error).message}`);
  }
  if (descriptionTooLarge) {
    throw new FmuParseError('model-description-too-large', `${MODEL_DESCRIPTION} exceeds ${MAX_MODEL_DESCRIPTION_BYTES} bytes`);
  }
  const xmlBytes = unzipped[MODEL_DESCRIPTION];
  if (!xmlBytes) throw new FmuParseError('no-model-description', `The archive has no ${MODEL_DESCRIPTION}`);

  let doc: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: true,
      isArray: (name) => name === 'ScalarVariable' || name === 'SimpleType' || name === 'Item' || name === 'Unit',
    });
    doc = parser.parse(new TextDecoder().decode(xmlBytes)) as Record<string, unknown>;
  } catch (e) {
    throw new FmuParseError('xml', `${MODEL_DESCRIPTION} is not valid XML: ${(e as Error).message}`);
  }

  const root = doc.fmiModelDescription as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') {
    throw new FmuParseError('xml', `${MODEL_DESCRIPTION} has no <fmiModelDescription> root`);
  }
  const fmiVersion = str(root.fmiVersion) ?? '';
  if (fmiVersion !== '2.0') {
    throw new FmuParseError('fmi-version', `FMI ${fmiVersion || '(unknown)'} is not supported — only FMI 2.0 Co-Simulation`);
  }
  const cs = root.CoSimulation as Record<string, unknown> | string | undefined;
  if (cs === undefined) {
    throw new FmuParseError('no-cosimulation', 'The FMU has no <CoSimulation> interface (Model Exchange only)');
  }
  const modelIdentifier = typeof cs === 'object' ? str(cs.modelIdentifier) ?? '' : '';

  const simpleTypes = readSimpleTypes(root.TypeDefinitions);

  const mv = root.ModelVariables as Record<string, unknown> | string | undefined;
  const scalars = (typeof mv === 'object' && Array.isArray(mv?.ScalarVariable) ? mv.ScalarVariable : []) as Array<Record<string, unknown>>;
  const variables: FmuVariable[] = [];
  for (const sv of scalars) {
    const causality = str(sv.causality) ?? 'local';
    if (!KEPT_CAUSALITIES.has(causality)) continue;
    const type = TYPE_KEYS.find((t) => t in sv);
    if (!type) continue;
    const typeEl = sv[type];
    const typeAttrs = (typeEl && typeof typeEl === 'object' ? typeEl : {}) as Record<string, unknown>;
    const v: FmuVariable = {
      name: str(sv.name) ?? '',
      valueReference: Number(sv.valueReference ?? -1),
      causality: causality as FmuCausality,
      // FMI 2.0 default variability is `continuous`.
      variability: str(sv.variability) ?? 'continuous',
      type,
    };
    const start = str(typeAttrs.start);
    if (start !== undefined) v.start = start;
    const unit = str(typeAttrs.unit);
    if (unit !== undefined) v.unit = unit;
    const description = str(sv.description);
    if (description !== undefined) v.description = description;
    const initial = str(sv.initial);
    if (initial === 'exact' || initial === 'approx' || initial === 'calculated') v.initial = initial;
    const declaredType = str(typeAttrs.declaredType);
    const simple = declaredType !== undefined ? simpleTypes.get(declaredType) : undefined;
    if (declaredType !== undefined) v.declaredType = declaredType;
    // The declared SimpleType supplies unit/min/max unless the variable overrides them.
    if (v.unit === undefined && simple?.unit !== undefined) v.unit = simple.unit;
    if (type === 'Real' || type === 'Integer' || type === 'Enumeration') {
      const min = num(typeAttrs.min) ?? simple?.min;
      const max = num(typeAttrs.max) ?? simple?.max;
      if (min !== undefined) v.min = min;
      if (max !== undefined) v.max = max;
    }
    if (type === 'Enumeration' && simple?.items && simple.items.length > 0) {
      v.enumItems = simple.items.map((it) => ({ ...it }));
    }
    if (v.name && Number.isInteger(v.valueReference) && v.valueReference >= 0) variables.push(v);
  }

  const out: FmuModelDescription = {
    modelName: str(root.modelName) ?? '',
    guid: str(root.guid) ?? '',
    fmiVersion,
    modelIdentifier,
    coSimulation: true,
    hasWin64Binary: modelIdentifier !== '' && entryNames.includes(`binaries/win64/${modelIdentifier}.dll`),
    variables,
  };
  const generationTool = str(root.generationTool);
  if (generationTool !== undefined) out.generationTool = generationTool;
  const generationDateAndTime = str(root.generationDateAndTime);
  if (generationDateAndTime !== undefined) out.generationDateAndTime = generationDateAndTime;
  const description = str(root.description);
  if (description !== undefined) out.description = description;
  const units = readUnitDefinitions(root.UnitDefinitions);
  if (Object.keys(units).length > 0) out.units = units;
  return out;
}

/** SHA-256 of a package (hex, lowercase). */
export async function sha256OfPackage(file: ArrayBuffer | Uint8Array): Promise<string> {
  const data = file instanceof Uint8Array ? file : new Uint8Array(file);
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
