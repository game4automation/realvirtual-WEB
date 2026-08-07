// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * WebComponentPlugin — wires `WebComponent` script components (plan-210,
 * JS-in-GLB) into the live viewer.
 *
 * Deliberately a PLUGIN (onModelLoaded hook), NOT a scene-loader integration:
 * rv-scene-loader.ts stays untouched; `wireWebComponents()` traverses the
 * loaded root after the fact. The optional one-line loader integration can
 * follow later.
 *
 * Responsibilities:
 *  - Trust gate (§10, v1-minimal): script execution is OFF BY DEFAULT.
 *    Enable via the constructor option, `setAllowScripts(true)`, or the
 *    `?scripts` URL parameter (dev/testing). The phase-3 editor UI adds the
 *    per-model confirmation flow.
 *  - Lazily creates ONE shared `RVScriptHost` (QuickJS WASM) when the first
 *    model with script components is wired — no bundle/runtime cost otherwise.
 *  - Builds the `SdkEnvironment` per instance from the live viewer:
 *    NodeRegistry lookups (drive/sensor), SignalStore reads/writes/
 *    subscriptions, sensor edges via the `component-event` bus (emitted by
 *    SensorMonitorPlugin — no onChanged chaining).
 *  - Drives the continuous kernel: `tickAll` on onFixedUpdatePre (scripts set
 *    drive targets BEFORE drive physics), `lateTickAll` on onFixedUpdatePost.
 *  - Hot-reload API for the phase-3 editor: `reload(nodePath, code)` →
 *    registry reload (COLD swap) → `component-reloaded` viewer event; and
 *    `reloadOrCreate(nodePath, code)` which additionally mints an instance
 *    for a node that gained its script AFTER load (editor "add script").
 *  - Phase-3 editor UI: script editor panel ('overlay' slot) + toolbar entry
 *    ('button-group' slot) + an 'Edit Script' component action in the
 *    Property Inspector (componentActionRegistry — deliberately NOT wired
 *    into the inspector files themselves, they belong to a parallel
 *    workstream). Monaco loads lazily on first panel open.
 */

import { Code } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import { modeContext } from '../core/rv-mode-manager';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVDrive } from '../core/engine/rv-drive';
import type { RVSensor } from '../core/engine/rv-sensor';
import { createSignalWriter, type SignalStore } from '../core/engine/rv-signal-store';
import { RVScriptHost } from '../core/engine/rv-script-host';
import {
  RVWebComponentRegistry,
  computeWebComponentNodePath,
  countWebComponents,
  parseWebComponent,
  wireWebComponents,
  type WebComponentEnvFactory,
  type WebComponentInstance,
} from '../core/engine/rv-web-component-registry';
import type { SdkBeltTarget, SdkSensorTarget, SdkTransportTarget } from '../core/sdk/rv-sdk-self';
import { createSnapGraphPortsBackend } from '../core/sdk/rv-sdk-ports';
import { createLocalFlowBackend } from '../core/sdk/rv-sdk-flow';
import {
  createPathNetworkPathsBackend,
  createPathNetworkRoutingBackend,
} from '../core/sdk/rv-sdk-paths';
import { getConnectionSystem, type ConnectionReplyFn } from '../core/engine/rv-connection-registry';
import { getConnectionHolds } from '../core/engine/rv-connection-hold';
import { RV_ARRIVAL_HOOK, RV_CONN_REQ_HOOK } from '../core/sdk/rv-script-hook';
import type { RVMovingUnit } from '../core/engine/rv-mu';
import type { RVTransportSurface } from '../core/engine/rv-transport-surface';
import { isSurfaceOccupied } from '../behaviors/_shared/surface-occupancy';
import { StateStatistics } from '../core/material-flow/rv-state-statistics';
import { componentActionRegistry } from '../core/hmi/rv-component-action-registry';
import { WEB_COMPONENT_TYPE } from '../core/hmi/scene/rv-scene-edits';
import { ScriptEditorPanel } from '../core/hmi/script/ScriptEditorPanel';
import { ScriptToolbarButton } from '../core/hmi/script/ScriptToolbarButton';
import { openScriptEditor, resetScriptEditorStore } from '../core/hmi/script/script-editor-store';

export interface WebComponentPluginOptions {
  /** Trust gate (§10): create + run script instances. Default: false. */
  allowScripts?: boolean;
  /** Per host→VM call deadline in ms (default: script-host default, 5 ms). */
  callDeadlineMs?: number;
}

