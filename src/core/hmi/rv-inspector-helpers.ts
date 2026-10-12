// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-inspector-helpers.ts — Pure helper functions and constants shared by the
 * Property Inspector and Hierarchy Browser.
 *
 * Extracted from rv-property-inspector.tsx to break circular imports and
 * consolidate duplicated badge color maps / type helpers.
 */

import { getConsumedFields, getIgnoredFields, isKnownComponentType } from '../engine/rv-extras-validator';
import { getCapabilities, DEFAULT_BADGE_COLOR, getFieldDescriptor } from '../engine/rv-component-registry';
import { COLLISION_ROLES } from '../engine/rv-collision-role';
import { DriveDirection, isRotation } from '../engine/rv-coordinate-utils';
import { NODE_KNOWLEDGE_PROVENANCE_FIELDS, NODE_KNOWLEDGE_TYPE } from '../engine/rv-node-knowledge';
import type { FieldDescriptor } from '../engine/rv-component-registry';
import type { SignalStore } from '../engine/rv-signal-store';
import { readSignalValue, formatValue } from './rv-value-resolver';
import { formatDecimal } from './rv-number-format';
import { FMU_STATE_COLORS, FMU_TYPE, type FmuState } from '../engine/rv-fmu-constants';
import {
  SIGNAL_VALUE_NEUTRAL,
  signalDirectionFromType,
  signalValueColor,
  signalValueColorForValue,
} from './signal-colors';
import type { SvgIconComponent } from '@mui/icons-material';
import {
  Settings,
  RadioButtonChecked,
  ViewStream,
  PlayArrow,
  Stop,
  PanTool,
  Sensors,
  Widgets,
} from '@mui/icons-material';

// ── Hidden component types (not shown in inspector or hierarchy) ──────────

/**
 * Returns true if a component type should be hidden in the inspector.
 * Uses the capabilities registry (`ui.hidden`) as the primary check.
 * Falls back to the validator for types without capabilities.
 */
export function isHiddenComponentType(type: string): boolean {
  // If the type has explicit capabilities, use ui.hidden
  const caps = getCapabilities(type);
  if (caps.ui.hidden) return true;
  // Fall back to unknown-component check
  return !isKnownComponentType(type);
}

/**
 * Extract the component type keys from a `userData.realvirtual` object.
 *
 * Component types are object-valued keys (non-null, non-array). Scalar values
 * like the `name` marker are skipped. Hidden types (`_highlightOverlay` etc.)
 * are dropped by default; pass `{ filterHidden: false }` for raw extraction.
 */
export function extractComponentTypes(
  rv: unknown,
  options?: { filterHidden?: boolean },
): string[] {
  if (!rv || typeof rv !== 'object' || Array.isArray(rv)) return [];
  const filterHidden = options?.filterHidden ?? true;
  const types: string[] = [];
  for (const [key, value] of Object.entries(rv as Record<string, unknown>)) {
    if (filterHidden && isHiddenComponentType(key)) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      types.push(key);
    }
  }
  return types;
}

// ── Enum options ─────────────────────────────────────────────────────────

const DIRECTION_OPTIONS = [
  'LinearX', 'LinearY', 'LinearZ',
  'RotationX', 'RotationY', 'RotationZ',
  'Virtual',
];

const ACTIVE_OPTIONS = ['Always', 'Connected', 'Disconnected'];

/** plan-394 — the six preset collision roles (English, not localized). */
const COLLISION_ROLE_OPTIONS = [...COLLISION_ROLES];

/** Map of field names to their enum options. Indexed by the BARE field name
 *  across all component types — which is why the collision field is called
 *  `CollisionRole` and not `Role` (a generic `Role` would turn every
 *  same-named field of any other component into this dropdown). */
export const ENUM_FIELDS: Record<string, string[]> = {
  Direction: DIRECTION_OPTIONS,
  TransportDirection: DIRECTION_OPTIONS,
  RayCastDirection: DIRECTION_OPTIONS,
  Active: ACTIVE_OPTIONS,
  CollisionRole: COLLISION_ROLE_OPTIONS,
  CollisionRoleForMUs: COLLISION_ROLE_OPTIONS,
};

// ── Field units ──────────────────────────────────────────────────────────

