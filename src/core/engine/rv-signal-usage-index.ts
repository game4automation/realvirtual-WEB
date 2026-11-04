// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-usage-index.ts — the signal cross-reference list (plan-566).
 *
 * "Where is this signal used?" answered once, for every surface that asks it:
 * the inspector's "Used by" section, the "used by N" line of the signal
 * tooltip, the usage popover of a hierarchy / CONNECT signal row and the MCP
 * tool `web_signal_usage`.
 *
 * A usage is one of eight kinds (the last two and the binding carrier anchor
 * added by plan-590 for the signal rename — `metadata`, `historian`):
 *
 *  - `component-field` — a component field that references the signal: a
 *    schema signal slot (`componentRef` + `signal`), a reference field whose
 *    rv-ODT target is a signal (`refType` / the reference-field fallback
 *    table), a `ComponentReference` whose wire `componentType` names a PLC
 *    signal (the runtime's own rule), or one of the few STRING signal fields
 *    (`WebSensor.SignalBool` / `SignalInt`, `ConnectSignal`);
 *  - `logic-step`      — the same, on a `LogicStep_*` component;
 *  - `plc-program`     — an ST program line (via the public PLC seam);
 *  - `operator-panel`  — a `WebOperatorPanel` config element;
 *  - `binding`         — a planner / slot binding (incl. orphaned links);
 *  - `connect-mapping` — a CONNECT bridge (1:1 mapping or mirror rule, a
 *                        wildcard-free mirror pattern as a literal name);
 *  - `metadata`        — a `<signal>` tag of a `RuntimeMetadata.content`;
 *  - `historian`       — a selected historian trend series.
 *
 * Reference fields are resolved the way the runtime resolves them — scope
 * first (`NodeRegistry.resolveSignalReference`, plan-757 F7) — so ten
 * placements with the same relative path each land on their own signal. The
 * raw reverse-reference index of the registry is deliberately NOT reused: it is
 * keyed on the raw `ref.path` and therefore blind to scopes.
 *
 * Performance contract: the index is built LAZILY by the first reader after an
 * invalidation and cached; invalidations are coalesced into one notification
 * per microtask. Nothing here runs per frame or per simulation tick.
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import { isSignalComponentTypeKey, stripComponentNamespace } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import { getFieldDescriptor } from './rv-component-registry';
import { referenceTargetOf } from '../hmi/rv-reference-field';
import { parseWebOperatorPanelConfig } from './rv-extras-validator';
import { operatorPanelSignals } from '../hmi/operator-devices/operator-panel-model';
import { isDuplicateSignalName } from './rv-signal-construction';
import { isComponentReference, storedReferenceForm, storedReferenceLabel, storedReferenceValue } from './rv-node-path-rewrite.mjs';
import { getPlcRuntime, subscribePlcSignalUsages, type PlcRuntime, type PlcSignalUsageAccess } from '../plc-control';

// ─── Data model ──────────────────────────────────────────────────────────

export type SignalUsageKind =
  | 'component-field'
  | 'logic-step'
  | 'plc-program'
  | 'operator-panel'
  | 'metadata'
  | 'binding'
  | 'connect-mapping'
  | 'historian';

/** Display order of the kinds (the UI groups in this order). */
export const SIGNAL_USAGE_KINDS: readonly SignalUsageKind[] = [
  'component-field', 'logic-step', 'plc-program', 'operator-panel', 'metadata', 'binding', 'connect-mapping',
  'historian',
];

/** One place a signal is used. */
export interface SignalUsage {
  kind: SignalUsageKind;
  /** The signal name this usage is indexed under. */
  signal: string;
  /** Primary text (node / program / panel / target name). */
  label: string;
  /** Secondary text (component.field, line + access, binding slot, …). */
  detail?: string;
  /** Registry path of the signal node the usage points at (the raw path when unresolved). */
  signalPath?: string;
  /** False when a reference could not be resolved to a signal node or store entry. */
  resolved: boolean;
  /** True when the usage names the signal by NAME only (string field, legacy scoped name match, PLC, panel, binding). */
  byName?: boolean;
  /** Registry path of the node carrying the using component (component / logic step / panel / binding slot owner). */
  nodePath?: string;
  componentType?: string;
  field?: string;
  /** PLC: scene path of the PLCProgram node. */
  plcProgramPath?: string;
  plcProgramName?: string;
  /** PLC: 1-based line. */
  line?: number;
  /** PLC: how the line touches the signal. */
  access?: PlcSignalUsageAccess;
  /** True when this usage writes the signal. */
  written?: boolean;
  /** PLC: the editor buffer of this program holds unsaved changes (line may be stale). */
  unsaved?: boolean;
  /** CONNECT bridge row key (`mapping:<i>` / `mirror:<i>`) — what the CONNECT panel reveals. */
  connectBridgeKey?: string;
  /** Binding: the bound target's id (planner placement or node). */
  bindingTargetId?: string;
}

/** Read side of a built index. */
export interface SignalUsageIndex {
  /** Version the index was built for (bumped by every invalidation). */
  readonly version: number;
  /** Usages of a signal, grouped by kind in {@link SIGNAL_USAGE_KINDS} order. `[]` when unused. */
  get(name: string): readonly SignalUsage[];
  /** Number of usages of a signal. */
  count(name: string): number;
  /** Every signal name with at least one usage. */
  names(): string[];
}

/** Where collectors put what they found. */
export interface SignalUsageSink {
  add(usage: SignalUsage): void;
}

/** One source of usages. `collect` runs inside a (lazy) build, never per frame. */
export interface SignalUsageProvider {
  collect(sink: SignalUsageSink): void;
}

/** What the core collectors need from a viewer. */
export interface SignalUsageViewerLike {
  readonly registry: NodeRegistry | null | undefined;
  readonly signalStore: SignalStore | null | undefined;
}

const EMPTY: readonly SignalUsage[] = Object.freeze([]);

// ─── Helpers ─────────────────────────────────────────────────────────────


function leaf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * True when a `ComponentReference` field names a SIGNAL — the schema says so
 * (signal slot, alias included), the rv-ODT reference target says so, or the
 * reference's own wire type does (the runtime's `resolve()` rule:
 * `Signal` / `PLC` in the componentType).
 */
