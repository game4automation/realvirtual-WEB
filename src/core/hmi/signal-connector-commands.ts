// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-connector-commands — the SignalConnector's own commands (plan-2227 Phase 2).
 *
 * Open implementations (the component is AGPL core; the commands only need the
 * `AssetDocument` every editor command writes through):
 *
 * - `signalConnector.setMode` (edit, macro): sets `Mode` AND clears every slot the
 *   new Mode does not use, as ONE undo step. The inspector's Mode row and the
 *   `editor.setField(…, 'Mode', …)` redirect run exactly this (plan §2.3).
 * - `signalConnector.createBits` (edit, macro): n child nodes `Bit00…` under one
 *   node, one `BitFromWord` / `BitToWord` connector each, ONE undo step (R9). The
 *   macro line carries the resolved arguments — parent path, word, bit list, the
 *   bool signals, width, signed, invert — never "the selection" (contract
 *   commands-mcp rule 6).
 * - `signalConnector.list` (read, `web_query`): every connector of the loaded
 *   scene with address, Mode, active slots, current values and problem codes.
 */

import { whenDocumentSettled } from './rv-bind-queue';
import type { Object3D } from 'three';
import { CommandError, type CommandContext, type CommandEnabled, type CommandImpl } from './rv-command-registry';
import type { AssetDocument } from '../editor/rv-asset-document';
import { getFieldDescriptor, getSchemaDefaults } from '../engine/rv-component-registry';
import { componentReference } from '../engine/rv-signal-construction';
import type { PlcSignalType } from '../engine/rv-component-registry';
import { type ConnectorSlot, type SignalConnectorMode, type WordWidth } from '../engine/rv-signal-conversion';
import {
  SIGNAL_CONNECTOR_TYPE,
  bitChildName,
  bitModeSlots,
  isBitMode,
  isSignalConnectorMode,
  isWordWidth,
  parseBitList,
  slotsClearedBySetMode,
  type BitConnectorMode,
} from '../engine/rv-signal-connector-ops';
import { signalConnectorNetworkFor, SIGNAL_CONNECTOR_PROBLEM_CODES } from '../engine/rv-signal-connector';
import { getProblems } from './problems-store';
// The feature body: registers the component (via rv-signal-connector) and installs the CONNECT feed.
import '../../features/signal-connector.body';

export const SIGNAL_CONNECTOR_SET_MODE_COMMAND = 'signalConnector.setMode';
export const SIGNAL_CONNECTOR_CREATE_BITS_COMMAND = 'signalConnector.createBits';
export const SIGNAL_CONNECTOR_LIST_COMMAND = 'signalConnector.list';

/** Shared refusal texts (tooltip = tool result). */
export const NEEDS_CONNECTOR_PATH = 'Needs the path of a node with a SignalConnector';
export const MODE_INVALID = 'mode must be Copy | IntToBool | BoolToInt | BitFromWord | BitToWord | Scale';
export const BIT_MODE_INVALID = 'mode must be BitFromWord | BitToWord';
export const WIDTH_INVALID = 'width must be Byte | Word | DWord';
export const NEEDS_WORD = 'Needs the INT word signal (word)';
const TEST_RUN_ACTIVE =
  'A test run is active (in-place test session): edits made now are rolled back '
  + 'together with the test scene when the run stops, so they would be lost silently. '
  + 'Stop the test run first, then repeat the edit.';

const PLC_SIGNAL_TYPES = ['PLCOutputBool', 'PLCOutputInt', 'PLCOutputFloat', 'PLCInputBool', 'PLCInputInt', 'PLCInputFloat'];

// ─── Helpers ────────────────────────────────────────────────────────────

const refuse = (reason: string, details?: Record<string, unknown>): CommandEnabled =>
  (details ? { reason, details } : { reason });

function rvOf(node: Object3D | null | undefined): Record<string, unknown> {
  return ((node?.userData as Record<string, unknown> | undefined)?.realvirtual as Record<string, unknown> | undefined) ?? {};
}

function docOf(ctx: CommandContext): AssetDocument {
  return ctx.doc as AssetDocument;
}

function testRunRefusal(ctx: CommandContext): CommandEnabled | null {
  return (ctx.doc as AssetDocument | null)?.lockOwner?.kind === 'test-run' ? refuse(TEST_RUN_ACTIVE) : null;
}

function nodeOf(ctx: CommandContext, path: string | null | undefined): Object3D | null {
  return path ? ctx.viewer.registry?.getNode(path) ?? null : null;
}

/** `path` or — when null/undefined — the first selected node (resolved into the macro line). */
function pathOrSelection(ctx: CommandContext, path: string | null | undefined): string {
  if (path === null || path === undefined) return ctx.selection[0] ?? '';
  return String(path).trim();
}

