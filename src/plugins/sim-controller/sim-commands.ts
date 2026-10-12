// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sim-commands — the RUNTIME commands (plan-499 Phase 3): simulation clock,
 * master speed, drive jog/stop and PLC signal writes.
 *
 * One definition per action, several views:
 *
 * | Command              | UI view                                   | MCP tool                  |
 * |----------------------|-------------------------------------------|---------------------------|
 * | `sim.playPause`      | Sim toolbar Play/Pause segment, Space     | `web_sim_play_pause`      |
 * | `sim.reset`          | Sim toolbar Reset segment, Shift+R        | `web_sim_reset`           |
 * | `sim.speedOverride`  | Sim toolbar speed menu (segment = anchor) | `web_drive_speed_override`|
 * | `drive.jog`          | Inspector Drive ▸ Jog + / Jog −           | `web_drive_jog`           |
 * | `drive.stop`         | Inspector Drive ▸ Stop                    | `web_drive_stop`          |
 * | `signal.setBool`     | Inspector PLC…Bool ▸ Toggle               | `web_signal_set_bool`     |
 * | `signal.setFloat`    | — (no numeric button primitive)           | `web_signal_set_float`    |
 *
 * Everything here is open and eager (the sim controller is a core plugin), so
 * the implementations are inline — no lazy private module. The rules are the
 * texts the tools answered before the migration (`Drive "X" not found`,
 * `Signal "X" not found`), so an agent sees exactly what it saw, and a button
 * shows the same text as its tooltip.
 *
 * Signal writes are attributed by ORIGIN: an MCP dispatch writes as the bridge
 * (`mcp-bridge` / `'mcp'`, unchanged from the tool), a click as the HMI.
 */

