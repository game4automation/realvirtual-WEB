// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-schema-info — what an author (human or agent) needs to know
 * about a component type, assembled from the two places that already hold it
 * (plan-517):
 *
 *  - FIELDS come from `schema/v1/rv-odt.json` (normative, already bundled) via
 *    {@link getRawOdtDef}; types without a `$def` (inline schemas such as
 *    NodeKnowledge, library behaviours) are enumerated from their registered
 *    runtime schema instead.
 *  - RULES come from the `**Authoring rules:**` / `**Reference implementation
 *    notes (informative):**` blocks in `schema/v1/specification.md`, parsed by
 *    {@link parseSpecRules}. The spec text is ~180 kB and is NOT imported here —
 *    the caller loads it lazily and passes it in, so this module stays cheap
 *    enough for the inspector to import {@link isDriveExtension} from it.
 *
 * Pure functions over the registry; no side-effect imports. Which types exist
 * is whatever is registered at call time (the scene loader registers the
 * built-in components; private types appear only when their modules loaded).
 */

import {
  getCapabilities,
  getDisplayName,
  getOdtIndexGroup,
  getRawOdtDef,
  getRegisteredSchema,
  getTypesWithCapability,
  type FieldDescriptor,
  type OdtProperty,
} from './rv-component-registry';

// ─── Types ───────────────────────────────────────────────────────

/** One entry of the component-type list. */
export interface ComponentTypeSummary {
  type: string;
  displayName: string;
  category: string;
  description: string;
  /** True for drive behaviours: a `Drive` must exist on the SAME node. */
  requiresDriveOnSameNode: boolean;
  /** True = `web_editor_add_component` accepts the type. */
  authorable: boolean;
  /** Only when `authorable` is false: the tool that creates this type instead. */
  createVia?: string;
}

/** One field of a component type. */
export interface ComponentFieldInfo {
  name: string;
  type: string;
  default?: unknown;
  unit?: string;
  description: string;
  enum?: string[];
  readonly?: boolean;
  scope?: string;
  deprecated?: boolean;
  signal?: string;
  signalUnit?: string;
  unityCoords?: boolean;
  refType?: string;
}

/** Full description of one component type. */
export interface ComponentSchemaInfo extends ComponentTypeSummary {
  fields: ComponentFieldInfo[];
  /** Normative authoring rules from the spec. */
  rules: string[];
  /** Informative notes about the reference implementation (realvirtual WEB). */
  notes: string[];
}

/** Rules and notes of one spec section. */
export interface SpecRuleBlock {
  rules: string[];
  notes: string[];
}

// ─── Gate shared with the inspector ─────────────────────────────

/**
 * Component types that only make sense next to a `Drive` on the SAME node —
 * drive behaviours (`Drive_*`) and drive add-ons. ONE function for the
 * inspector's "Add Component" gate and the `requiresDriveOnSameNode` flag of
 * `web_component_schema`, so the gate and what agents are told cannot drift.
 */
export function isDriveExtension(type: string): boolean {
  return type.startsWith('Drive_') || type === 'DrivePulseEncoder';
}

// ─── Special (non-authorable) types ─────────────────────────────

/**
 * Types that are part of every model but are NOT created with
 * `web_editor_add_component` (the command refuses them): the tool that creates
 * them instead. Listed with `authorable: false` so an agent never tries.
 */
export const NON_AUTHORABLE_CREATE_VIA: Readonly<Record<string, string>> = Object.freeze({
  Kinematic: 'web_editor_kinematize',
});

// ─── List ────────────────────────────────────────────────────────

function descriptionOf(type: string): string {
  return getRawOdtDef(type)?.description ?? '';
}

function categoryOf(type: string): string {
  return getCapabilities(type).ui.filter ?? getOdtIndexGroup(type) ?? 'other';
}

function summaryOf(type: string): ComponentTypeSummary {
  const authorable = getCapabilities(type).authorable;
  const createVia = authorable ? undefined : NON_AUTHORABLE_CREATE_VIA[type];
  return {
    type,
    displayName: getDisplayName(type),
    category: categoryOf(type),
    description: descriptionOf(type),
    requiresDriveOnSameNode: isDriveExtension(type),
    authorable,
    ...(createVia ? { createVia } : {}),
  };
}

/**
 * Every authorable component type plus the explicitly supported special types
 * (Kinematic), sorted by type name. Private types appear only when registered.
 */
export function listComponentTypes(): ComponentTypeSummary[] {
  const types = new Set(getTypesWithCapability('authorable'));
  for (const special of Object.keys(NON_AUTHORABLE_CREATE_VIA)) types.add(special);
  return [...types].sort((a, b) => a.localeCompare(b)).map(summaryOf);
}

// ─── Detail ──────────────────────────────────────────────────────

const COMPONENT_REF = '#/$defs/ComponentReference';

function odtTypeName(p: OdtProperty): string {
  if (p.$ref === COMPONENT_REF) return 'ComponentReference';
  if (p.$ref) return p.$ref.replace('#/$defs/', '');
  if (p.type === 'array') {
    if (p.items?.$ref === COMPONENT_REF) return 'ComponentReference[]';
    if (p.items?.$ref) return `${p.items.$ref.replace('#/$defs/', '')}[]`;
    if (p.items?.type) return `${p.items.type}[]`;
    return 'array';
  }
  if (Array.isArray(p.enum)) return 'enum';
  return p.type ?? 'unknown';
}