/**
 * FALLBACK units shown inside numeric inputs (right-aligned, e.g. "mm", "mm/s",
 * "°", "s") for fields whose rv-ODT schema declares no `unit` (plan-512 F10:
 * the schema is the SSOT). Keyed by either the component-qualified field
 * (`"Drive.TargetSpeed"`) or the bare field name (`"TargetSpeed"`). A qualified
 * key wins over a bare key. Add a unit to the SCHEMA first — a row here that
 * has a schema pendant must agree with it (`field-unit-schema-ssot.test.ts`).
 */
export const FIELD_UNITS: Record<string, string> = {
  // Distances / positions (millimetres)
  StartPosition: 'mm',
  TargetPosition: 'mm',
  CurrentPosition: 'mm',
  Offset: 'mm',
  Position: 'mm',
  MinPos: 'mm',
  MaxPos: 'mm',
  LowerLimit: 'mm',
  UpperLimit: 'mm',
  'Source.GenerateIfDistance': 'mm',
  // Speeds (mm/s)
  TargetSpeed: 'mm/s',
  CurrentSpeed: 'mm/s',
  Speed: 'mm/s',
  // Accelerations (mm/s²)
  Acceleration: 'mm/s²',
  // Times (seconds)
  Interval: 's',
  TimeIn: 's',
  TimeOut: 's',
  Delay: 's',
};

/** Display spelling of a schema unit: `mm/s2` → `mm/s²` (the schema writes UCUM-style). */
function displayUnit(unit: string): string {
  return unit.replace(/(\/s)2$/, '$1²').replace(/(\/s)3$/, '$1³');
}

/**
 * Resolve the unit suffix for a numeric field, or undefined if none (plan-512
 * F10). The schema's `unit` keyword is the single source; {@link FIELD_UNITS}
 * answers only for fields the schema leaves without one, preferring a
 * component-qualified entry (`Type.Field`) over a bare `Field` entry.
 */
export function getFieldUnit(
  componentType: string, fieldName: string, data?: Readonly<Record<string, unknown>>,
): string | undefined {
  const base = baseComponentType(componentType);
  const schemaUnit = getFieldDescriptor(base, fieldName)?.unit;
  const unit = schemaUnit ? displayUnit(schemaUnit) : (FIELD_UNITS[`${base}.${fieldName}`] ?? FIELD_UNITS[fieldName]);
  if (unit && base === 'Drive' && isRotaryDirection(data?.['Direction'])) return rotaryUnit(unit);
  return unit;
}

/** True for the three `RotationX/Y/Z` values of `Drive.Direction`. */
function isRotaryDirection(direction: unknown): boolean {
  return typeof direction === 'string' && isRotation(direction as DriveDirection);
}

/**
 * The schema writes Drive units for a LINEAR axis (`mm`, `mm/s`, `mm/s²`,
 * `mm/s³`); a rotary drive stores the same fields in degrees. Swap the length
 * part, keep the time part: `mm/s²` → `°/s²`.
 */
function rotaryUnit(unit: string): string {
  return unit.startsWith('mm') ? `°${unit.slice(2)}` : unit;
}

// ── Hidden fields ────────────────────────────────────────────────────────

/** Fields hidden from the inspector across ALL component types (redundant
 *  with header or always empty). */
export const HIDDEN_FIELD_NAMES = new Set(['Name']);

/** Per-component-type fields hidden from the inspector. These values still
 *  live in userData (and are persisted by the overlay), but the Inspector
 *  doesn't render rows for them — typically because:
 *    • A universal `ObjectHeaderSection` already exposes them (Locked,
 *      Visible), or
 *    • A registered ComponentAction (button) renders the control instead
 *      (Splat.InvertX/Y/Z → Invert X/Y/Z buttons), or
 *    • A registered custom FIELD RENDERER already shows them — the
 *      NodeKnowledge note renderer draws date/author/confidence in its own
 *      header, so a second set of rows would be duplication (plan-431 §2.2).
 *
 *  This is also how a field is made non-editable WITHOUT `readonly: true`: the
 *  schema flag is shared with the overlay write guard, so it would block
 *  programmatic writes too (see the warning in `rv-node-knowledge.ts`). Hiding
 *  the row removes the editor and leaves the write path open. */