import type { Object3D } from 'three';
import { ArrowBack, ArrowForward, Stop, SwapVert } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVDrive } from '../../core/engine/rv-drive';
import {
  commandRegistry,
  CommandError,
  type CommandArgType,
  type CommandContext,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandOrigin,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import { USER_PAUSE_REASON } from '../../core/engine/rv-constants';
import { setDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
  type SignalWriterKind,
} from '../../core/engine/rv-signal-store';
import { isSignalComponentTypeKey, type NodeRegistry } from '../../core/engine/rv-node-registry';
import { getAssetReference, getPlacementMeta } from '../../core/engine/rv-asset-reference';
import { isNestedPlacementRoot } from '../../core/engine/rv-placement-instancer';
import {
  componentActionRegistry,
  type ComponentAction,
  type ComponentActionContext,
} from '../../core/hmi/rv-component-action-registry';

// ─── Args ───────────────────────────────────────────────────────────────

export interface PlayPauseArgs { readonly paused?: boolean | null }
export interface SpeedOverrideArgs { readonly factor?: number | null }
export interface DriveJogArgs { readonly name: string; readonly forward?: boolean | null }
export interface DriveNameArgs { readonly name: string }
export interface SignalSetArgs<V extends boolean | number> {
  readonly name: string;
  readonly value: V;
  /** Fan-out: write the signal named `name` in every placed instance of this asset (plan-757 F12). */
  readonly asset?: string | null;
}

// ─── Reasons (the pre-migration tool texts) ─────────────────────────────

export const NO_SIGNAL_STORE = 'No signal store available';
export const FACTOR_REQUIRED = 'factor is required to change the speed (omit it only to read the current value)';
export const driveNotFound = (name: string): string => `Drive "${name}" not found`;
/**
 * A jog only sets the drive's jog flags — the simulation step moves the axis.
 * In a mode that detaches the runtime (the asset editor while authoring) nothing
 * steps, so the click used to do nothing at all. Say why instead.
 */
export const JOG_NEEDS_RUNTIME =
  'The simulation is not running in this mode — start a test run to jog, or use Drive Test in Quick Edit';
export const signalNotFound = (name: string): string => `Signal "${name}" not found`;

// ─── Button keys (the ONE formula for views and bindings) ───────────────

export const SIM_PLAY_PAUSE_KEY = 'sim.play-pause';
export const SIM_RESET_KEY = 'sim.reset';
export const SIM_SPEED_KEY = 'sim.speed';
export const driveJogKey = (name: string, forward: boolean): string =>
  `drive.jog:${name}:${forward ? 'forward' : 'backward'}`;
export const driveStopKey = (name: string): string => `drive.stop:${name}`;
export const signalSetKey = (name: string): string => `signal.set:${name}`;

// ─── Signal writers (attribution by origin) ─────────────────────────────

/** Writer id of the bridge — unchanged from the tool, so the signal UI still says "mcp". */
const MCP_WRITER_ID = 'mcp-bridge';
const HMI_WRITER_ID = 'inspector-action';

const writers = new WeakMap<SignalStore, Map<SignalWriterKind, SignalWriter>>();

function writerFor(store: SignalStore, origin: CommandOrigin | undefined): SignalWriter {
  const kind: SignalWriterKind = origin === 'mcp' ? 'mcp' : 'hmi';
  let byKind = writers.get(store);
  if (!byKind) { byKind = new Map(); writers.set(store, byKind); }
  let w = byKind.get(kind);
  if (!w) {
    w = createSignalWriter(store, kind === 'mcp' ? MCP_WRITER_ID : HMI_WRITER_ID, kind);
    byKind.set(kind, w);
  }
  return w;
}

// ─── Fan-out (moved from rv-mcp-runtime-tools, plan-757 F12) ────────────

/** Last path segment without a `.glb`/`.gltf` extension — how a user names a file. */
function fileStem(id: string): string {
  const leaf = id.split(/[\\/]/).pop() ?? id;
  return leaf.replace(/\.(glb|gltf)$/i, '');
}

/**
 * Roots of every live PLACEMENT (non-identity instance) of `asset` (plan-757
 * F12): the reference's `assetId`, the placement's `catalogId`, the bake key,
 * its file stem or the asset's own root name — exact, case-sensitive. NESTED
 * instances (a reference inside a placed asset) are instances and are matched
 * like any other: `asset = <inner>` reaches every nested copy.
 */
export function placementRootsOfAsset(viewer: RVViewer, asset: string): Object3D[] {
  const wanted = asset.trim();
  const wantedStem = fileStem(wanted);
  const out: Object3D[] = [];
  for (const inst of viewer.bakeRegistry?.instances ?? []) {
    if (inst.identity || inst.released) continue;
    const root = inst.root;
    const candidates = [
      getAssetReference(root)?.assetId,
      getPlacementMeta(root)?.catalogId,
      inst.baked.assetId,
      inst.baked.template.name,
    ];
    const hit = candidates.some((c) => c && (c === wanted || fileStem(c) === wantedStem));
    if (hit) out.push(root);
  }
  return out;
}

/**
 * The registry path of the signal node named `name` inside `root`: a node
 * whose `PLC*` extras carry `Name === name`, or (no explicit name) whose node
 * name is `name`. The walk stops at a NESTED placement root: a signal of the
 * inner asset belongs to the inner instance and is addressed through it.
 */
export function signalPathInInstance(root: Object3D, name: string, registry: NodeRegistry, store: SignalStore): string | null {
  let found: string | null = null;
  const visitNode = (node: Object3D): void => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key in rv) {
      if (!isSignalComponentTypeKey(key)) continue;
      const data = rv[key] as { Name?: unknown } | undefined;
      const authored = typeof data?.Name === 'string' && data.Name.length > 0 ? data.Name : node.name;
      if (authored !== name) continue;
      const path = registry.getPathForNode(node);
      if (path && store.exactNameForPath(path) !== undefined) { found = path; return; }
    }
  };
  const visit = (node: Object3D): void => {
    if (found) return;
    if (node !== root && isNestedPlacementRoot(node)) return;
    visitNode(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

function fanOutSignal(ctx: CommandContext, name: string, value: boolean | number, asset: string): Record<string, unknown> {
  const viewer = ctx.viewer;
  const store = viewer.signalStore;
  const registry = viewer.registry;
  if (!store || !registry) throw new CommandError('No viewer');
  const roots = placementRootsOfAsset(viewer, asset);
  if (roots.length === 0) {
    throw new CommandError(`No placed instance of asset "${asset}" — match by AssetReference.assetId, PlacementMeta.catalogId, the bake key, its file name or the asset root name`);
  }
  const writer = writerFor(store, ctx.origin);
  const written: Array<{ root: string; path: string; previous: boolean | number | undefined }> = [];
  const missing: string[] = [];
  for (const root of roots) {
    const rootPath = registry.getPathForNode(root) ?? root.name;
    const path = signalPathInInstance(root, name, registry, store);
    if (!path) { missing.push(rootPath); continue; }
    const previous = store.getByPath(path);
    writer.setByPath(path, value);
    written.push({ root: rootPath, path, previous });
  }
  if (written.length === 0) {
    throw new CommandError(
      `Signal "${name}" exists in none of the ${roots.length} placed instance(s) of "${asset}"`,
      { instances: missing },
    );
  }
  return { name, value, previous: written[0].previous, asset, instances: roots.length, written, missing };
}

// ─── Implementations ────────────────────────────────────────────────────

const findDrive = (viewer: RVViewer, name: string): RVDrive | undefined =>
  (viewer.drives ?? []).find((d) => d.name === name);

const present = (v: unknown): boolean => v !== undefined && v !== null;

const playPause: CommandImpl<PlayPauseArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: (ctx, a) => {
    const v = ctx.viewer;
    const userPaused = v.simulationPauseReasons.includes(USER_PAUSE_REASON);
    const toggled = !present(a?.paused);
    const next = toggled ? !userPaused : a.paused === true;
    v.setSimulationPaused(USER_PAUSE_REASON, next);
    return {
      wasPaused: userPaused,
      toggled,
      paused: v.isSimulationPaused,
      userPaused: next,
      reasons: [...v.simulationPauseReasons],
    };
  },
};

const reset: CommandImpl<Record<string, never>, Record<string, unknown>> = {
  enabled: () => true,
  run: (ctx) => {
    const tm = ctx.viewer.transportManager;
    const before = { mus: tm?.mus.length ?? 0, totalSpawned: tm?.totalSpawned ?? 0 };
    ctx.viewer.resetSimulation();
    const tm2 = ctx.viewer.transportManager;
    return { before, after: { mus: tm2?.mus.length ?? 0, totalSpawned: tm2?.totalSpawned ?? 0 } };
  },
};

const speedOverride: CommandImpl<SpeedOverrideArgs, { factor: number }> = {
  enabled: (_ctx, a) => {
    if (!present(a?.factor)) return { reason: FACTOR_REQUIRED };
    if (typeof a.factor !== 'number' || !Number.isFinite(a.factor)) return { reason: 'factor must be a number' };
    return true;
  },
  run: (_ctx, a) => ({ factor: setDriveSpeedOverride(a.factor as number) }),
};

const driveJog: CommandImpl<DriveJogArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => {
    if (!findDrive(ctx.viewer, a?.name)) return { reason: driveNotFound(String(a?.name ?? '')) };
    return ctx.viewer.runtime?.isAttached === false ? { reason: JOG_NEEDS_RUNTIME } : true;
  },
  run: (ctx, a) => {
    const drive = findDrive(ctx.viewer, a.name) as RVDrive;
    const dir = a.forward !== false; // default: forward
    drive.jogForward = dir;
    drive.jogBackward = !dir;
    return { name: a.name, jogForward: dir, jogBackward: !dir };
  },
};