/** The connector's component key on a node (`SignalConnector`, or a `_N`-deduped one). */
function connectorKeyOn(node: Object3D, wanted?: string | null): string | null {
  const rv = rvOf(node);
  if (wanted) return rv[wanted] && typeof rv[wanted] === 'object' && wanted.replace(/_\d+$/, '') === SIGNAL_CONNECTOR_TYPE ? wanted : null;
  return Object.keys(rv).find((k) => k.replace(/_\d+$/, '') === SIGNAL_CONNECTOR_TYPE) ?? null;
}

/** The PLC signal type a node carries, or null when it is no signal node. */
function signalTypeOf(node: Object3D | null): string | null {
  if (!node) return null;
  for (const k of Object.keys(rvOf(node))) {
    const base = k.replace(/_\d+$/, '');
    if (PLC_SIGNAL_TYPES.includes(base)) return base;
  }
  return null;
}

/** The signal annotation of a slot (`PLCOutputInt`, `PLCInputBool`, …). */
function slotSignalType(slot: ConnectorSlot): PlcSignalType {
  return getFieldDescriptor(SIGNAL_CONNECTOR_TYPE, slot)?.signal as PlcSignalType;
}

/** Canonical registry path of a node. */
function canonicalPath(ctx: CommandContext, node: Object3D, fallback: string): string {
  return ctx.viewer.registry?.getPathForNode(node) ?? fallback;
}

/** A signal path argument checked for the value kind of a slot (`Int` / `Bool`); null = ok. */
function signalArgRefusal(ctx: CommandContext, path: string, kind: 'Int' | 'Bool', what: string): string | null {
  const node = nodeOf(ctx, path);
  if (!node) return `${what}: no node at "${path}"`;
  const type = signalTypeOf(node);
  if (!type) return `${what}: "${path}" is not a signal node (needs one of ${PLC_SIGNAL_TYPES.join(', ')})`;
  if (!type.endsWith(kind)) return `${what}: "${path}" is a ${type}, needs a ${kind.toUpperCase()} signal`;
  return null;
}

// ─── signalConnector.setMode ─────────────────────────────────────────────

export interface SignalConnectorSetModeArgs {
  readonly path: string | null | undefined;
  readonly mode: string;
  readonly componentType?: string | null;
}

export interface SignalConnectorSetModeResult {
  readonly path: string;
  readonly componentType: string;
  readonly mode: SignalConnectorMode;
  readonly prevMode: unknown;
  readonly cleared: ConnectorSlot[];
}

function setModeEnabled(ctx: CommandContext, a: SignalConnectorSetModeArgs): CommandEnabled {
  const lock = testRunRefusal(ctx);
  if (lock) return lock;
  const path = pathOrSelection(ctx, a?.path);
  if (!path) return refuse(NEEDS_CONNECTOR_PATH);
  const node = nodeOf(ctx, path);
  if (!node) return refuse(`Node not found: ${path}`);
  if (!connectorKeyOn(node, a?.componentType)) {
    return refuse(`No SignalConnector on ${path}`, { components: Object.keys(rvOf(node)) });
  }
  if (!isSignalConnectorMode(String(a?.mode ?? '').trim())) return refuse(MODE_INVALID);
  return true;
}

/**
 * Set the Mode and clear the slots it does not use, as one undo step. Shared by
 * the command and by `editor.setField(…, 'Mode', …)` on a SignalConnector.
 */
export async function runSignalConnectorSetMode(
  ctx: CommandContext, a: SignalConnectorSetModeArgs,
): Promise<SignalConnectorSetModeResult> {
  const path = pathOrSelection(ctx, a.path);
  const node = nodeOf(ctx, path);
  const key = node ? connectorKeyOn(node, a.componentType) : null;
  if (!node || !key) throw new CommandError(`No SignalConnector on ${path}`, { path });
  const mode = String(a.mode).trim();
  if (!isSignalConnectorMode(mode)) throw new CommandError(MODE_INVALID, { mode });
  const doc = docOf(ctx);
  const data = { ...(rvOf(node)[key] as Record<string, unknown>) };
  const prevMode = data.Mode;
  const cleared = slotsClearedBySetMode(mode, data);
  try {
    await doc.withTransaction(`Set mode ${mode}`, async () => {
      if (prevMode !== mode) await doc.setFieldAwaited(path, key, 'Mode', mode, prevMode);
      for (const slot of cleared) await doc.setFieldAwaited(path, key, slot, null, data[slot]);
    });
  } catch (e) {
    throw new CommandError(`Mode not changed - ${e instanceof Error ? e.message : String(e)}`, { path, mode });
  }
  const after = rvOf(nodeOf(ctx, path))[key] as Record<string, unknown> | undefined;
  if (after?.Mode !== mode) {
    throw new CommandError(`setMode did not land: ${key}.Mode on ${path} holds ${JSON.stringify(after?.Mode ?? null)}`, { path, mode });
  }
  return { path, componentType: key, mode, prevMode: prevMode ?? null, cleared };
}