export function isSignalReferenceField(componentType: string, field: string, ref: { componentType?: string }): boolean {
  const ct = stripComponentNamespace(String(ref.componentType ?? ''));
  if (ct && (isSignalComponentTypeKey(ct) || ct.includes('Signal') || ct.startsWith('PLC'))) return true;
  const desc = getFieldDescriptor(componentType, field);
  if (desc?.type === 'componentRef' && desc.signal) return true;
  return referenceTargetOf(componentType, field)?.kind === 'signal';
}

/** STRING fields that carry a signal NAME (plan-566 R6) — a fixed list, never a heuristic. */
const STRING_SIGNAL_FIELDS: Readonly<Record<string, readonly string[] | '*'>> = {
  WebSensor: ['SignalBool', 'SignalInt'],
  ConnectSignal: '*',
};

/** True when `componentType.field` is one of the fixed STRING signal-name fields (plan-566 R6). */
export function isStringSignalField(componentType: string, field: string): boolean {
  const fields = STRING_SIGNAL_FIELDS[componentType];
  if (!fields) return false;
  if (fields === '*') return field !== 'Name';
  return fields.includes(field);
}

/** True when the component WRITES the signal behind a reference field. */
function writesSignal(componentType: string, field: string, refComponentType: string): boolean {
  const desc = getFieldDescriptor(componentType, field);
  if (desc?.type === 'componentRef' && desc.signal) return desc.signal.startsWith('PLCInput');
  if (componentType.startsWith('LogicStep_SetSignal')) return true;
  return stripComponentNamespace(refComponentType).startsWith('PLCInput');
}

// ─── Collectors ──────────────────────────────────────────────────────────

/**
 * Component fields and logic steps (F2, R5, R6). Every registered node is
 * visited once (aliases skipped); the signal side of each reference is
 * resolved in the scope of the node that carries it.
 */