export const HIDDEN_FIELDS_PER_TYPE: Record<string, ReadonlySet<string>> = {
  LayoutObject: new Set(['Locked', 'Visible']),
  Splat: new Set(['InvertX', 'InvertY', 'InvertZ']),
  [NODE_KNOWLEDGE_TYPE]: new Set(NODE_KNOWLEDGE_PROVENANCE_FIELDS),
  // plan-498/502: `FmuVariables` is NOT hidden — its field renderer
  // (rv-fmu-parameters-field-renderer.tsx, "Parameters") replaces the
  // raw row; `isFieldHidden` runs BEFORE the renderer lookup, so a hidden field
  // would never reach it. The raw override map is edited only through that
  // section (setFmuStartOverride / clearFmuStartOverride).
  Fmu: new Set(['FmuStartOverrides']),
};

/** True if the given field should be hidden in the inspector, considering
 *  both the global and per-type lists. */
export function isFieldHidden(componentType: string, fieldName: string): boolean {
  if (HIDDEN_FIELD_NAMES.has(fieldName)) return true;
  const perType = HIDDEN_FIELDS_PER_TYPE[componentType];
  return !!perType?.has(fieldName);
}

// ── Deprecated fields ────────────────────────────────────────────────────

/**
 * True when a schema field marked `deprecated: true` should be hidden entirely.
 *
 * A deprecated field drives nothing, so offering an editor for it is a lie —
 * but silently dropping a value a document actually carries is worse, because
 * the user would have no way of seeing WHY the machine ignores what the file
 * says. The rule is therefore: hide it while it is empty (the overwhelmingly
 * common case — the default of a field nobody set), and show it read-only with
 * a "(deprecated)" tag as soon as it holds a value.
 *
 * "Empty" is `undefined`, `null`, `''` and `[]`. A schema default (e.g.
 * `SpeedSource: "Drive"`) counts as a value only when it DIFFERS from the
 * default — a document stamped with the default never set anything.
 */
export function isDeprecatedFieldHidden(desc: FieldDescriptor | undefined, value: unknown): boolean {
  if (desc?.deprecated !== true) return false;
  return !hasDeprecatedValue(desc, value);
}

/** True when a deprecated field carries a value worth showing (see above). */
export function hasDeprecatedValue(desc: FieldDescriptor | undefined, value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (desc?.default !== undefined && value === desc.default) return false;
  return true;
}

// ── Component type suffix stripping ──────────────────────────────────────

/**
 * Strip numeric suffix from component type for validator lookup.
 * E.g. "ReplayRecording_1" -> "ReplayRecording", "Drive" -> "Drive"
 */
export function baseComponentType(type: string): string {
  return type.replace(/_\d+$/, '');
}

// ── Field type inference ──────────────────────────────────────────────────

export type FieldType = 'number' | 'boolean' | 'string' | 'enum' | 'vector3' | 'color' | 'reference' | 'scriptableobject' | 'object';

/** Check if a value is a ComponentReference ({ type: "ComponentReference", path, componentType }). */
export function isComponentRef(value: unknown): value is { type: string; path: string; componentType: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj['type'] === 'ComponentReference' && typeof obj['path'] === 'string';
}

/** Check if a value is a ScriptableObject reference ({ type: "ScriptableObject", ... }). */
export function isScriptableObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)['type'] === 'ScriptableObject';
}

/** A Unity Color `{r, g, b, a?}` with 0..1 floats — how rv_extras store colours (e.g. `Lamp.OnColor`). */
export function isColorValue(value: unknown): value is { r: number; g: number; b: number; a?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const keys = Object.keys(c);
  return typeof c['r'] === 'number' && typeof c['g'] === 'number' && typeof c['b'] === 'number'
    && keys.every((k) => k === 'r' || k === 'g' || k === 'b' || k === 'a')
    && (c['a'] === undefined || typeof c['a'] === 'number');
}

/** `{r,g,b}` (0..1) → `#rrggbb`, the same mapping the runtime uses (`parseColorToHex`). */
export function colorToHex(c: { r: number; g: number; b: number }): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/** `#rrggbb` → `{r,g,b,a}` (0..1, 4 decimals); the alpha of `prev` is kept (default 1). Null for a malformed hex. */
export function hexToColor(hex: string, prev?: { a?: number }): { r: number; g: number; b: number; a: number } | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const f = (s: string) => Math.round((parseInt(s, 16) / 255) * 10000) / 10000;
  return { r: f(m[1]), g: f(m[2]), b: f(m[3]), a: typeof prev?.a === 'number' ? prev.a : 1 };
}