export const signalConnectorSetModeImpl: CommandImpl<SignalConnectorSetModeArgs, SignalConnectorSetModeResult> = {
  enabled: setModeEnabled,
  resolveArgs: (ctx, a) => {
    const path = pathOrSelection(ctx, a?.path);
    const node = nodeOf(ctx, path);
    return {
      path,
      mode: String(a?.mode ?? '').trim(),
      componentType: (node && connectorKeyOn(node, a?.componentType)) ?? a?.componentType ?? SIGNAL_CONNECTOR_TYPE,
    };
  },
  run: (ctx, a) => runSignalConnectorSetMode(ctx, a),
};

// ─── signalConnector.createBits ──────────────────────────────────────────

export interface SignalConnectorCreateBitsArgs {
  /** Node the `BitNN` children are created under; null = the first selected node. */
  readonly path: string | null | undefined;
  readonly mode: string;
  /** The INT word: source of `BitFromWord`, target of `BitToWord`. */
  readonly word: string;
  /** Bits: a number list, or text such as `"0-7"` / `"0,2,5"`. */
  readonly bits: string | readonly number[];
  /** One BOOL signal per bit (targets of `BitFromWord`, sources of `BitToWord`); `''` leaves a slot empty. */
  readonly signals?: readonly string[] | null;
  readonly width?: string | null;
  readonly signed?: boolean | null;
  readonly invert?: boolean | null;
}

export interface SignalConnectorCreateBitsResult {
  readonly path: string;
  readonly mode: BitConnectorMode;
  readonly created: string[];
  readonly bits: number[];
}

interface ResolvedBits {
  path: string;
  mode: BitConnectorMode;
  word: string;
  bits: number[];
  signals: string[];
  width: WordWidth;
  signed: boolean;
  invert: boolean;
}

/** The fully resolved arguments, or the reason they cannot be. */
function resolveBits(ctx: CommandContext, a: SignalConnectorCreateBitsArgs): ResolvedBits | { reason: string } {
  const path = pathOrSelection(ctx, a?.path);
  if (!path) return { reason: 'Needs the node the bit connectors are created under (path) — or select one' };
  const parent = nodeOf(ctx, path);
  if (!parent) return { reason: `Node not found: ${path}` };
  const mode = String(a?.mode ?? '').trim();
  if (!isBitMode(mode)) return { reason: BIT_MODE_INVALID };
  const width = a?.width === null || a?.width === undefined || a?.width === '' ? 'Word' : String(a.width).trim();
  if (!isWordWidth(width)) return { reason: WIDTH_INVALID };
  const wordArg = String(a?.word ?? '').trim();
  if (!wordArg) return { reason: NEEDS_WORD };
  const wordRefusal = signalArgRefusal(ctx, wordArg, 'Int', 'word');
  if (wordRefusal) return { reason: wordRefusal };
  const parsed = parseBitList(a?.bits, width);
  if ('error' in parsed) return { reason: `bits: ${parsed.error}` };
  const given = (a?.signals ?? []).map((s) => String(s ?? '').trim());
  if (given.length > parsed.bits.length) {
    return { reason: `signals has ${given.length} entries for ${parsed.bits.length} bits` };
  }
  const signals: string[] = [];
  for (let i = 0; i < parsed.bits.length; i++) {
    const s = given[i] ?? '';
    if (s) {
      const r = signalArgRefusal(ctx, s, 'Bool', `signals[${i}]`);
      if (r) return { reason: r };
      signals.push(canonicalPath(ctx, nodeOf(ctx, s)!, s));
    } else {
      signals.push('');
    }
  }
  for (const bit of parsed.bits) {
    const name = bitChildName(bit);
    if (parent.children.some((c) => c.name === name)) return { reason: `${path} already has a child "${name}"` };
  }
  return {
    path: canonicalPath(ctx, parent, path),
    mode,
    word: canonicalPath(ctx, nodeOf(ctx, wordArg)!, wordArg),
    bits: parsed.bits,
    signals,
    width,
    signed: a?.signed === null || a?.signed === undefined ? true : a.signed === true,
    invert: a?.invert === true,
  };
}