/** Guard: the component-action registry accumulates — register once per session. */
let actionRegistered = false;

/** Register the SDK-visible script error output with an explicit PLC type. */
export function ensureWebComponentErrorSignal(
  signals: SignalStore,
  nodeName: string,
  nodePath: string,
): string {
  const errorSignal = `${nodeName}.Error`;
  if (signals.getPath(errorSignal) === undefined) {
    signals.register(errorSignal, `${nodePath}/Error`, false, 'PLCInputBool');
  }
  return errorSignal;
}

export class WebComponentPlugin implements RVViewerPlugin {
  readonly id = 'web-component';

  /**
   * Editor UI: lazy Monaco panel (always registered as an overlay so the
   * 'Edit Script' component action can open it), plus a toolbar entry that is
   * only shown when scripting is enabled (`allowScripts` / `?scripts`). With
   * scripting off — the default for loaded models — the HMI shows no script
   * button.
   */
  readonly slots: UISlotEntry[];

  private viewer: RVViewer | null = null;
  private registry: RVWebComponentRegistry | null = null;
  private host: RVScriptHost | null = null;
  private hostPromise: Promise<RVScriptHost> | null = null;
  private allowScripts: boolean;
  private readonly callDeadlineMs?: number;
  private readonly unsubs: Array<() => void> = [];
  /** Live per-instance flow ledgers (reset on `simulation-reset`, plan-259). */
  private readonly liveFlows = new Set<{ reset(): void }>();
  /** Guards async wiring against a newer load/clear racing the WASM load. */
  private wireToken = 0;
  private lastLoad: { result: LoadResult; viewer: RVViewer } | null = null;