export function inferFieldType(fieldName: string, value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'object';
  if (isComponentRef(value)) return 'reference';
  if (isScriptableObject(value)) return 'scriptableobject';
  if (isColorValue(value)) return 'color';
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'x' in value &&
    'y' in value &&
    'z' in value
  ) return 'vector3';
  if (fieldName in ENUM_FIELDS) return 'enum';
  // Generic objects (structs like ConnectionInfo) — display as read-only
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return 'object';
  return 'string';
}

// ── Field status classification ───────────────────────────────────────────

export type FieldStatus = 'consumed' | 'ignored' | 'unknown';

export function classifyField(componentType: string, fieldName: string): FieldStatus {
  const base = baseComponentType(componentType);
  const consumed = getConsumedFields(base);
  if (consumed.includes(fieldName)) return 'consumed';

  const ignored = getIgnoredFields(base);
  if (ignored.includes('*') || ignored.includes(fieldName)) return 'ignored';

  return 'unknown';
}

// ── Badge color map (shared between hierarchy browser and inspector) ──────

export const BADGE_COLORS: Record<string, string> = {
  Drive: '#4fc3f7',
  TransportSurface: '#ffa726',
  Sensor: '#66bb6a',
  Source: '#ab47bc',
  Sink: '#ef5350',
  MU: '#78909c',
  DrivesRecorder: '#7e57c2',
  ReplayRecording: '#26a69a',
  Metadata: '#ffb74d',
  RuntimeMetadata: '#ffb74d',
};

export function componentColor(type: string): string {
  // Prefix-based fallbacks for dynamic/generated type names
  if (type.startsWith('LogicStep_')) return '#8d6e63';
  if (type.startsWith('PLCInput')) return '#ef5350';
  if (type.startsWith('PLCOutput')) return '#66bb6a';
  if (type.startsWith('Drive_')) return '#29b6f6';
  // Registry has priority, then legacy BADGE_COLORS map
  const caps = getCapabilities(type);
  if (caps.ui.badge !== DEFAULT_BADGE_COLOR) return caps.ui.badge;
  return BADGE_COLORS[type] ?? DEFAULT_BADGE_COLOR;
}

/**
 * MUI icon component for a component type — the visual counterpart to
 * {@link componentColor}. Used as a small leading glyph next to a signal badge
 * to show which component a signal is bound to (plan-234 §3.1b). Returns a
 * component reference (not JSX), so the caller renders it and applies the
 * `componentColor(type)` tint. Unknown types fall back to a generic `Widgets`.
 */
export function componentTypeIcon(type: string): SvgIconComponent {
  const base = baseComponentType(type);
  if (base === 'Drive' || base.startsWith('Drive')) return Settings;
  if (base === 'Sensor') return RadioButtonChecked;
  if (base === 'TransportSurface') return ViewStream;
  if (base === 'Source') return PlayArrow;
  if (base === 'Sink') return Stop;
  if (base === 'Gripper') return PanTool;
  if (base === 'WebSensor') return Sensors;
  return Widgets;
}

// ── Format display value for read-only fields ─────────────────────────────