export const signalConnectorCreateBitsImpl: CommandImpl<SignalConnectorCreateBitsArgs, SignalConnectorCreateBitsResult> = {
  enabled(ctx, a) {
    const lock = testRunRefusal(ctx);
    if (lock) return lock;
    const r = resolveBits(ctx, a);
    return 'reason' in r ? refuse(r.reason) : true;
  },
  resolveArgs(ctx, a) {
    const r = resolveBits(ctx, a);
    if ('reason' in r) return a;
    return {
      path: r.path, mode: r.mode, word: r.word, bits: r.bits.join(','), signals: r.signals,
      width: r.width, signed: r.signed, invert: r.invert,
    };
  },
  async run(ctx, a) {
    const r = resolveBits(ctx, a);
    if ('reason' in r) throw new CommandError(r.reason);
    const doc = docOf(ctx);
    const slots = bitModeSlots(r.mode);
    // The reference names the signal component the node actually carries (a word
    // read by BitFromWord may be a PLC input too — only the target direction is checked).
    const refOf = (path: string, slot: ConnectorSlot): Record<string, unknown> =>
      componentReference(path, (signalTypeOf(nodeOf(ctx, path)) ?? slotSignalType(slot)) as PlcSignalType);
    const wordRef = refOf(r.word, slots.word);
    const created: string[] = [];
    try {
      await doc.withTransaction(`Create ${r.bits.length} bit connector${r.bits.length === 1 ? '' : 's'}`, async () => {
        for (let i = 0; i < r.bits.length; i++) {
          const bit = r.bits[i];
          const child = await doc.createEmptyNode(r.path, bitChildName(bit));
          const fields: Record<string, unknown> = {
            ...getSchemaDefaults(SIGNAL_CONNECTOR_TYPE),
            Mode: r.mode,
            Enabled: true,
            Bit: bit,
            Width: r.width,
            Signed: r.signed,
            Invert: r.invert,
            [slots.word]: { ...wordRef },
          };
          if (r.signals[i]) fields[slots.bool] = refOf(r.signals[i], slots.bool);
          doc.addComponent(child, SIGNAL_CONNECTOR_TYPE, fields);
          created.push(child);
        }
      });
      await whenDocumentSettled(doc);
    } catch (e) {
      throw new CommandError(`Bit connectors not created - ${e instanceof Error ? e.message : String(e)}`, { path: r.path });
    }
    return { path: r.path, mode: r.mode, created, bits: r.bits };
  },
};

// ─── signalConnector.list ────────────────────────────────────────────────

export interface SignalConnectorListEntry {
  path: string;
  address: string;
  mode: SignalConnectorMode;
  enabled: boolean;
  active: boolean;
  source: { slot: string | null; path: string | null; signal: string | null; value: boolean | number | null };
  target: { slot: string | null; path: string | null; signal: string | null; value: boolean | number | null };
  bit?: number;
  width?: WordWidth;
  problems: string[];
}

/** Every SignalConnector of the loaded scene (optionally those at or below `path`). */
export function listSignalConnectors(ctx: CommandContext, filterPath?: string | null): {
  connectors: SignalConnectorListEntry[]; count: number;
} {
  const store = ctx.viewer.signalStore;
  if (!store) return { connectors: [], count: 0 };
  const net = signalConnectorNetworkFor(store);
  const codes = new Set<string>(Object.values(SIGNAL_CONNECTOR_PROBLEM_CODES));
  const problems = getProblems().filter((p) => codes.has(p.code));
  const prefix = String(filterPath ?? '').trim();
  const value = (path: string | null): boolean | number | null => {
    if (!path) return null;
    const v = store.getByPath(path);
    return typeof v === 'boolean' || typeof v === 'number' ? v : null;
  };
  const out: SignalConnectorListEntry[] = [];
  for (const c of net.connectors) {
    const path = c.nodePath;
    if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    const bitMode = c.Mode === 'BitFromWord' || c.Mode === 'BitToWord';
    out.push({
      path,
      address: c.instanceAddress,
      mode: c.Mode,
      enabled: c.Enabled,
      active: c.isActive,
      source: {
        slot: c.sourceSlot, path: c.sourcePath,
        signal: c.sourcePath ? store.nameForPath(c.sourcePath) ?? null : null, value: value(c.sourcePath),
      },
      target: {
        slot: c.targetSlot, path: c.targetPath,
        signal: c.targetPath ? store.nameForPath(c.targetPath) ?? null : null, value: value(c.targetPath),
      },
      ...(bitMode ? { bit: c.Bit, width: c.Width } : {}),
      problems: problems.filter((p) => p.id.endsWith(`:${c.instanceAddress}`)).map((p) => p.code),
    });
  }
  out.sort((x, y) => x.path.localeCompare(y.path));
  return { connectors: out, count: out.length };
}

export const signalConnectorListImpl: CommandImpl<{ path?: string | null }, ReturnType<typeof listSignalConnectors>> = {
  enabled: () => true,
  run: (ctx, a) => listSignalConnectors(ctx, a?.path),
};