  constructor(opts: WebComponentPluginOptions = {}) {
    this.allowScripts = opts.allowScripts === true;
    this.callDeadlineMs = opts.callDeadlineMs;
    // The Monaco script editor is authoring — gone in the Viewer (plan-387 F4).
    // Gated per-entry rather than with a `modes` declaration on the plugin, for
    // two independent reasons:
    //  1. The script RUNTIME must keep working in the Viewer; this plugin is not
    //     `core`, so `modes` would disable it outright and stop user scripts.
    //  2. The `button-group` entry below carries a `visibilityId` but NO rule,
    //     so ButtonPanel currently hides it outside hmi for free. `modes` would
    //     compile a rule onto it and make it appear in DES/Planner/Editor —
    //     the F6 regression described in plan-387 §2.2a/B2.
    // SlotRenderer only applies a rule when a `visibilityId` is present, hence
    // the explicit id.
    this.slots = [{
      slot: 'overlay', component: ScriptEditorPanel, order: 97,
      visibilityId: 'script-editor-panel',
      visibilityRule: { hiddenIn: [modeContext('viewer')] },
    }];
    if (this.allowScripts) {
      this.slots.unshift({
        slot: 'button-group',
        component: ScriptToolbarButton,
        order: 62,
        visibilityId: 'script-editor',
      });
    }
  }

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.unsubs.push(
      viewer.on('simulation-reset', () => {
        this.registry?.resetAll();
        // Flow-ledger reset coupling (plan-259 §5.2): a restarted sim must not
        // see ghost MUs parked in a script component's ledger. The engine-side
        // holds/reply handles are reset by the ConnectionSystemPlugin.
        for (const flow of this.liveFlows) flow.reset();
      }),
    );
    this.registerEditScriptAction();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.lastLoad = { result, viewer };
    void this.wire(result, viewer);
  }

  onModelCleared(): void {
    this.wireToken++;               // cancels an in-flight async wire
    this.lastLoad = null;
    this.registry?.dispose();
    this.registry = null;
    resetScriptEditorStore();
  }

  onFixedUpdatePre(dt: number): void {
    this.registry?.tickAll(dt);
  }

  onFixedUpdatePost(dt: number): void {
    this.registry?.lateTickAll(dt);
  }

  dispose(): void {
    this.onModelCleared();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.host?.dispose();
    this.host = null;
    this.hostPromise = null;
  }

  // ── Public API (phase-3 editor / MCP) ──────────────────────────────────

  /** True when the trust gate allows script execution for loaded models. */
  get scriptsAllowed(): boolean {
    return this.allowScripts;
  }

  /**
   * Flips the trust gate. Enabling re-wires the current model's script
   * components; disabling disposes all running instances.
   */
  setAllowScripts(allow: boolean): void {
    if (this.allowScripts === allow) return;
    this.allowScripts = allow;
    this.registry?.dispose();
    this.registry = null;
    if (allow && this.lastLoad) {
      void this.wire(this.lastLoad.result, this.lastLoad.viewer);
    }
  }

  /** Live script instances (empty while the trust gate is closed). */
  get instances(): WebComponentInstance[] {
    return this.registry?.list() ?? [];
  }

  /**
   * Live script components + kernel adapters for the DES snapshot pipeline
   * (plan-261 B4). Resolved by the (private) DES runner via
   * `host.getPlugin('web-component')` — structural, public types only.
   */
  listScriptComponents(): Array<{ path: string; adapter: import('../core/sdk/rv-script-component-adapter').RVScriptComponentAdapter }> {
    return this.registry?.listScriptComponents() ?? [];
  }

  /** Hot-reload one component (§4.4): COLD swap, `component-reloaded` event. */
  reload(nodePath: string, jsCode: string): void {
    if (!this.registry) {
      console.warn('[web-component] reload ignored — scripting disabled or no model loaded');
      return;
    }
    this.registry.reload(nodePath, jsCode);
  }

  /**
   * Editor save sink (phase 3): reloads an existing instance, or MINTS one
   * for a node that gained its `WebComponent` after load (the editor's
   * "add script" path — `wireWebComponents` only ran at model load). Builds
   * the registry lazily when the model carried no scripts at load time.
   * Returns false when nothing could run (trust gate closed / no model /
   * node not found) — persistence via the setCode op is unaffected then.
   */
  async reloadOrCreate(nodePath: string, jsCode: string): Promise<boolean> {
    if (!this.allowScripts || !this.lastLoad) return false;
    const { result, viewer } = this.lastLoad;
    const registry = this.registry ?? await this.ensureRegistry(result, viewer);
    if (!registry) return false;
    if (registry.get(nodePath)) {
      registry.reload(nodePath, jsCode);
      return true;
    }
    // Newly scripted node: resolve it with the SAME path convention the
    // wiring uses, parse the materialised WebComponent entry (the setCode op
    // has already written Code into userData) and mint an instance.
    let node: (typeof result.root) | null = null;
    result.root.traverse((n) => {
      if (!node && computeWebComponentNodePath(n) === nodePath) node = n;
    });
    if (!node) {
      console.warn(`[web-component] reloadOrCreate('${nodePath}'): node not found in the loaded scene`);
      return false;
    }
    const raw = ((node as { userData?: Record<string, unknown> }).userData?.realvirtual as
      Record<string, unknown> | undefined)?.[WEB_COMPONENT_TYPE];
    const meta = parseWebComponent(raw) ?? parseWebComponent({})!;
    registry.create(nodePath, node, { ...meta, code: jsCode });
    viewer.emit('component-reloaded', { nodePath });
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async wire(result: LoadResult, viewer: RVViewer): Promise<void> {
    this.registry?.dispose();
    this.registry = null;

    const found = countWebComponents(result.root);
    if (found === 0) return;
    if (!this.allowScripts) {
      console.info(`[web-component] ${found} script component(s) in this model — execution disabled (trust gate, plan-210 §10). Enable via setAllowScripts(true) or ?scripts.`);
      return;
    }

    const registry = await this.ensureRegistry(result, viewer);
    if (!registry) return;

    const wired = wireWebComponents(result.root, registry, { allowScripts: true });
    if (wired.malformed > 0) {
      console.warn(`[web-component] ${wired.malformed} WebComponent entr${wired.malformed === 1 ? 'y' : 'ies'} failed the defensive parse and were skipped`);
    }
  }

  /**
   * Builds (or returns) the instance registry for the current load — shared
   * by the load-time wire and the editor's reloadOrCreate. Loads the QuickJS
   * WASM host lazily; a newer load/clear supersedes the async wait.
   */
  private async ensureRegistry(result: LoadResult, viewer: RVViewer): Promise<RVWebComponentRegistry | null> {
    if (this.registry) return this.registry;
    const token = ++this.wireToken;
    let host: RVScriptHost;
    try {
      host = await this.ensureHost();
    } catch (err) {
      console.warn('[web-component] QuickJS host failed to load — script components stay inactive:', err);
      return null;
    }
    if (token !== this.wireToken) return null;   // superseded by newer load/clear
    if (this.registry) return this.registry;     // a concurrent caller won

    const registry = new RVWebComponentRegistry({
      host,
      buildEnv: this.makeEnvFactory(result, viewer),
      callDeadlineMs: this.callDeadlineMs,
      emit: (event, data) => viewer.emit(event, data),
      onInstanceDisabled: (nodePath, reason) =>
        console.warn(`[web-component:${nodePath}] disabled: ${reason}`),
    });
    this.registry = registry;
    return registry;
  }

  /** 'Edit Script' action on WebComponent sections (Property Inspector) —
   *  non-invasive inspector entry via the componentActionRegistry. */
  private registerEditScriptAction(): void {
    if (actionRegistered) return;
    actionRegistered = true;
    componentActionRegistry.register(WEB_COMPONENT_TYPE, [
      {
        id: 'edit-script',
        label: 'Edit Script',
        icon: Code,
        tooltip: 'Open this component script in the editor',
        onClick: (ctx) => openScriptEditor(ctx.nodePath),
      },
    ]);
  }

  private ensureHost(): Promise<RVScriptHost> {
    if (this.host) return Promise.resolve(this.host);
    this.hostPromise ??= RVScriptHost.create().then((host) => {
      this.host = host;
      return host;
    });
    return this.hostPromise;
  }

  /** Live-viewer environment: NodeRegistry lookups + SignalStore + events. */
  private makeEnvFactory(result: LoadResult, viewer: RVViewer): WebComponentEnvFactory {
    const registry = result.registry;
    const signals = result.signalStore;

    /** Sensor edges arrive on the `component-event` bus (SensorMonitorPlugin
     *  emits `{componentType:'sensor', kind:'changed', path}` with the path
     *  expression below) — subscribing there avoids onChanged chaining. */
    const sensorEventPath = (s: RVSensor): string =>
      ((s.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string)
        ?? s.node.name;

    const makeSensorTarget = (s: RVSensor): SdkSensorTarget => {
      const eventPath = sensorEventPath(s);
      return {
        get occupied() { return s.occupied; },
        subscribe: (cb) => viewer.on('component-event', (e) => {
          if (e.componentType === 'sensor' && e.kind === 'changed' && e.path === eventPath) {
            // Second arg: the occupying MU value-ref (plan-259 sensor→MU
            // bridge) — additive, callbacks ignoring it are unaffected.
            const payload = e.payload as { occupied: boolean; mu?: { id: number; type?: string } | null };
            cb(payload.occupied, payload.mu ?? null);
          }
        }),
        node: s.node,
      };
    };

    /** Belt = the Drive on a transport node (attachBelt convention) plus the
     *  shared surface-occupancy read. */
    const makeBeltTarget = (p: string): SdkBeltTarget | null => {
      const drive = registry.getByPath<RVDrive>('Drive', p);
      if (!drive) return null;
      const beltNode = registry.getNode(p) ?? drive.node;
      return {
        run(forward: boolean) {
          drive.jogForward = forward;
          drive.jogBackward = false;
        },
        get occupied() { return beltNode ? isSurfaceOccupied(viewer, beltNode) : false; },
        get speed() { return drive.currentSpeed; },
        node: beltNode,
      };
    };

    const makeTransportTarget = (p: string): SdkTransportTarget | null => {
      const surface = registry.getByPath<RVTransportSurface>('TransportSurface', p);
      if (!surface) return null;
      return {
        get direction() {
          const d = surface.getWorldDirection();
          return { x: d.x, y: d.y, z: d.z };
        },
        get speed() { return surface.speed; },
        node: surface.node,
      };
    };

    return ({ nodePath, nodeName, node, props, scheduler, addTeardown }) => {
      const errorSignal = ensureWebComponentErrorSignal(signals, nodeName, nodePath);
      const signalWriter = createSignalWriter(
        signals,
        `sdk:web-component:${nodePath}`,
        'sdk',
        { slotContext: nodePath },
      );

      // ── Flow backend (plan-259 / plan-210 gap 1): a per-instance MU ledger
      // whose park/release seams drive the REAL transport hold — the same
      // owner-tagged mechanism StopOnExit uses (single-MU hold on
      // accumulating surfaces, belt stop otherwise).
      const holds = getConnectionHolds();
      const tmLookup = { muById: (id: number) => viewer.transportManager?.muById(id) ?? null };
      const flow = createLocalFlowBackend({
        onPark: (mu) => { holds.hold(mu.id, tmLookup); },
        onRelease: (mu) => { holds.release(mu.id); },
        nodeOf: (mu) => {
          const m = viewer.transportManager?.muById(mu.id);
          return m && !m.isInstanced ? (m as RVMovingUnit).node : null;
        },
      });

      // ── Connection endpoint (plan-259): this component is a TARGET.
      // Deliveries are scheduled on the instance's OWN event list (time = now,
      // FIFO) — deterministic, never re-entrant into the caller's tick.
      const connSystem = getConnectionSystem();
      const replyFns = new Map<number, ConnectionReplyFn>();
      let nextReplyId = 1;
      addTeardown(connSystem.registerEndpoint(nodePath, {
        onArrival: (mu) => {
          const ledger = flow.accept(mu);
          flow.park(ledger.id);   // idempotent — the engine hold is already in place
          scheduler.in(0, RV_ARRIVAL_HOOK, ledger, null);
        },
        onRequest: (topic, params, reply) => {
          const replyId = nextReplyId++;
          replyFns.set(replyId, reply);
          scheduler.in(0, RV_CONN_REQ_HOOK, null, { topic, params, replyId });
        },
      }));
      addTeardown(() => replyFns.clear());
      this.liveFlows.add(flow);
      addTeardown(() => this.liveFlows.delete(flow));

      // Per-instance statistics sink (plan-201 pattern of the library factory):
      // registered under the node path, unregistered on dispose.
      const mgr = viewer.statisticsManager;
      let stats: { output(n: number): void; cycleStart(): void; cycleEnd(): void; state(name: string): void } | undefined;
      if (mgr) {
        const s = new StateStatistics(() => viewer.simTime ?? 0);
        mgr.register(nodePath, s);
        addTeardown(() => mgr.unregister(nodePath));
        stats = {
          output: (n) => s.output(n),
          cycleStart: () => s.cycleStart(),
          cycleEnd: () => s.cycleEnd(),
          state: (name) => s.setState(name),
        };
      }

      return {
        name: nodeName,
        path: nodePath,
        node,
        props,
        resolveNode: (p) => registry.getNode(p),
        components: {
          drive: (p) => registry.getByPath<RVDrive>('Drive', p),
          sensor: (p) => {
            const s = registry.getByPath<RVSensor>('Sensor', p);
            return s ? makeSensorTarget(s) : null;
          },
          belt: makeBeltTarget,
          transport: makeTransportTarget,
        },
        componentsAll: {
          drive: () => registry.getAll<RVDrive>('Drive').map((e) => e.instance),
          sensor: () => registry.getAll<RVSensor>('Sensor').map((e) => makeSensorTarget(e.instance)),
        },
        // Topology ports (phase 1b): same snap-graph source the TS behaviors
        // use; interlock reads/writes via the global signal store.
        ports: createSnapGraphPortsBackend({
          viewer,
          root: node,
          signals: {
            get: (n) => signals.get(n),
            set: (n, v) => signalWriter.set(n, v),
          },
        }),
        // Path graph by id + routing hooks (plan-268 Phase 6): same shared
        // network/zone registry the Agv traffic control rides.
        paths: createPathNetworkPathsBackend(),
        routing: createPathNetworkRoutingBackend(nodePath),
        flow,
        connections: {
          call: (type, params, onReply) => connSystem.call(nodePath, type, params, onReply),
          reply: (replyId, response) => {
            const fn = replyFns.get(replyId);
            if (!fn) {
              console.warn(`[web-component:${nodePath}] reply(${replyId}) ignored — unknown or already-answered handle`);
              return;
            }
            replyFns.delete(replyId);
            fn(response);
          },
        },
        stats,
        occupied: (n) => isSurfaceOccupied(viewer, n),
        signals: {
          get: (n) => signals.get(n),
          set: (n, v) => signalWriter.set(n, v),
          subscribe: (n, cb) => signals.subscribe(n, cb),
        },
        scheduler,
        log: (...args: unknown[]) => console.log(`[WebComponent:${nodePath}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[WebComponent:${nodePath}]`, ...args),
        error: (...args: unknown[]) => console.error(`[WebComponent:${nodePath}]`, ...args),
      };
    };
  }
}