const driveStop: CommandImpl<DriveNameArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => (findDrive(ctx.viewer, a?.name) ? true : { reason: driveNotFound(String(a?.name ?? '')) }),
  run: (ctx, a) => {
    const drive = findDrive(ctx.viewer, a.name) as RVDrive;
    drive.jogForward = false;
    drive.jogBackward = false;
    drive.stop();
    return { name: a.name, stopped: true };
  },
};

function signalSet<V extends boolean | number>(): CommandImpl<SignalSetArgs<V>, Record<string, unknown>> {
  return {
    enabled: (ctx, a) => {
      const store = ctx.viewer.signalStore;
      if (!store) return { reason: NO_SIGNAL_STORE };
      // A fan-out resolves its instances while it writes (reasons with details).
      if (a?.asset) return true;
      return store.get(a?.name) === undefined ? { reason: signalNotFound(String(a?.name ?? '')) } : true;
    },
    run: (ctx, a) => {
      if (a.asset) return fanOutSignal(ctx, a.name, a.value, a.asset);
      const store = ctx.viewer.signalStore as SignalStore;
      const previous = store.get(a.name);
      writerFor(store, ctx.origin).set(a.name, a.value);
      return { name: a.name, value: a.value, previous };
    },
  };
}

// ─── Descriptors ────────────────────────────────────────────────────────

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly label: string | ((args: never) => string);
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly buttonKey: (args: never) => string;
  readonly shortcut?: string;
  readonly mcp: CommandMcpMirror;
  readonly impl: CommandImpl<never, unknown>;
}