export function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '\u2014';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Read-only display: dot decimal, float noise trimmed (plan-510).
  if (typeof value === 'number') return formatDecimal(value);
  if (typeof value === 'string') return value;
  if (isComponentRef(value)) {
    const last = value.path.split('/').pop() ?? value.path;
    return last;
  }
  if (isScriptableObject(value)) {
    const obj = value as Record<string, unknown>;
    return (obj['name'] as string) ?? 'ScriptableObject';
  }
  if (typeof value === 'object' && 'x' in (value as Record<string, unknown>)) {
    const v = value as { x: number; y: number; z: number };
    const f = (n: unknown): string => (typeof n === 'number' ? formatDecimal(n) : String(n));
    return `(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
  }
  return JSON.stringify(value);
}

// ── Signal reference helpers ──────────────────────────────────────────────

export function isSignalRefType(componentType: string): boolean {
  const short = componentType.split('.').pop() ?? '';
  return short.startsWith('PLCInput') || short.startsWith('PLCOutput');
}

export function signalTypeLabel(type: string): string {
  if (type === 'PLCOutputBool') return 'OutBool';
  if (type === 'PLCOutputFloat') return 'OutFloat';
  if (type === 'PLCOutputInt') return 'OutInt';
  if (type === 'PLCInputBool') return 'InBool';
  if (type === 'PLCInputFloat') return 'InFloat';
  if (type === 'PLCInputInt') return 'InInt';
  return type.replace('PLCOutput', 'Out:').replace('PLCInput', 'In:');
}

export function formatRefSignalValue(shortType: string, signalStore: SignalStore | null, path: string): string {
  return formatValue(readSignalValue(signalStore, path), {
    boolStyle: 'glyph',
    intLike: shortType.includes('Int'),
  });
}

// ── Sensor reference helpers ────────────────────────────────────────────

export function isSensorRefType(componentType: string): boolean {
  const short = componentType.split('.').pop() ?? '';
  return short === 'Sensor';
}

export function formatSensorStatus(signalStore: SignalStore | null, path: string): string {
  const value = readSignalValue(signalStore, path);
  if (value === undefined) return '';
  return formatValue(value, { boolStyle: 'glyph' });
}

/**
 * Colour of a signal reference chip — a signal-VALUE surface (plan-341 §2.3):
 * hue = direction, intensity = state, neutral when there is no reading.
 * Non-signal reference types keep their component colour.
 */
export function getRefSignalColor(shortType: string, signalStore: SignalStore | null, path: string): string {
  const dir = signalDirectionFromType(shortType);
  if (dir === 'unknown') return componentColor(shortType);
  if (!signalStore) return SIGNAL_VALUE_NEUTRAL;
  const value = signalStore.getByPath(path);
  if (value === undefined) return SIGNAL_VALUE_NEUTRAL;
  if (shortType.includes('Bool')) return signalValueColor(dir, value === true);
  return signalValueColorForValue(dir, value);
}

/** Get color for a sensor reference chip — gray when not occupied, green when occupied. */
export function getSensorRefColor(signalStore: SignalStore | null, path: string): string {
  if (!signalStore) return '#808080';
  const value = signalStore.getByPath(path);
  if (value === undefined) return '#808080';
  return value === true ? (BADGE_COLORS['Sensor'] ?? '#66bb6a') : '#808080';
}

// ── Signal component type detection (the component itself, not a ref) ─────

export function isSignalComponentType(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

/**
 * Colour of the inspector's live signal value — a signal-VALUE surface
 * (plan-341 §2.3). Hue = direction, intensity = state; an empty reading or an
 * em dash is "no value" and takes the neutral step, not the direction hue.
 * Non-signal component types keep their component colour.
 */
export function getSignalHeaderColor(componentType: string, signalValue: string): string {
  // plan-510: the Fmu header shows the instance state in its state colour.
  if (baseComponentType(componentType) === FMU_TYPE) {
    return FMU_STATE_COLORS[signalValue as FmuState] ?? componentColor(componentType);
  }
  const dir = signalDirectionFromType(componentType);
  if (dir === 'unknown') return componentColor(componentType);
  if (componentType.includes('Bool')) {
    if (signalValue === 'true') return signalValueColor(dir, true);
    if (signalValue === 'false') return signalValueColor(dir, false);
    return SIGNAL_VALUE_NEUTRAL;
  }
  return signalValueColorForValue(dir, signalValue);
}

// Header/live-value reads were moved to rv-value-resolver.ts:
//   getSignalDisplayValue / getDriveDisplayValue → getPrimaryDisplayValue
//   getLiveDriveFields → Drive.getLiveState() merged via getDisplayState

// ── Reverse reference helpers (who points to this node?) ──────────────────

export interface ReverseReference {
  sourcePath: string;
  fieldName: string;
  componentType: string;
}

/** Check if two paths refer to the same node (handles root prefix and space normalization). */
export function pathsMatch(refPath: string, targetPath: string): boolean {
  if (refPath === targetPath) return true;
  const normRef = refPath.replace(/ /g, '_');
  const normTarget = targetPath.replace(/ /g, '_');
  if (normRef === normTarget) return true;
  if (normTarget.endsWith('/' + normRef)) return true;
  if (normRef.endsWith('/' + normTarget)) return true;
  return false;
}