export function collectComponentUsages(viewer: SignalUsageViewerLike, sink: SignalUsageSink): void {
  const registry = viewer.registry;
  if (!registry) return;
  const store = viewer.signalStore ?? null;
  registry.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return; // alias entry
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || typeof rv !== 'object') return;
    for (const [componentType, data] of Object.entries(rv)) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      if (isSignalComponentTypeKey(componentType)) continue; // the signal declaring itself
      if (componentType === 'WebOperatorPanel' || componentType === 'PLCProgram') continue; // own collectors
      const kind: SignalUsageKind = componentType.startsWith('LogicStep_') ? 'logic-step' : 'component-field';
      for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
        if (isComponentReference(value)) {
          if (!isSignalReferenceField(componentType, field, value)) continue;
          addReferenceUsage(registry, store, node, path, componentType, field, value, kind, sink);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (!isComponentReference(item) || !isSignalReferenceField(componentType, field, item)) continue;
            addReferenceUsage(registry, store, node, path, componentType, field, item, kind, sink);
          }
        } else if (typeof value === 'string' && value.length > 0 && isStringSignalField(componentType, field)) {
          addStringUsage(store, path, componentType, field, value, kind, sink);
        }
      }
    }
  });
}

function usageLabel(kind: SignalUsageKind, nodePath: string, componentType: string, field: string): { label: string; detail: string } {
  if (kind === 'logic-step') {
    return { label: leaf(nodePath), detail: `${componentType.slice('LogicStep_'.length)}.${field}` };
  }
  return { label: leaf(nodePath), detail: `${componentType}.${field}` };
}

/**
 * The signal node one stored reference names: a path through the signal lookup
 * (scope, registry, name in scope); an address-form reference (plan-769 Phase 3) by
 * its file's verdict — its id, never a name match. A miss keeps the label as path.
 */
function signalReferenceHit(
  registry: NodeRegistry,
  node: Object3D,
  ref: { path?: string; address?: string; unresolvedPath?: string },
): { path: string; resolved: boolean; byName: boolean } {
  const form = storedReferenceForm(ref);
  if (!form) return { path: '', resolved: false, byName: false };
  if (form.form === 'path') return registry.resolveSignalReference(form.path, node);
  const r = registry.readStoredRef(node, storedReferenceValue(ref)!);
  const at = r.status === 'resolved' ? registry.getPathForNode(r.node) : null;
  return at ? { path: at, resolved: true, byName: false } : { path: storedReferenceLabel(ref) ?? '', resolved: false, byName: false };
}

function addReferenceUsage(
  registry: NodeRegistry,
  store: SignalStore | null,
  node: Object3D,
  nodePath: string,
  componentType: string,
  field: string,
  ref: { path?: string; address?: string; unresolvedPath?: string; componentType?: string },
  kind: SignalUsageKind,
  sink: SignalUsageSink,
): void {
  const hit = signalReferenceHit(registry, node, ref);
  let name = store ? (store.exactNameForPath(hit.path) ?? store.nameForPath(hit.path)) : undefined;
  // A process-image signal legitimately has no node — the store may still know the path.
  const resolved = hit.resolved || name !== undefined;
  if (!name) name = leaf(hit.path);
  if (!name) return;
  const { label, detail } = usageLabel(kind, nodePath, componentType, field);
  sink.add({
    kind,
    signal: name,
    label,
    detail,
    signalPath: hit.path,
    resolved,
    ...(hit.byName ? { byName: true } : {}),
    nodePath,
    componentType,
    field,
    ...(writesSignal(componentType, field, String(ref.componentType ?? '')) ? { written: true } : {}),
  });
}