const SPECS: readonly Spec[] = [
  {
    id: 'sim.playPause',
    label: (a: PlayPauseArgs) => (a?.paused === true ? 'Pause' : a?.paused === false ? 'Play' : 'Play/Pause'),
    argsSchema: { paused: 'boolean' }, shortcut: 'Space',
    buttonKey: () => SIM_PLAY_PAUSE_KEY,
    mcp: { tool: 'web_sim_play_pause', params: [opt('paused', 'boolean')] },
    impl: playPause as CommandImpl<never, unknown>,
  },
  {
    id: 'sim.reset', label: 'Reset simulation', argsSchema: {}, shortcut: 'Shift+R',
    buttonKey: () => SIM_RESET_KEY,
    mcp: { tool: 'web_sim_reset', params: [] },
    impl: reset as CommandImpl<never, unknown>,
  },
  {
    id: 'sim.speedOverride',
    label: (a: SpeedOverrideArgs) => (present(a?.factor) ? `Speed ${a.factor}×` : 'Speed override'),
    argsSchema: { factor: 'number' },
    buttonKey: () => SIM_SPEED_KEY,
    mcp: { tool: 'web_drive_speed_override', params: [opt('factor', 'number')] },
    impl: speedOverride as CommandImpl<never, unknown>,
  },
  {
    id: 'drive.jog',
    label: (a: DriveJogArgs) => (a?.forward === false ? 'Jog backward' : 'Jog forward'),
    argsSchema: { name: 'string', forward: 'boolean' },
    buttonKey: (a: DriveJogArgs) => driveJogKey(String(a?.name ?? ''), a?.forward !== false),
    mcp: { tool: 'web_drive_jog', params: [req('name'), opt('forward', 'boolean')] },
    impl: driveJog as CommandImpl<never, unknown>,
  },
  {
    id: 'drive.stop', label: 'Stop drive', argsSchema: { name: 'string' },
    buttonKey: (a: DriveNameArgs) => driveStopKey(String(a?.name ?? '')),
    mcp: { tool: 'web_drive_stop', params: [req('name')] },
    impl: driveStop as CommandImpl<never, unknown>,
  },
  {
    id: 'signal.setBool', label: 'Set signal', argsSchema: { name: 'string', value: 'boolean', asset: 'string' },
    buttonKey: (a: SignalSetArgs<boolean>) => signalSetKey(String(a?.name ?? '')),
    mcp: { tool: 'web_signal_set_bool', params: [req('name'), req('value', 'boolean'), opt('asset')] },
    impl: signalSet<boolean>() as CommandImpl<never, unknown>,
  },
  {
    id: 'signal.setFloat', label: 'Set signal', argsSchema: { name: 'string', value: 'number', asset: 'string' },
    buttonKey: (a: SignalSetArgs<number>) => signalSetKey(String(a?.name ?? '')),
    mcp: { tool: 'web_signal_set_float', params: [req('name'), req('value', 'number'), opt('asset')] },
    impl: signalSet<number>() as CommandImpl<never, unknown>,
  },
];

/** Every runtime command id (preload, tests). */
export const SIM_COMMAND_IDS: readonly string[] = SPECS.map((s) => s.id);