function fieldFromOdt(name: string, p: OdtProperty): ComponentFieldInfo {
  const f: ComponentFieldInfo = { name, type: odtTypeName(p), description: p.description ?? '' };
  if (p.default !== undefined) f.default = p.default;
  if (typeof p.unit === 'string' && p.unit) f.unit = p.unit;
  // The RAW `enum` (canonical wire values), never `enumMap` — that one also
  // carries legacy aliases such as "0".
  if (Array.isArray(p.enum)) f.enum = [...p.enum];
  if (p.readonly === true) f.readonly = true;
  if (typeof p.scope === 'string') f.scope = p.scope;
  if (p.deprecated !== undefined && p.deprecated !== false) f.deprecated = true;
  if (typeof p.signal === 'string') f.signal = p.signal;
  if (typeof p.signalUnit === 'string') f.signalUnit = p.signalUnit;
  if (p.unityCoords === true) f.unityCoords = true;
  if (typeof p.refType === 'string') f.refType = p.refType;
  return f;
}

const INLINE_TYPE_NAMES: Readonly<Record<FieldDescriptor['type'], string>> = {
  number: 'number',
  boolean: 'boolean',
  string: 'string',
  vector3: 'Vector3',
  componentRef: 'ComponentReference',
  componentRefArray: 'ComponentReference[]',
  enum: 'enum',
  json: 'json',
};

function fieldFromInline(name: string, d: FieldDescriptor): ComponentFieldInfo {
  const f: ComponentFieldInfo = { name, type: INLINE_TYPE_NAMES[d.type] ?? d.type, description: '' };
  if (d.default !== undefined) f.default = d.default;
  if (d.unit) f.unit = d.unit;
  if (d.type === 'enum' && d.enumMap) f.enum = Object.keys(d.enumMap);
  if (d.readonly === true) f.readonly = true;
  if (d.scope) f.scope = d.scope;
  if (d.deprecated === true) f.deprecated = true;
  if (d.signal) f.signal = d.signal;
  if (d.signalUnit) f.signalUnit = d.signalUnit;
  if (d.unityCoords === true) f.unityCoords = true;
  return f;
}

/** True when `describeComponentType` can describe the type. */
export function isDescribableType(type: string): boolean {
  return !!getRawOdtDef(type) || !!getRegisteredSchema(type) || type in NON_AUTHORABLE_CREATE_VIA;
}

/**
 * Full description of one type: fields (rv-odt `$def`, else the registered
 * inline schema — every field, including those without a default and
 * `scope:'none'` ones) plus the spec's rules and notes. `specText` is the
 * lazily loaded specification.md; `null` → no rules/notes. Returns null for a
 * type that is neither spec'd nor registered.
 */
export function describeComponentType(type: string, specText: string | null): ComponentSchemaInfo | null {
  if (!isDescribableType(type)) return null;
  const def = getRawOdtDef(type);
  let fields: ComponentFieldInfo[];
  if (def) {
    fields = Object.entries(def.properties ?? {}).map(([name, p]) => fieldFromOdt(name, p));
  } else {
    fields = Object.entries(getRegisteredSchema(type) ?? {}).map(([name, d]) => fieldFromInline(name, d));
  }
  const block = specText ? parseSpecRules(specText).get(type) : undefined;
  return {
    ...summaryOf(type),
    fields,
    rules: block ? [...block.rules] : [],
    notes: block ? [...block.notes] : [],
  };
}

// ─── Spec rule parser ────────────────────────────────────────────

/** Marker line of the normative block. */
export const RULES_MARKER = '**Authoring rules:**';
/** Marker line of the informative block. */
export const NOTES_MARKER = '**Reference implementation notes (informative):**';

const HEADING_RE = /^#### 7[a-g]\.\d+ (\S+)\s*$/;

let _cache: { text: string; map: Map<string, SpecRuleBlock> } | null = null;

/**
 * Parse every Section-7 subsection (`#### 7x.N <Type>`) for its rule and note
 * blocks. A block is its marker line followed by `- ` bullets; an indented line
 * continues the previous bullet; any other line ends the block. Types without
 * blocks are absent from the map. Cached per text.
 */
export function parseSpecRules(specText: string): Map<string, SpecRuleBlock> {
  if (_cache && _cache.text === specText) return _cache.map;
  const map = new Map<string, SpecRuleBlock>();
  let type: string | null = null;
  let target: string[] | null = null;
  for (const raw of specText.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('#')) {
      const m = HEADING_RE.exec(line);
      type = m ? m[1] : null;
      target = null;
      continue;
    }
    if (!type) continue;
    const t = line.trim();
    if (t === RULES_MARKER || t === NOTES_MARKER) {
      let block = map.get(type);
      if (!block) map.set(type, (block = { rules: [], notes: [] }));
      target = t === RULES_MARKER ? block.rules : block.notes;
      continue;
    }
    if (!target) continue;
    if (line.startsWith('- ')) {
      target.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && target.length > 0) {
      target[target.length - 1] += ` ${t}`;
    } else {
      target = null;
    }
  }
  _cache = { text: specText, map };
  return map;
}