function addStringUsage(
  store: SignalStore | null,
  nodePath: string,
  componentType: string,
  field: string,
  value: string,
  kind: SignalUsageKind,
  sink: SignalUsageSink,
): void {
  // A string signal field holds a NAME — or, for a resolved ConnectSignal, a path.
  let name = value;
  let signalPath = store?.getPath(value);
  if (signalPath === undefined && store) {
    const byPath = store.exactNameForPath(value) ?? store.nameForPath(value);
    if (byPath) { name = byPath; signalPath = value; }
  }
  const resolved = !store || store.get(name) !== undefined || signalPath !== undefined;
  const { label, detail } = usageLabel(kind, nodePath, componentType, field);
  sink.add({
    kind, signal: name, label, detail,
    ...(signalPath !== undefined ? { signalPath } : {}),
    resolved, byName: true, nodePath, componentType, field,
  });
}

/** Structural slice of an operator panel config element. */
type PanelObj = Record<string, unknown>;
const isObj = (x: unknown): x is PanelObj => typeof x === 'object' && x !== null && !Array.isArray(x);

function conditionSignals(c: unknown, out: Set<string>): void {
  if (!isObj(c)) return;
  if (typeof c.signal === 'string') out.add(c.signal);
  if (Array.isArray(c.all)) for (const x of c.all) conditionSignals(x, out);
  if (Array.isArray(c.any)) for (const x of c.any) conditionSignals(x, out);
  if (c.not !== undefined) conditionSignals(c.not, out);
}

/**
 * Operator panels (F3): every `WebOperatorPanel` of the model, element by
 * element (selector, button, E-stop, lamp, tower segment, chip, status rule).
 * `operatorPanelSignals()` is the completeness check — a signal it names that
 * the element walk did not label still gets a (generic) entry.
 */
export function collectOperatorPanelUsages(viewer: SignalUsageViewerLike, sink: SignalUsageSink): void {
  const registry = viewer.registry;
  if (!registry) return;
  registry.forEachNode((nodePath, node) => {
    if (registry.getPathForNode(node) !== nodePath) return;
    const data = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.WebOperatorPanel;
    if (!data) return;
    const instance = registry.componentOn<{ configSource?: unknown; Title?: string }>(node, 'WebOperatorPanel');
    const source = instance?.configSource ?? data.Config;
    const parsed = parseWebOperatorPanelConfig(source);
    if (!isObj(parsed.raw)) return;
    const raw = parsed.raw;
    const title = (typeof data.Title === 'string' && data.Title)
      || (typeof raw.title === 'string' && raw.title) || leaf(nodePath);
    const seen = new Set<string>();
    const add = (signal: unknown, detail: string, written: boolean) => {
      if (typeof signal !== 'string' || !signal) return;
      seen.add(signal);
      sink.add({
        kind: 'operator-panel', signal, label: title, detail, resolved: true, byName: true,
        nodePath, componentType: 'WebOperatorPanel', field: 'Config',
        ...(written ? { written: true } : {}),
      });
    };
    const lamp = (owner: string, l: unknown) => {
      if (!isObj(l)) return;
      add(l.signal, `${owner} lamp`, false);
      const flash = new Set<string>();
      conditionSignals(l.flashWhen, flash);
      for (const s of flash) add(s, `${owner} lamp flash`, false);
    };
    const named = (kind: string, el: PanelObj, i: number) =>
      `${kind} ${typeof el.label === 'string' && el.label ? el.label : typeof el.name === 'string' && el.name ? el.name : `#${i + 1}`}`;
    const list = (k: string): PanelObj[] => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter(isObj) : []);
    list('selectors').forEach((s, i) => { add(s.signal, named('Selector', s, i), true); lamp(named('Selector', s, i), s.lamp); });
    list('buttons').forEach((b, i) => { add(b.signal, named('Button', b, i), true); lamp(named('Button', b, i), b.lamp); });
    list('estops').forEach((e, i) => { add(e.signal, named('E-stop', e, i), true); lamp(named('E-stop', e, i), e.lamp); });
    list('stackLight').forEach((t, i) => add(t.signal, named('Stack light', t, i), false));
    list('chips').forEach((c, i) => {
      const cs = new Set<string>(); conditionSignals(c.when, cs);
      for (const s of cs) add(s, `${named('Chip', c, i)} condition`, false);
    });
    list('status').forEach((r, i) => {
      const cs = new Set<string>(); conditionSignals(r.when, cs);
      const kind = typeof r.kind === 'string' && r.kind ? r.kind : `#${i + 1}`;
      for (const s of cs) add(s, `Status ${kind} condition`, false);
    });
    // Completeness: anything the model function names that the walk missed.
    try {
      for (const s of operatorPanelSignals(raw as unknown as Parameters<typeof operatorPanelSignals>[0])) {
        if (!seen.has(s)) add(s, 'Panel', false);
      }
    } catch { /* structurally incomplete config — the walk above already took what is there */ }
  });
}