/** Build the runtime descriptors (testable seam: no registry side effect). */
export function createSimCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: false,
    ...(s.shortcut ? { shortcut: s.shortcut } : {}),
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    buttonKey: s.buttonKey,
    mcp: s.mcp,
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  }));
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the runtime commands. */
export function ensureSimCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createSimCommandDescriptors()) registry.register(d);
}

// ─── Inspector actions (ComponentAction.command) ────────────────────────

/** The runtime drive a Drive section belongs to (its node), or null. */
function driveOfNode(ctx: ComponentActionContext): RVDrive | null {
  return (ctx.viewer.drives ?? []).find((d) => d.node === ctx.node) ?? null;
}

/** The SignalStore name of a signal section's node, or null. */
function signalNameOfNode(ctx: ComponentActionContext): string | null {
  const store = ctx.viewer.signalStore;
  if (!store) return null;
  return store.exactNameForPath(ctx.nodePath) ?? store.nameForPath(ctx.nodePath) ?? null;
}

/**
 * A component action that is a VIEW of a command: the section renders it
 * through `useCommandView` (label from the action, reason/afterglow from the
 * command); `onClick` exists for programmatic callers and dispatches the SAME
 * command, so a click is exactly one `execute` either way.
 */
function commandAction(
  spec: Omit<ComponentAction, 'onClick' | 'command'>,
  id: string,
  args: (ctx: ComponentActionContext) => unknown,
): ComponentAction {
  return {
    ...spec,
    command: { id, args },
    onClick: (ctx) => {
      void commandRegistry.execute(id, args(ctx), { origin: 'ui', viewer: ctx.viewer });
    },
  };
}

let actionsRegistered = false;

/** Register the Drive Jog/Stop and signal Toggle inspector actions (idempotent). */
export function registerRuntimeInspectorActions(): void {
  if (actionsRegistered) return;
  actionsRegistered = true;
  const driveName = (ctx: ComponentActionContext): string => driveOfNode(ctx)?.name ?? ctx.node.name;
  const hasDrive = (ctx: ComponentActionContext): boolean => driveOfNode(ctx) !== null;
  componentActionRegistry.register('Drive', [
    commandAction(
      { id: 'jog-backward', label: 'Jog −', icon: ArrowBack, tooltip: 'Jog the drive backward', order: 10, visible: hasDrive,
        group: 'jog', isActive: (ctx) => driveOfNode(ctx)?.jogBackward === true },
      'drive.jog', (ctx) => ({ name: driveName(ctx), forward: false }),
    ),
    // Stop sits BETWEEN the two jog directions — one segmented control, like a jog pendant.
    commandAction(
      { id: 'stop', label: 'Stop', icon: Stop, tooltip: 'Stop the drive (clears jog)', order: 11, visible: hasDrive, group: 'jog' },
      'drive.stop', (ctx) => ({ name: driveName(ctx) }),
    ),
    commandAction(
      { id: 'jog-forward', label: 'Jog +', icon: ArrowForward, tooltip: 'Jog the drive forward', order: 12, visible: hasDrive,
        group: 'jog', isActive: (ctx) => driveOfNode(ctx)?.jogForward === true },
      'drive.jog', (ctx) => ({ name: driveName(ctx), forward: true }),
    ),
  ]);
  const boolToggle = commandAction(
    {
      id: 'toggle', label: (ctx) => (ctx.viewer.signalStore?.get(signalNameOfNode(ctx) ?? '') === true ? 'Set FALSE' : 'Set TRUE'),
      icon: SwapVert, tooltip: 'Write the opposite value into the signal', order: 10,
      visible: (ctx) => signalNameOfNode(ctx) !== null,
      isActive: (ctx) => ctx.viewer.signalStore?.get(signalNameOfNode(ctx) ?? '') === true,
    },
    'signal.setBool',
    (ctx) => {
      const name = signalNameOfNode(ctx) ?? ctx.node.name;
      return { name, value: ctx.viewer.signalStore?.get(name) !== true, asset: null };
    },
  );
  componentActionRegistry.register('PLCOutputBool', [boolToggle]);
  componentActionRegistry.register('PLCInputBool', [boolToggle]);
}