// ─── plan-590: metadata, mapping anchors, historian ──────────────────────

/** `<signal>NAME</signal>` — the one metadata tag that names a signal (top level or nested in `<value>`). */
const METADATA_SIGNAL_RE = /<signal>([^<]*)<\/signal>/gi;

/** Every signal name a `RuntimeMetadata.content` string binds (trimmed, in order, duplicates kept). */
export function metadataSignalNames(content: string): string[] {
  const out: string[] = [];
  METADATA_SIGNAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METADATA_SIGNAL_RE.exec(content)) !== null) {
    const name = m[1].trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * Metadata (plan-590 F6): every `<signal>` tag of a `RuntimeMetadata.content`
 * — the tooltip / inspector rows that show a live signal value.
 */
export function collectMetadataUsages(viewer: SignalUsageViewerLike, sink: SignalUsageSink): void {
  const registry = viewer.registry;
  if (!registry) return;
  registry.forEachNode((nodePath, node) => {
    if (registry.getPathForNode(node) !== nodePath) return;
    const data = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.RuntimeMetadata;
    const content = data?.content;
    if (typeof content !== 'string' || !content.includes('<')) return;
    const seen = new Set<string>();
    for (const signal of metadataSignalNames(content)) {
      if (seen.has(signal)) continue;
      seen.add(signal);
      sink.add({
        kind: 'metadata', signal, label: leaf(nodePath), detail: 'RuntimeMetadata <signal>',
        resolved: true, byName: true, nodePath, componentType: 'RuntimeMetadata', field: 'content',
      });
    }
  });
}

/**
 * Carrier anchors of node signal mappings (plan-590 F6): a
 * `SignalLinks.Mappings[].carrierSignalName` names the signal NODE that
 * carries the mapping (plan-425 case A). The bound signal itself is listed by
 * the binding inventory; the anchor is a second, independent name reference.
 */
export function collectSignalLinkAnchorUsages(viewer: SignalUsageViewerLike, sink: SignalUsageSink): void {
  const registry = viewer.registry;
  if (!registry) return;
  registry.forEachNode((nodePath, node) => {
    if (registry.getPathForNode(node) !== nodePath) return;
    const links = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.SignalLinks;
    const mappings = links?.Mappings;
    if (!Array.isArray(mappings)) return;
    for (const m of mappings) {
      if (!isObj(m) || typeof m.carrierSignalName !== 'string' || !m.carrierSignalName) continue;
      sink.add({
        kind: 'binding', signal: m.carrierSignalName, label: leaf(nodePath),
        detail: `carrier anchor of ${typeof m.componentPath === 'string' && m.componentPath ? m.componentPath : 'a binding'}`,
        resolved: true, byName: true, nodePath, componentType: 'SignalLinks', field: 'Mappings',
      });
    }
  });
}

/** Historian selection (plan-590 F6): a selected trend series names its signal. */
export function collectHistorianUsages(selected: readonly string[] | null | undefined, sink: SignalUsageSink): void {
  for (const signal of selected ?? []) {
    if (!signal) continue;
    sink.add({
      kind: 'historian', signal, label: 'Historian', detail: 'selected trend series',
      resolved: true, byName: true,
    });
  }
}

/** PLC programs (F4, R3, R7) through the public seam — no private import. */
export function collectPlcUsages(runtime: PlcRuntime | null, sink: SignalUsageSink): void {
  const usages = runtime?.getSignalUsages?.();
  if (!usages) return;
  for (const u of usages) {
    const accessText = u.access === 'declaration' ? 'declaration' : u.access;
    sink.add({
      kind: 'plc-program',
      signal: u.signal,
      label: u.programName,
      detail: `line ${u.line} (${accessText})${u.unsaved ? ' · unsaved changes' : ''}`,
      resolved: true,
      byName: true,
      plcProgramPath: u.programPath,
      plcProgramName: u.programName,
      line: u.line,
      access: u.access,
      ...(u.written ? { written: true } : {}),
      ...(u.unsaved ? { unsaved: true } : {}),
    });
  }
}

/** Structural slice of a binding inventory (plugins/signal-bind/binding-inventory.ts). */
export interface BindingInventoryLike {
  rows: ReadonlyArray<{
    targetId: string; targetLabel: string; componentPath: string; slot: string;
    componentType?: string; label?: string; direction: 'plcOutput' | 'plcInput';
    signal?: string; interfaceId?: string;
  }>;
  orphans: ReadonlyArray<{ targetId: string; targetLabel: string; slot: string; componentPath?: string; componentType?: string; signal: string }>;
}

/** Bindings (F3) incl. orphaned links. Indexed under the EXTERNAL signal the slot is bound to. */
export function collectBindingUsages(inventory: BindingInventoryLike | null, sink: SignalUsageSink): void {
  if (!inventory) return;
  for (const row of inventory.rows) {
    if (!row.signal) continue;
    sink.add({
      kind: 'binding',
      signal: row.signal,
      label: row.targetLabel,
      detail: `${row.label ?? row.slot}${row.interfaceId ? ` ← ${row.interfaceId}` : ''}`,
      resolved: true,
      byName: true,
      nodePath: row.componentPath,
      ...(row.componentType ? { componentType: row.componentType } : {}),
      field: row.slot,
      bindingTargetId: row.targetId,
      // A PLC OUTPUT slot is driven BY the bound signal; a PLC INPUT slot writes it.
      ...(row.direction === 'plcInput' ? { written: true } : {}),
    });
  }
  for (const o of inventory.orphans) {
    sink.add({
      kind: 'binding',
      signal: o.signal,
      label: o.targetLabel,
      detail: `${o.slot} (orphaned)`,
      resolved: false,
      byName: true,
      ...(o.componentPath ? { nodePath: o.componentPath } : {}),
      ...(o.componentType ? { componentType: o.componentType } : {}),
      field: o.slot,
      bindingTargetId: o.targetId,
    });
  }
}

/** Structural slice of the CONNECT bridges (connect-store.ts). */
export interface ConnectBridgesLike {
  mappings: ReadonlyArray<{ enabled: boolean; sourceSignal: string; destSignal: string }> | null;
  mirrors: ReadonlyArray<{ enabled: boolean; sourceInterfaceId: string; targetInterfaceId: string; signalPattern: string }> | null;
}

/** Glob (`*` / `?`) match, as CONNECT's mirror rules use it. */
export function globMatches(pattern: string, name: string): boolean {
  const p = pattern || '*';
  if (p === '*') return true;
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

/**
 * CONNECT bridges (R2-1): every 1:1 mapping indexes its source AND its
 * destination signal; every mirror rule indexes each source-interface signal
 * its pattern matches. Disabled bridges are listed too (marked in the detail),
 * because the configuration still names the signal.
 */
export function collectConnectBridgeUsages(
  bridges: ConnectBridgesLike | null,
  interfaces: ReadonlyArray<{ id: string; signals?: ReadonlyArray<{ name: string }> }>,
  sink: SignalUsageSink,
): void {
  if (!bridges) return;
  (bridges.mappings ?? []).forEach((m, i) => {
    const off = m.enabled ? '' : ' · disabled';
    const key = `mapping:${i}`;
    if (m.sourceSignal) {
      sink.add({
        kind: 'connect-mapping', signal: m.sourceSignal, label: `Bridge → ${m.destSignal}`,
        detail: `1:1 source${off}`, resolved: true, byName: true, connectBridgeKey: key,
      });
    }
    if (m.destSignal) {
      sink.add({
        kind: 'connect-mapping', signal: m.destSignal, label: `Bridge ${m.sourceSignal} →`,
        detail: `1:1 destination${off}`, resolved: true, byName: true, connectBridgeKey: key, written: true,
      });
    }
  });
  (bridges.mirrors ?? []).forEach((rule, i) => {
    const source = interfaces.find((x) => x.id === rule.sourceInterfaceId);
    if (!source) return;
    const off = rule.enabled ? '' : ' · disabled';
    let matched = false;
    for (const s of source.signals ?? []) {
      if (!s.name || !globMatches(rule.signalPattern, s.name)) continue;
      matched = true;
      sink.add({
        kind: 'connect-mapping', signal: s.name,
        label: `Mirror ${rule.sourceInterfaceId} → ${rule.targetInterfaceId}`,
        detail: `pattern ${rule.signalPattern || '*'}${off}`, resolved: true, byName: true,
        connectBridgeKey: `mirror:${i}`,
      });
    }
    // plan-590 F6: a pattern WITHOUT wildcards is a literal signal name. It
    // names that signal even while the source interface does not list it
    // (yet) — a rename must see it, because it is never rewritten.
    const literal = rule.signalPattern;
    if (!matched && literal && !/[*?]/.test(literal)) {
      sink.add({
        kind: 'connect-mapping', signal: literal,
        label: `Mirror ${rule.sourceInterfaceId} → ${rule.targetInterfaceId}`,
        detail: `literal pattern${off}`, resolved: false, byName: true,
        connectBridgeKey: `mirror:${i}`,
      });
    }
  });
}

// ─── Index ───────────────────────────────────────────────────────────────

const KIND_RANK = new Map(SIGNAL_USAGE_KINDS.map((k, i) => [k, i]));

/** Builds an index from providers. Pure apart from what the providers read. */
export function buildSignalUsageIndex(providers: Iterable<SignalUsageProvider>, version = 0): SignalUsageIndex {
  const byName = new Map<string, SignalUsage[]>();
  const sink: SignalUsageSink = {
    add(u) {
      let list = byName.get(u.signal);
      if (!list) byName.set(u.signal, (list = []));
      list.push(u);
    },
  };
  for (const p of providers) {
    try { p.collect(sink); } catch (e) { console.warn('[signal-usage] provider failed:', e); }
  }
  for (const list of byName.values()) {
    list.sort((a, b) => (KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)!)
      || a.label.localeCompare(b.label)
      || (a.line ?? 0) - (b.line ?? 0));
  }
  return {
    version,
    get: (name) => byName.get(name) ?? EMPTY,
    count: (name) => byName.get(name)?.length ?? 0,
    names: () => [...byName.keys()],
  };
}

/** Usages grouped by kind, in display order (empty kinds omitted). */
export function groupSignalUsages(usages: readonly SignalUsage[]): Array<{ kind: SignalUsageKind; usages: SignalUsage[] }> {
  const out: Array<{ kind: SignalUsageKind; usages: SignalUsage[] }> = [];
  for (const kind of SIGNAL_USAGE_KINDS) {
    const list = usages.filter((u) => u.kind === kind);
    if (list.length > 0) out.push({ kind, usages: list });
  }
  return out;
}

/** UI heading of a kind. */
export const SIGNAL_USAGE_KIND_LABELS: Readonly<Record<SignalUsageKind, string>> = {
  'component-field': 'Components',
  'logic-step': 'Logic steps',
  'plc-program': 'PLC',
  'operator-panel': 'Operator panel',
  'metadata': 'Metadata',
  'binding': 'Bindings',
  'connect-mapping': 'CONNECT bridges',
  'historian': 'Historian',
};

/** True when two node paths register the same signal name (F9) — usages are then grouped by `signalPath`. */
export function isAmbiguousSignalName(store: SignalStore | null | undefined, name: string): boolean {
  return !!store && isDuplicateSignalName(store, name);
}

// ─── Service ─────────────────────────────────────────────────────────────

interface ProviderEntry { provider: SignalUsageProvider; off: (() => void) | null }

/**
 * Viewer-owned, lazily built, versioned usage index (F5).
 *
 * Providers register once (`registerProvider`, idempotent by id) together with
 * an optional change subscription; any change — and every viewer event the
 * viewer wires to {@link invalidate} — marks the index dirty at once and
 * notifies subscribers ONCE per microtask with a new {@link version}. The next
 * reader rebuilds; nobody else pays.
 */
export class SignalUsageService {
  private readonly _providers = new Map<string, ProviderEntry>();
  private readonly _listeners = new Set<() => void>();
  private _index: SignalUsageIndex | null = null;
  private _version = 0;
  private _scheduled = false;
  private _builds = 0;

  /** Current version — a new one after every (coalesced) invalidation. */
  get version(): number { return this._version; }

  /** How often the index was built (diagnostics / tests). */
  get buildCount(): number { return this._builds; }

  /** Is a provider registered under `id`? */
  hasProvider(id: string): boolean { return this._providers.has(id); }

  /**
   * Registers (or replaces) a provider. `subscribe` is called once with the
   * invalidation callback and must return its unsubscribe. Returns a function
   * that removes the provider again.
   */
  registerProvider(
    id: string,
    provider: SignalUsageProvider,
    subscribe?: (onChange: () => void) => () => void,
  ): () => void {
    this._providers.get(id)?.off?.();
    const entry: ProviderEntry = { provider, off: null };
    this._providers.set(id, entry);
    if (subscribe) entry.off = subscribe(() => this.invalidate());
    this.invalidate();
    return () => {
      if (this._providers.get(id) !== entry) return;
      entry.off?.();
      this._providers.delete(id);
      this.invalidate();
    };
  }

  /** Marks the index stale; subscribers are notified once per microtask. */
  invalidate = (): void => {
    this._index = null;
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      this._version++;
      this._index = null;
      for (const cb of [...this._listeners]) {
        try { cb(); } catch (e) { console.warn('[signal-usage] listener failed:', e); }
      }
    });
  };

  /** Model cleared: drop the cached index (memory) and notify. */
  clear(): void {
    this.invalidate();
  }

  /** useSyncExternalStore-compatible subscription. */
  subscribe = (cb: () => void): (() => void) => {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  };

  /** useSyncExternalStore snapshot: the version. */
  getVersion = (): number => this._version;

  /** The index, built on demand. */
  get index(): SignalUsageIndex {
    if (!this._index) {
      this._builds++;
      this._index = buildSignalUsageIndex([...this._providers.values()].map((e) => e.provider), this._version);
    }
    return this._index;
  }

  /** Usages of one signal. */
  usages(name: string): readonly SignalUsage[] {
    return this.index.get(name);
  }

  /** Number of usages of one signal. */
  count(name: string): number {
    return this.index.count(name);
  }

  dispose(): void {
    for (const e of this._providers.values()) e.off?.();
    this._providers.clear();
    this._listeners.clear();
    this._index = null;
  }
}

/**
 * Registers the core providers — components + logic steps, operator panels and
 * the PLC seam — on a viewer's service. The HMI layer adds bindings, CONNECT
 * bridges and the SceneStore subscription (`use-signal-usages.ts`), because
 * those live above the engine.
 */
export function installCoreSignalUsageProviders(service: SignalUsageService, viewer: SignalUsageViewerLike): void {
  service.registerProvider('components', { collect: (sink) => collectComponentUsages(viewer, sink) });
  service.registerProvider('operator-panels', { collect: (sink) => collectOperatorPanelUsages(viewer, sink) });
  service.registerProvider('metadata', { collect: (sink) => collectMetadataUsages(viewer, sink) });
  service.registerProvider('signal-link-anchors', { collect: (sink) => collectSignalLinkAnchorUsages(viewer, sink) });
  service.registerProvider('plc', { collect: (sink) => collectPlcUsages(getPlcRuntime(), sink) }, subscribePlcSignalUsages);
}
