// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProcessIndustryPlugin — Demo life for the DemoProcessIndustry scene.
 *
 * Discovers all RVPipe/RVTank/RVPump instances on model load and animates them:
 *  - Each tank's capacity is overwritten with the volume of its vessel-mesh
 *    world-space bounding box (in liters; 1 m³ = 1000 L) so differently-sized
 *    tanks get proportional capacities instead of the uniform GLB-authored value.
 *    The current fill ratio is preserved.
 *  - Each pipe runs its OWN flip schedule on a random interval
 *    (PIPE_FLIP_MIN_S…PIPE_FLIP_MAX_S seconds). On each flip, 85% chance the pipe
 *    gets a random flow magnitude in [PIPE_FLOW_MIN_LPM, PIPE_FLOW_MAX_LPM] L/min
 *    (direction randomized), 15% chance it stops (flowRate = 0).
 *  - Every frame, pipes with non-zero flow transfer fluid from source tank to
 *    destination tank (reverse for negative flow). Flow is stored as L/min and
 *    converted to L/s (× 1/60) for per-tick transfer. Endpoints are pre-resolved
 *    from the pipe's GLB source/destination ComponentRefs. Transfers are
 *    clamped to available source amount and destination free capacity.
 *  - On a separate global scheduler: occasionally toggles a random pump and
 *    reshuffles fluid assignments across tanks + pipes.
 *
 * Materials: fluid templates are allocated once and cloned per pipe so changing
 * one pipe's emissive glow never visually affects another pipe that happens to
 * carry the same fluid. "Flowing" pipes use a fixed bright emissive (ON_EMISSIVE)
 * so on/off is unambiguous regardless of flow magnitude.
 */

import { Box3, FrontSide, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import { RVPipe } from '../core/engine/rv-pipe';
import { RVTank } from '../core/engine/rv-tank';
import { RVPump } from '../core/engine/rv-pump';
import { RVProcessingUnit } from '../core/engine/rv-processing-unit';
import { NodeRegistry } from '../core/engine/rv-node-registry';
import { tooltipStore } from '../core/hmi/tooltip/tooltip-store';
import { ISOLATE_FOCUS_LAYER } from '../core/engine/rv-group-registry';

interface FluidDef {
  name: string;
  color: number;
  emissive: number;
  /** Density in kg/m³ (typical for this medium). 0 = unknown. */
  density: number;
  /** Nominal storage temperature °C. */
  temperature: number;
  /** pH value, or 0 when not measured / N/A for non-aqueous solvents. */
  ph: number;
}

// Paint / coatings / resin plant palette — spans raw solvents & resins →
// intermediates → finished products → recycled solvent. Must stay in sync
// with RESOURCE_COLORS in tank-fill-history-plugin.tsx so the 3-D pipe
// color matches the trend-line color for every medium.
// Dusty-pastel palette (MUI 300 shades) — deeper and more saturated than
// baby-pastel 100/200 while still reading as soft. Emissive steps up one
// more notch (MUI 400) so the flow glow is clearly visible against the
// mesh color without destroying the muted feel.
const FLUIDS: ReadonlyArray<FluidDef> = [
  { name: 'Xylene',            color: 0x9575CD, emissive: 0x7E57C2, density:  860, temperature: 22, ph: 0    }, // dusty lavender
  { name: 'MEK',               color: 0x4FC3F7, emissive: 0x29B6F6, density:  805, temperature: 20, ph: 0    }, // dusty sky
  { name: 'Epoxy Resin',       color: 0xFFAB91, emissive: 0xFF8A65, density: 1150, temperature: 28, ph: 7.2  }, // dusty coral
  { name: 'Pigment Paste',     color: 0xF48FB1, emissive: 0xF06292, density: 1400, temperature: 26, ph: 8.4  }, // dusty rose
  { name: 'Automotive Paint',  color: 0x7986CB, emissive: 0x5C6BC0, density: 1100, temperature: 24, ph: 8.0  }, // dusty periwinkle
  { name: 'Wood Varnish',      color: 0xA1887F, emissive: 0x8D6E63, density:  950, temperature: 23, ph: 0    }, // dusty taupe
  { name: 'Recovered Solvent', color: 0x4DB6AC, emissive: 0x26A69A, density:  820, temperature: 30, ph: 0    }, // dusty teal
];

/** Seconds between consecutive flip decisions on a given pipe. Wide range
 *  avoids a twitchy look while still giving users something to watch change. */
const PIPE_FLIP_MIN_S = 8;
const PIPE_FLIP_MAX_S = 25;

/** Random flow magnitude range when a pipe is set to "on", in liters / minute. */
const PIPE_FLOW_MIN_LPM = 10000;
const PIPE_FLOW_MAX_LPM = 100000;

/** Convert liters-per-minute (the unit flowRate is stored in) to liters-per-second
 *  for the fluid transfer math — `transfer = (flowRate/60) * dt`. */
const LPM_TO_LPS = 1 / 60;

function randomFlowMagnitude(): number {
  return PIPE_FLOW_MIN_LPM + Math.random() * (PIPE_FLOW_MAX_LPM - PIPE_FLOW_MIN_LPM);
}

/** Lerp an RGB color toward white by `amount` (0–1). Used to brighten the
 *  surface-ring so it pops against the darker liquid fill. */
function brighten(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const br = Math.round(r + (255 - r) * amount);
  const bg = Math.round(g + (255 - g) * amount);
  const bb = Math.round(b + (255 - b) * amount);
  return (br << 16) | (bg << 8) | bb;
}

/** Random delay in [PIPE_FLIP_MIN_S, PIPE_FLIP_MAX_S]. */
function nextFlipDelay(): number {
  return PIPE_FLIP_MIN_S + Math.random() * (PIPE_FLIP_MAX_S - PIPE_FLIP_MIN_S);
}

/** Fixed seed for the deterministic initial fluid assignment. Changing this
 *  is the only way to shuffle which medium a given tank/pipe network starts
 *  with — useful for demos / screenshots / reproducible bug reports. */
const INITIAL_FLUID_SEED = 0x9e3779b9;

/** Mulberry32 — small-state, good-quality seeded RNG. Returns a function
 *  that yields uniform values in [0, 1). Used only for the one-shot initial
 *  fluid assignment so periodic reshuffles can stay `Math.random()`-driven
 *  and keep the scene feeling alive. */
function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ProcessIndustryPlugin implements RVViewerPlugin {
  readonly id = 'processindustry';
  readonly order = 150;

  private pipes: RVPipe[] = [];
  private tanks: RVTank[] = [];
  private pumps: RVPump[] = [];
  private processingUnits: RVProcessingUnit[] = [];

  /** Per-pump stable "nominal" values. Drift is applied around these so the
   *  tooltip isn't purely random between frames. Index-parallel to `pumps`. */
  private pumpNominals: Array<{
    suctionP: number;        // bar
    dischargeP: number;      // bar at nominal flow
    ratedFlowLpm: number;    // l/min at 100 %
    ratedSpeedRpm: number;
    ratedPowerKw: number;
    ratedCurrentA: number;
    bearingTempC: number;
    motorTempC: number;
    vibrationMmS: number;
    npshA: number;
    npshR: number;
    runHours: number;
  }> = [];

  /** Per-tank stable "nominal" values (temp / pressure / limits / switches). */
  private tankNominals: Array<{
    nominalTempC: number;
    nominalPressure: number;
    tempHighLimit: number;
    tempLowLimit: number;
    pressureHighLimit: number;
    heaterOn: boolean;
    agitatorOn: boolean;
    ph: number;          // 0 = not measured
    density: number;     // kg/m³
  }> = [];

  /** Per-pipe stable nominal DN size + line temperature. Flow velocity is
   *  derived from the live flowRate each frame. */
  private pipeNominals: Array<{ dnSize: number; temperatureC: number; pressure: number }> = [];

  /** Per-PU stable nominal OEE / MTBF / MTTR / cycle target. */
  private puNominals: Array<{
    availability: number;
    performance: number;
    quality: number;
    cycleTargetS: number;
    mtbfHours: number;
    mttrMinutes: number;
    runHoursBase: number;
    downHoursBase: number;
    goodBase: number;
    scrapBase: number;
  }> = [];

  /** Leaf-name → tanks/pipes with that exact leaf. Used as a fallback when a
   *  ComponentReference path doesn't resolve via the NodeRegistry, which
   *  happens when Three.js's GLTFLoader dedups sibling names (e.g. "Tanks" →
   *  "Tanks_6") so the path recorded by the Unity exporter no longer appears
   *  as a suffix of the registered path. Leaf names for tanks/pipes in the
   *  realvirtual exporter are typically unique hashes. */
  private tanksByLeaf = new Map<string, RVTank[]>();
  private pipesByLeaf = new Map<string, RVPipe[]>();
  /** Pre-resolved tank endpoints per pipe (parallel to `pipes`). A null slot
   *  means that endpoint is not a tank (e.g. a Pump or ProcessingUnit) or the
   *  pipe has no declared source/destination. Positive flow transfers from
   *  `source` to `destination`; negative flow transfers the opposite way. */
  private pipeEndpoints: Array<{ source: RVTank | null; destination: RVTank | null }> = [];

  /** Connected tank+pipe+pump subgraphs discovered at load time. Edges follow
   *  pipe↔tank and pipe↔pipe references plus pump↔pipe via the pump's `pipe`
   *  reference; ProcessingUnits remain barriers. Every member of a subgraph is
   *  assigned the SAME fluid so the contents of a physically connected piping
   *  network are coherent instead of randomly mixed. */
  private fluidSubgraphs: Array<{ tanks: RVTank[]; pipes: RVPipe[]; pumps: RVPump[] }> = [];

  /** Cached original materials per pipe node so we can restore on unload. */
  private originalMaterials = new Map<Mesh, MeshStandardMaterial | MeshStandardMaterial[] | unknown>();
  /** Template materials per fluid — cloned per pipe so emissive changes on one pipe
   *  don't visually affect other pipes sharing the same fluid. */
  private fluidTemplates = new Map<string, MeshStandardMaterial>();
  /** Per-pipe cloned fluid material. Keyed by pipe instance. */
  private pipeFluidMaterials = new Map<RVPipe, MeshStandardMaterial>();
  /** Tracks which fluid each pipe's cloned material currently represents, so we can
   *  re-clone when the pipe's resource changes. */
  private pipeMaterialFluid = new Map<RVPipe, string>();
  private idleMaterial: MeshStandardMaterial | null = null;

  /** Fixed emissive intensity used when a pipe is flowing — bright enough that
   *  "on" is visually obvious regardless of flow magnitude. */
  private static readonly ON_EMISSIVE = 0.8;

  /** Whether pipe AND tank meshes should be recolored by their fluid. When
   *  false, both keep their authored GLB materials. Toggled at runtime via
   *  `setColoringEnabled()` — typically from ColoringPlugin. */
  private coloringEnabled = false;

  /** Cached viewer reference so setColoringEnabled can reach the
   *  PipeFlowManager to recolor the scrolling rings alongside the meshes. */
  private viewer: RVViewer | null = null;

  /** Fluid name → base color map, built from FLUIDS at load time. Used to
   *  recolor the mesh material, the PipeFlow ring overlay, and the tank
   *  fill overlay (the latter brightened via `brighten()`). */
  private fluidColorByName = new Map<string, number>();

  private tAccum = 0;
  /** Per-pipe next-flip time (parallel to `pipes` array). Each pipe flips on its
   *  own random schedule between PIPE_FLIP_MIN_S and PIPE_FLIP_MAX_S seconds. */
  private pipeNextFlip: number[] = [];
  /** Next time the pump-toggle / fluid-reshuffle scheduler fires. */
  private tNextGlobal = 0;

  // ─── Public API ─────────────────────────────────────────────────────

  /** Live tank list. Sibling plugins (e.g. TankFillHistoryPlugin) consume this
   *  to avoid re-traversing the scene — one discovery pass, one source of truth. */
  getTanks(): readonly RVTank[] { return this.tanks; }

  /** Whether pipe and tank meshes are currently recolored by fluid. Default
   *  is false so the scene shows the authored GLB materials until the user
   *  opts in. */
  isColoringEnabled(): boolean { return this.coloringEnabled; }

  /** Component types isolated together when coloring is enabled. Matches the
   *  NodeRegistry keys used by the auto-filter registry (Tank is the short
   *  alias; ResourceTank is the GLB extras key). */
  private static readonly ISOLATED_TYPES: readonly string[] = ['Tank', 'Pipe', 'Pump', 'ProcessingUnit'];

  /** Toggle fluid recoloring for pipes and tanks. When switching on, every
   *  pipe is repainted, tank fill overlays are retinted, AND the scene is
   *  focused on the pumping plant (pipes + tanks + pumps + processing units
   *  isolated via the AutoFilterRegistry so the rest of the plant dims to the
   *  backdrop layer). When switching off, materials and fill colors are
   *  restored and the isolation is cleared. Idempotent. */
  setColoringEnabled(enabled: boolean): void {
    if (this.coloringEnabled === enabled) return;
    this.coloringEnabled = enabled;
    if (enabled) {
      for (const pipe of this.pipes) this.applyFlowMaterial(pipe);
      for (const tank of this.tanks) this.applyTankMaterial(tank);
      for (const pump of this.pumps) this.applyPumpMaterial(pump);
      // Isolate the pumping plant so the rest of the scene dims away.
      this.viewer?.autoFilters?.isolateMultiple(ProcessIndustryPlugin.ISOLATED_TYPES);
    } else {
      for (const [mesh, original] of this.originalMaterials) {
        mesh.material = original as Mesh['material'];
      }
      this.viewer?.pipeFlowManager?.resetAllRingColors();
      this.viewer?.tankFillManager?.resetAllFillColors();
      // Clear the plant isolation — but only if WE are the active isolator.
      // If the user switched to a different filter via the Groups overlay in
      // the meantime, leave their choice alone.
      if (this.viewer?.autoFilters?.isMultiIsolateActive) {
        this.viewer.autoFilters.showAll();
      }
    }
  }

  /** Tooltip-store ID prefix for the PU-mode pinned tooltips. Distinct from
   *  the selection-driven pin id so a normal Click → Select doesn't collide. */
  private static readonly PU_MODE_TOOLTIP_PREFIX = 'pu-mode:processing-unit:';

  /** Whether processing-unit mode is currently active. Independent of color
   *  mode — both can be on at the same time. */
  private puModeEnabled = false;

  /** Active set of node paths whose pinned tooltips were opened by PU mode.
   *  Tracked so toggle-off only hides the entries WE created, never anything
   *  the user pinned manually. */
  private puModePinnedPaths: string[] = [];

  /** White-wash highlight overlay meshes added under each PU while PU mode
   *  is on. Stored per-PU so we can dispose+remove them cleanly on toggle off. */
  private puHighlightOverlays = new Map<RVProcessingUnit, Mesh[]>();

  /** Shared white transparent material for PU highlights — single instance
   *  across all PUs (no per-mesh state to mutate). */
  private puHighlightMaterial: MeshBasicMaterial | null = null;

  /** Toggle "Processing Unit Mode" — when on, opens a pinned tooltip on every
   *  ProcessingUnit so all OEE / cycle data is visible at a glance without the
   *  user having to hover or click each unit. Idempotent. Off restores only
   *  the entries opened by this plugin. */
  setProcessingUnitModeEnabled(enabled: boolean): void {
    if (this.puModeEnabled === enabled) return;
    this.puModeEnabled = enabled;
    if (enabled) {
      this.puModePinnedPaths = [];
      for (const pu of this.processingUnits) {
        const path = NodeRegistry.computeNodePath(pu.node);
        if (!path) continue;
        const id = ProcessIndustryPlugin.PU_MODE_TOOLTIP_PREFIX + path;
        tooltipStore.show({
          id,
          lifecycle: 'pinned',
          targetPath: path,
          data: { type: 'processing-unit', nodePath: path },
          mode: 'world',
          worldTarget: pu.node,
          priority: 5,
        });
        this.puModePinnedPaths.push(path);
        this.addPuHighlight(pu);
      }
    } else {
      for (const path of this.puModePinnedPaths) {
        tooltipStore.hide(ProcessIndustryPlugin.PU_MODE_TOOLTIP_PREFIX + path);
      }
      this.puModePinnedPaths = [];
      this.clearAllPuHighlights();
    }
  }

  /** Build the shared PU highlight material on first use. White, semi-transparent,
   *  rendered slightly in front of the source mesh via polygon offset so it
   *  doesn't z-fight. ISOLATE_FOCUS_LAYER is enabled at mesh creation so the
   *  highlight stays bright in pass 3 of isolate mode. */
  private getPuHighlightMaterial(): MeshBasicMaterial {
    if (this.puHighlightMaterial) return this.puHighlightMaterial;
    this.puHighlightMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.28,
      side: FrontSide,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    });
    return this.puHighlightMaterial;
  }

  /** Add a white-wash highlight overlay to every visible mesh under a PU. */
  private addPuHighlight(pu: RVProcessingUnit): void {
    if (this.puHighlightOverlays.has(pu)) return; // idempotent
    const mat = this.getPuHighlightMaterial();
    const overlays: Mesh[] = [];
    pu.node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      // Skip overlays we (or sibling managers) added so we don't recurse.
      if (mesh.userData._puHighlightViz) return;
      if (mesh.userData._tankFillViz || mesh.userData._pipeFlowViz) return;
      const overlay = new Mesh(mesh.geometry, mat);
      overlay.name = `${mesh.name}_puHighlight`;
      overlay.userData._puHighlightViz = true;
      overlay.userData._tankFillViz = true; // exclude from raycast + static merge
      overlay.position.copy(mesh.position);
      overlay.quaternion.copy(mesh.quaternion);
      overlay.scale.copy(mesh.scale);
      overlay.renderOrder = 3;
      // Visible in isolation pass 3 (focus pass) so it pops in color/PU mode.
      overlay.layers.enable(ISOLATE_FOCUS_LAYER);
      mesh.parent?.add(overlay);
      overlays.push(overlay);
    });
    this.puHighlightOverlays.set(pu, overlays);
  }

  /** Remove all PU highlight overlays and dispose the shared material. */
  private clearAllPuHighlights(): void {
    for (const overlays of this.puHighlightOverlays.values()) {
      for (const o of overlays) o.parent?.remove(o);
    }
    this.puHighlightOverlays.clear();
    this.puHighlightMaterial?.dispose();
    this.puHighlightMaterial = null;
  }

  /** Whether processing-unit mode is currently active. */
  isProcessingUnitModeEnabled(): boolean { return this.puModeEnabled; }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    // Discover instances via the _rvComponentInstance attached by the class constructors.
    viewer.scene.traverse((n) => {
      const inst = n.userData._rvComponentInstance;
      if (inst instanceof RVPipe) this.pipes.push(inst);
      else if (inst instanceof RVTank) this.tanks.push(inst);
      else if (inst instanceof RVPump) this.pumps.push(inst);
      else if (inst instanceof RVProcessingUnit) this.processingUnits.push(inst);
    });

    // Build leaf-name → instance indexes. Used as a fallback when the
    // NodeRegistry path lookup fails because Three.js deduped sibling names.
    this.tanksByLeaf.clear();
    this.pipesByLeaf.clear();
    for (const tank of this.tanks) {
      const leaf = tank.node.name;
      const arr = this.tanksByLeaf.get(leaf) ?? [];
      arr.push(tank);
      this.tanksByLeaf.set(leaf, arr);
    }
    for (const pipe of this.pipes) {
      const leaf = pipe.node.name;
      const arr = this.pipesByLeaf.get(leaf) ?? [];
      arr.push(pipe);
      this.pipesByLeaf.set(leaf, arr);
    }

    // Cache viewer so setPipeColoringEnabled can reach the PipeFlowManager.
    this.viewer = viewer;

    // Pre-allocate fluid template materials once. Cloned per pipe on first use.
    // Also build a name→color map so the flow-ring overlay can be tinted to
    // match the fluid independent of the mesh material.
    this.fluidColorByName.clear();
    for (const f of FLUIDS) {
      this.fluidTemplates.set(f.name, new MeshStandardMaterial({
        color: f.color,
        emissive: f.emissive,
        emissiveIntensity: ProcessIndustryPlugin.ON_EMISSIVE,
        metalness: 0.3,
        roughness: 0.4,
      }));
      this.fluidColorByName.set(f.name, f.color);
    }
    this.idleMaterial = new MeshStandardMaterial({
      color: 0x9e9e9e,
      roughness: 0.6,
      metalness: 0.1,
    });

    // Approximate each tank's capacity from its world-space bounding box volume
    // so tanks with different sizes get proportional capacities. 1 m³ = 1000 L.
    this.assignTankCapacitiesFromBounds();

    // Give every pipe a random initial flip time so they don't all change at once.
    this.pipeNextFlip = this.pipes.map(() => nextFlipDelay());

    // Pre-resolve each pipe's source/destination into RVTank instances (or null).
    // Mirrors Unity's PipelineController.FindTank:
    //   1. Direct endpoint is a Tank → use it.
    //   2. Direct endpoint is another Pipe → walk one hop and return whichever of
    //      THAT pipe's source/destination is a Tank.
    //   3. Endpoint is a ProcessingUnit (or missing) → null (fluid doesn't
    //      transfer through PUs; Unity does the same).
    this.pipeEndpoints = this.pipes.map((pipe) => ({
      source: this.resolveTankForEndpoint(viewer, pipe.sourcePath, pipe),
      destination: this.resolveTankForEndpoint(viewer, pipe.destinationPath, pipe),
    }));

    // Report endpoint-resolution quality.
    let bothResolved = 0, oneResolved = 0, noRefs = 0, refsButNoTank = 0;
    for (let i = 0; i < this.pipes.length; i++) {
      const pipe = this.pipes[i];
      const ep = this.pipeEndpoints[i];
      const hasSrcRef = pipe.sourcePath !== null;
      const hasDstRef = pipe.destinationPath !== null;
      const resolved = (ep.source ? 1 : 0) + (ep.destination ? 1 : 0);

      if (!hasSrcRef && !hasDstRef) { noRefs++; continue; }
      if (resolved === 2) { bothResolved++; continue; }
      if (resolved === 1) { oneResolved++; continue; }
      refsButNoTank++;
      console.warn(
        `[ProcessIndustryPlugin] Pipe "${pipe.node.name}" refs did not resolve to tanks:\n` +
        `  source="${pipe.sourcePath}" → ${this.describeRef(viewer, pipe.sourcePath)}\n` +
        `  destination="${pipe.destinationPath}" → ${this.describeRef(viewer, pipe.destinationPath)}`,
      );
    }
    console.log(
      `[ProcessIndustryPlugin] Pipe endpoints: ${bothResolved} both-tanks, ` +
      `${oneResolved} one-tank, ${refsButNoTank} refs-but-no-tank, ` +
      `${noRefs} no-refs (of ${this.pipes.length} total)`,
    );

    // Discover connected subgraphs of tanks+pipes so we can assign a coherent
    // medium to each physically connected network (instead of randomly mixing
    // Xylene and Pigment Paste on the same two tanks that share a pipe).
    this.buildFluidSubgraphs(viewer);

    // Assign a fluid per subgraph — all tanks and pipes in the same
    // subgraph end up with the same resourceName. Uses a SEEDED RNG so every
    // run of the viewer shows the same initial medium per network; periodic
    // reshuffles below still use Math.random for live variety.
    this.reassignFluids(makeSeededRng(INITIAL_FLUID_SEED));

    // Kick-start: every pipe starts flowing at load so no pipe shows flow=0
    // during the window before its first scheduled flip.
    for (const pipe of this.pipes) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      pipe.setFlow(dir * randomFlowMagnitude());
      this.applyFlowMaterial(pipe);
    }

    // Populate simulated industrial instrumentation so the enriched tooltips
    // actually show data in standalone mode (pressure/temp/vibration/OEE/…).
    this.initInstrumentation();
  }

  onFixedUpdatePost(dt: number): void {
    this.tAccum += dt;

    // (a) Per-pipe independent flips — every pipe runs its own 1–4 s schedule
    //     so ALL pipes are seen being switched on and off over time.
    for (let i = 0; i < this.pipes.length; i++) {
      if (this.tAccum < this.pipeNextFlip[i]) continue;
      const pipe = this.pipes[i];
      if (Math.random() < 0.15) {
        pipe.setFlow(0);
      } else {
        const dir = Math.random() < 0.5 ? -1 : 1;
        pipe.setFlow(dir * randomFlowMagnitude());
      }
      this.applyFlowMaterial(pipe);
      this.pipeNextFlip[i] = this.tAccum + nextFlipDelay();
    }

    // (a1) Drift industrial instrumentation every tick so temps / vibration /
    //      OEE values gently vary. Cheap — a few trig ops per instance.
    this.updateInstrumentation(dt);

    // (a2) Fluid transfer — runs every frame so tank levels evolve continuously
    //      while a pipe is on, not just at flip moments.
    this.transferFluids(dt);

    // (b) Global scheduler (pumps + fluid reshuffle) — same cadence as pipe flips.
    if (this.tAccum < this.tNextGlobal) return;
    this.tNextGlobal = this.tAccum + nextFlipDelay();

    if (this.pumps.length > 0 && Math.random() < 0.3) {
      const pump = this.pumps[Math.floor(Math.random() * this.pumps.length)];
      if (pump.isRunning) pump.stop();
      else pump.start(20 + Math.random() * 30);
    }

    if (Math.random() < 0.1) this.reassignFluids();
  }

  onModelCleared(_viewer: RVViewer): void {
    // Restore original materials so switching models back to the plant later is clean.
    for (const [mesh, original] of this.originalMaterials) {
      mesh.material = original as Mesh['material'];
    }
    this.originalMaterials.clear();

    for (const m of this.pipeFluidMaterials.values()) m.dispose();
    this.pipeFluidMaterials.clear();
    this.pipeMaterialFluid.clear();
    for (const m of this.fluidTemplates.values()) m.dispose();
    this.fluidTemplates.clear();
    this.idleMaterial?.dispose();
    this.idleMaterial = null;

    this.pipes = [];
    this.tanks = [];
    this.pumps = [];
    this.processingUnits = [];
    this.tanksByLeaf.clear();
    this.pipesByLeaf.clear();
    this.pipeEndpoints = [];
    this.fluidSubgraphs = [];
    this.pumpNominals = [];
    this.tankNominals = [];
    this.pipeNominals = [];
    this.puNominals = [];
    // Hide any PU-mode pinned tooltips opened by this plugin so they don't
    // dangle into the next loaded model. Also tear down highlight overlays.
    for (const path of this.puModePinnedPaths) {
      tooltipStore.hide(ProcessIndustryPlugin.PU_MODE_TOOLTIP_PREFIX + path);
    }
    this.puModePinnedPaths = [];
    this.puModeEnabled = false;
    this.clearAllPuHighlights();
    this.pipeNextFlip = [];
    this.tAccum = 0;
    this.tNextGlobal = 0;
  }

  dispose(): void {
    this.onModelCleared(null as unknown as RVViewer);
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * For every tank, replace the GLB-authored capacity with an approximation from
   * the **vessel mesh's** world-space bounding box volume (m³ × 1000 = liters).
   * Uses the largest non-overlay mesh under the tank node (same heuristic as
   * TankFillManager) so supports, platforms, and attached pipe fittings do not
   * inflate the capacity. The current fill ratio is preserved so visually-full
   * tanks stay visually full. Tanks with no vessel mesh are left untouched.
   */
  private assignTankCapacitiesFromBounds(): void {
    const box = new Box3();
    const size = new Vector3();
    for (const tank of this.tanks) {
      const vessel = this.findVesselMesh(tank.node);
      // Prefer the vessel mesh's bbox (excludes supports / attached pipe fittings).
      // Fall back to the whole tank node if we can't find a vessel mesh under it —
      // better to get an approximate-but-non-zero capacity than keep the GLB default.
      const target = vessel ?? tank.node;
      box.setFromObject(target);
      if (box.isEmpty()) {
        console.warn(`[ProcessIndustryPlugin] Tank "${tank.node.name}" has an empty bbox — keeping GLB capacity ${tank.capacity}`);
        continue;
      }
      box.getSize(size);
      const volumeLiters = size.x * size.y * size.z * 1000;
      if (!Number.isFinite(volumeLiters) || volumeLiters <= 0) continue;

      const oldCapacity = tank.capacity;
      const ratio = oldCapacity > 0 ? tank.amount / oldCapacity : 0.5;
      tank.capacity = volumeLiters;
      tank.setAmount(ratio * volumeLiters);
      console.log(
        `[ProcessIndustryPlugin] Tank "${tank.node.name}": ` +
        `bbox ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} m → ` +
        `capacity ${volumeLiters.toFixed(0)} L (was ${oldCapacity})` +
        (vessel ? ` [vessel=${vessel.name}]` : ` [fallback: whole node]`),
      );
    }
  }

  /**
   * Find the largest Mesh descendant of a tank node, ignoring TankFillManager
   * overlay meshes (flagged with userData._tankFillViz). Mirrors the helper in
   * rv-tank-fill.ts so the capacity-from-bounds matches the tank-fill overlay
   * that the user actually sees.
   */
  private findVesselMesh(tankNode: Object3D): Mesh | null {
    let best: Mesh | null = null;
    let bestVolume = 0;
    const tmpBox = new Box3();
    const tmpSize = new Vector3();

    tankNode.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData._tankFillViz) return;
      if (!mesh.geometry?.attributes?.position) return;

      tmpBox.setFromObject(mesh);
      tmpBox.getSize(tmpSize);
      const vol = tmpSize.x * tmpSize.y * tmpSize.z;
      if (vol > bestVolume) {
        bestVolume = vol;
        best = mesh;
      }
    });

    return best;
  }

  /** Resolve a ComponentRef path to an RVTank instance (direct only).
   *  Falls back to a unique leaf-name match when the NodeRegistry path lookup
   *  fails — typically caused by Three.js GLTFLoader sibling-name dedup that
   *  makes the exporter-recorded path stale (e.g. `/Tanks/X` → `/Tanks_6/X`). */
  private resolveTank(viewer: RVViewer, path: string | null, owner: Object3D | null = null): RVTank | null {
    if (!path) return null;
    // plan-769 Phase 1b: the path is a stored reference of `owner`'s file — its
    // verdict names the node (no leaf guess); only a path the file does not
    // carry keeps the lookups below.
    const stored = this.storedEndpoint(viewer, path, owner);
    if (stored !== undefined) {
      const inst = stored?.userData._rvComponentInstance;
      return inst instanceof RVTank ? inst : null;
    }
    const node = viewer.registry?.getNode(path);
    if (node) {
      const inst = node.userData._rvComponentInstance;
      if (inst instanceof RVTank) return inst;
    }
    // Leaf fallback — only trust it when unambiguous.
    const leaf = path.split('/').pop() ?? path;
    const candidates = this.tanksByLeaf.get(leaf);
    if (candidates && candidates.length === 1) return candidates[0];
    return null;
  }

  /** Resolve a ComponentRef path to an RVPipe instance, with leaf fallback. */
  private resolvePipe(viewer: RVViewer, path: string | null, owner: Object3D | null = null): RVPipe | null {
    if (!path) return null;
    const stored = this.storedEndpoint(viewer, path, owner);
    if (stored !== undefined) {
      const inst = stored?.userData._rvComponentInstance;
      return inst instanceof RVPipe ? inst : null;
    }
    const node = viewer.registry?.getNode(path);
    if (node) {
      const inst = node.userData._rvComponentInstance;
      if (inst instanceof RVPipe) return inst;
    }
    const leaf = path.split('/').pop() ?? path;
    const candidates = this.pipesByLeaf.get(leaf);
    if (candidates && candidates.length === 1) return candidates[0];
    return null;
  }

  /**
   * Mirror of Unity PipelineController.FindTank (PipelineController.cs:265–275):
   * given a PipeLineNode endpoint of `originPipe`, return the connected Tank.
   *
   *  - Endpoint is a Tank            → return it.
   *  - Endpoint is another Pipe      → walk one hop: return whichever of that
   *                                    neighbour pipe's source/destination is a Tank.
   *  - Endpoint is a ProcessingUnit  → null (fluid is not tracked through PUs,
   *                                    matching Unity's behaviour).
   *  - Endpoint is missing / unknown → null.
   */
  private resolveTankForEndpoint(
    viewer: RVViewer,
    endpointPath: string | null,
    originPipe: RVPipe,
  ): RVTank | null {
    if (!endpointPath) return null;

    // Try direct tank first (covers the common case and uses leaf-fallback).
    const directTank = this.resolveTank(viewer, endpointPath, originPipe.node);
    if (directTank) return directTank;

    // Otherwise try to resolve to a neighbour Pipe and walk one hop.
    const neighbour = this.resolvePipe(viewer, endpointPath, originPipe.node);
    if (neighbour && neighbour !== originPipe) {
      const neighbourSrc = this.resolveTank(viewer, neighbour.sourcePath, neighbour.node);
      if (neighbourSrc) return neighbourSrc;
      const neighbourDst = this.resolveTank(viewer, neighbour.destinationPath, neighbour.node);
      if (neighbourDst) return neighbourDst;
    }

    // ProcessingUnit, deeper chains, or genuinely unresolvable → give up.
    return null;
  }

  /**
   * plan-769 Phase 1b: the node a stored endpoint reference of `owner` names by its
   * file's verdict; `null` = the file says "no node" (final); `undefined` = not a
   * reference of the file (no owner / registry / identity, or written this session).
   */
  private storedEndpoint(viewer: RVViewer, path: string, owner: Object3D | null): Object3D | null | undefined {
    const registry = viewer.registry;
    if (!owner || !registry) return undefined;
    const r = registry.readStoredRef(owner, path);
    if (r.status === 'resolved') return r.node;
    if (r.status === 'legacy') return undefined;
    return null;
  }

  /** Diagnostic helper: describe what a ref path points to, for logs. */
  private describeRef(viewer: RVViewer, path: string | null): string {
    if (!path) return 'null';
    const node = viewer.registry?.getNode(path);
    if (!node) {
      // Show candidate registered paths that end with the same last segment —
      // usually reveals a prefix or casing mismatch at a glance.
      const leafName = path.split('/').pop() ?? path;
      const candidates: string[] = [];
      viewer.registry?.forEachNode((regPath) => {
        if (regPath.endsWith('/' + leafName) || regPath === leafName) {
          candidates.push(regPath);
        }
      });
      const hint = candidates.length > 0
        ? ` — candidates with matching leaf "${leafName}": ${candidates.slice(0, 3).join(' | ')}`
        : ` — no registered node ends with "${leafName}"`;
      return `MISSING NODE${hint}`;
    }
    const inst = node.userData._rvComponentInstance;
    if (inst instanceof RVTank) return `Tank "${node.name}"`;
    const rvType = node.userData._rvType as string | undefined;
    if (rvType) return `${rvType} "${node.name}" (not a Tank)`;
    return `non-component node "${node.name}"`;
  }

  /**
   * For every pipe with non-zero flow, move fluid between the source and
   * destination tanks, following Unity PipelineController's convention
   * (PipelineController.cs:17, 205–216):
   *
   *   positive flowRate → drain destination, fill source
   *   negative flowRate → drain source,      fill destination
   *
   * `flowRate` is stored in liters per MINUTE (matching the tooltip display),
   * so we convert to liters per second via LPM_TO_LPS for per-tick math:
   *   transfer = |flowRate| * LPM_TO_LPS * dt
   * Transfer is clamped to the drain tank's current amount and the fill
   * tank's remaining free capacity.
   */
  private transferFluids(dt: number): void {
    for (let i = 0; i < this.pipes.length; i++) {
      const pipe = this.pipes[i];
      if (pipe.flowRate === 0) continue;
      const ep = this.pipeEndpoints[i];

      const positive = pipe.flowRate > 0;
      const drainTank = positive ? ep.destination : ep.source;
      const fillTank  = positive ? ep.source      : ep.destination;

      let transfer = Math.abs(pipe.flowRate) * LPM_TO_LPS * dt;
      if (drainTank) transfer = Math.min(transfer, drainTank.amount);
      if (fillTank)  transfer = Math.min(transfer, Math.max(0, fillTank.capacity - fillTank.amount));
      if (transfer <= 0) continue;

      if (drainTank) drainTank.addAmount(-transfer);
      if (fillTank)  fillTank.addAmount(transfer);
    }
  }

  /**
   * Walk the pipe-tank-pump graph and populate `this.fluidSubgraphs` with the
   * connected components. Edges are undirected and follow these references:
   *   - Pipe → Tank            : edge pipe↔tank (direct endpoint is a tank).
   *   - Pipe → Pipe            : edge pipe↔pipe (chained pipes).
   *   - Pump → Pipe            : edge pump↔pipe via the pump's `pipe` ref.
   *   - Pipe → ProcessingUnit  : barrier — fluid identity stops at a PU.
   * Tanks, pipes, AND pumps with the same non-negative `circuitId` are also
   * unioned (authoring-time override that bridges PU barriers or missing refs).
   * Must be called AFTER tank/pipe/pump instances are discovered.
   */
  private buildFluidSubgraphs(viewer: RVViewer): void {
    type Member = RVTank | RVPipe | RVPump;
    const instanceByUuid = new Map<string, Member>();
    const adj = new Map<string, Set<string>>();

    const addNode = (uuid: string, inst: Member) => {
      instanceByUuid.set(uuid, inst);
      if (!adj.has(uuid)) adj.set(uuid, new Set());
    };
    for (const tank of this.tanks) addNode(tank.node.uuid, tank);
    for (const pipe of this.pipes) addNode(pipe.node.uuid, pipe);
    for (const pump of this.pumps) addNode(pump.node.uuid, pump);

    const addEdge = (a: string, b: string) => {
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    };

    // Pipe ↔ Tank / Pipe edges via pipe source/destination refs.
    for (const pipe of this.pipes) {
      for (const path of [pipe.sourcePath, pipe.destinationPath]) {
        if (!path) continue;
        const tank = this.resolveTank(viewer, path, pipe.node);
        if (tank) { addEdge(pipe.node.uuid, tank.node.uuid); continue; }
        const neighbour = this.resolvePipe(viewer, path, pipe.node);
        if (neighbour && neighbour !== pipe) {
          addEdge(pipe.node.uuid, neighbour.node.uuid);
          continue;
        }
        // Anything else (ProcessingUnit, unresolvable) is a barrier.
      }
    }

    // Pump ↔ Pipe edge via the pump's connected pipe reference. A pump always
    // belongs to the medium of the pipe it drives, so this is a hard edge.
    for (const pump of this.pumps) {
      if (!pump.pipePath) continue;
      const pipe = this.resolvePipe(viewer, pump.pipePath, pump.node);
      if (pipe) addEdge(pump.node.uuid, pipe.node.uuid);
    }

    // Authoring-time override: pipes AND pumps with the same non-negative
    // circuitId are declared to share a circuit. Link them so they end up in
    // the same subgraph even when reference-based traversal couldn't connect
    // them (missing refs, ProcessingUnit barriers, etc.).
    const byCircuit = new Map<number, Array<RVPipe | RVPump>>();
    for (const pipe of this.pipes) {
      if (pipe.circuitId < 0) continue;
      const group = byCircuit.get(pipe.circuitId);
      if (group) group.push(pipe);
      else byCircuit.set(pipe.circuitId, [pipe]);
    }
    for (const pump of this.pumps) {
      if (pump.circuitId < 0) continue;
      const group = byCircuit.get(pump.circuitId);
      if (group) group.push(pump);
      else byCircuit.set(pump.circuitId, [pump]);
    }
    for (const group of byCircuit.values()) {
      if (group.length < 2) continue;
      // Star-edges from group[0] to the rest — BFS flattens to one component.
      for (let i = 1; i < group.length; i++) {
        addEdge(group[0].node.uuid, group[i].node.uuid);
      }
    }

    // BFS each unvisited node to collect its component.
    const visited = new Set<string>();
    this.fluidSubgraphs = [];
    for (const startUuid of adj.keys()) {
      if (visited.has(startUuid)) continue;
      const tanks: RVTank[] = [];
      const pipes: RVPipe[] = [];
      const pumps: RVPump[] = [];
      const queue: string[] = [startUuid];
      visited.add(startUuid);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const inst = instanceByUuid.get(cur);
        if (inst instanceof RVTank) tanks.push(inst);
        else if (inst instanceof RVPipe) pipes.push(inst);
        else if (inst instanceof RVPump) pumps.push(inst);
        for (const nb of adj.get(cur)!) {
          if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
      }
      this.fluidSubgraphs.push({ tanks, pipes, pumps });
    }

    const multi = this.fluidSubgraphs.filter((sg) => sg.tanks.length + sg.pipes.length + sg.pumps.length > 1).length;
    console.log(
      `[ProcessIndustryPlugin] Fluid subgraphs: ${this.fluidSubgraphs.length} ` +
      `(${multi} multi-node, ${this.fluidSubgraphs.length - multi} singletons) ` +
      `covering ${this.tanks.length} tanks + ${this.pipes.length} pipes + ${this.pumps.length} pumps`,
    );
  }

  /** Pick a random fluid per subgraph so every tank and pipe in a physically
   *  connected piping network carries the same medium. Repaints pipe AND
   *  tank meshes (no-ops when coloring is disabled).
   *
   *  Accepts an optional `rng` parameter. Pass a seeded RNG (via `makeSeededRng`)
   *  for the initial load-time assignment so every run of the viewer sees the
   *  same tank→medium mapping. The periodic scheduler keeps `Math.random()` so
   *  reshuffles still surprise. Subgraph order is stable across runs because
   *  it's driven by scene traversal order of the same GLB. */
  private reassignFluids(rng: () => number = Math.random): void {
    for (const sg of this.fluidSubgraphs) {
      const f = FLUIDS[Math.floor(rng() * FLUIDS.length)];
      for (const tank of sg.tanks) tank.setResource(f.name);
      for (const pipe of sg.pipes) pipe.setResource(f.name);
      for (const pump of sg.pumps) pump.setResource(f.name);
    }
    for (const pipe of this.pipes) this.applyFlowMaterial(pipe);
    for (const tank of this.tanks) this.applyTankMaterial(tank);
    for (const pump of this.pumps) this.applyPumpMaterial(pump);

    // Refresh density / pH / nominal temp so the tooltip reflects the new medium.
    for (let i = 0; i < this.tanks.length; i++) {
      const tank = this.tanks[i];
      const nom = this.tankNominals[i];
      if (!nom) continue;
      const fluid = FLUIDS.find(f => f.name === tank.resourceName);
      if (fluid) {
        nom.density = fluid.density;
        nom.ph = fluid.ph;
        nom.nominalTempC = fluid.temperature + (rng() * 6 - 3);
        this.applyTankNominals(i);
      }
    }
  }

  /**
   * Get (or create) the cloned fluid material for this pipe. Cloning per pipe
   * avoids a bug where mutating `emissiveIntensity` on a shared material would
   * dim every other pipe using the same fluid.
   */
  private getOrCloneFluidMaterial(pipe: RVPipe): MeshStandardMaterial | null {
    const fluid = pipe.resourceName;
    const existing = this.pipeFluidMaterials.get(pipe);
    if (existing && this.pipeMaterialFluid.get(pipe) === fluid) {
      return existing;
    }
    // Resource changed (or first assignment) — dispose old clone and make a new one.
    if (existing) existing.dispose();
    const template = this.fluidTemplates.get(fluid);
    if (!template) return null;
    const clone = template.clone();
    this.pipeFluidMaterials.set(pipe, clone);
    this.pipeMaterialFluid.set(pipe, fluid);
    return clone;
  }

  /** Paint the pipe with its fluid color. No-op when coloring is disabled.
   *  Pipes are always painted in their medium color — there is no grey "idle"
   *  state and no red "alarm" state. The scrolling flow rings (PipeFlowManager
   *  overlay) are tinted to the same color so the entire pipe reads as "this
   *  carries X" regardless of whether flow is currently 0. */
  private applyFlowMaterial(pipe: RVPipe): void {
    if (!this.coloringEnabled) return;

    const mat = this.getOrCloneFluidMaterial(pipe);
    if (!mat) return;

    pipe.node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData._pipeFlowViz) return; // skip the ring overlay — it has its own material
      if (!this.originalMaterials.has(mesh)) {
        this.originalMaterials.set(mesh, mesh.material);
      }
      mesh.material = mat;
    });

    // Tint the scrolling rings to the fluid's color too. Use a brightened
    // shade (lerp 60 % toward white) so the rings pop against the dusty-pastel
    // pipe material and stay clearly visible under the dim overlay in
    // isolate / color mode — the ring opacity (0.6) would otherwise blend
    // them into the pipe.
    const color = this.fluidColorByName.get(pipe.resourceName);
    if (color != null) this.viewer?.pipeFlowManager?.setRingColor(pipe.node, brighten(color, 0.6));
  }

  /** Paint a pump's body meshes with its medium color. No-op when coloring is
   *  disabled. The pump shares the fluid template with pipes — no per-pump
   *  clone is needed because pumps don't mutate emissive intensity per-instance
   *  the way the pipe ring overlay does. Originals are cached in
   *  `originalMaterials` so `setColoringEnabled(false)` restores them.
   *
   *  Pumps without a known medium (resourceName empty / not in palette) are
   *  left untouched — typically these are pumps not connected to any tank
   *  network (no circuitId, no pipe ref). */
  private applyPumpMaterial(pump: RVPump): void {
    if (!this.coloringEnabled) return;
    const template = this.fluidTemplates.get(pump.resourceName);
    if (!template) return;

    pump.node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (!this.originalMaterials.has(mesh)) {
        this.originalMaterials.set(mesh, mesh.material);
      }
      mesh.material = template;
    });
  }

  /** Retint the tank's liquid-fill + surface-line overlays to the medium
   *  color. No-op when coloring is disabled. The vessel itself keeps its
   *  authored GLB material — we deliberately do NOT recolor vessel meshes so
   *  the mechanical / P&ID look of the plant is preserved; only the contained
   *  liquid reads as "this is medium X". The fill overlay material has
   *  clipping planes we can't replace, so we only swap its `color` via the
   *  TankFillManager. */
  private applyTankMaterial(tank: RVTank): void {
    if (!this.coloringEnabled) return;

    const base = this.fluidColorByName.get(tank.resourceName);
    if (base == null) return;

    // Fill = the raw medium color (the liquid IS the medium). The meniscus
    // ring is a slightly brighter version of the same hue so it pops against
    // the fill without shifting hue.
    const line = brighten(base, 0.25);
    this.viewer?.tankFillManager?.setFillColor(tank.node, base, line);
  }

  // ─── Simulated industrial instrumentation ───────────────────────────

  /**
   * Populate one-time nominal values on every tank / pump / pipe / processing
   * unit, then commit them to the component instances so tooltips immediately
   * show meaningful data. Values are chosen to sit inside typical process-plant
   * operating bands so the ISA-101 color bands in the tooltip stay mostly
   * green, with a handful of warnings so the UI feedback is visible.
   */
  private initInstrumentation(): void {
    // ── Tanks ──
    this.tankNominals = this.tanks.map((tank) => {
      const fluid = FLUIDS.find(f => f.name === tank.resourceName);
      const density = fluid?.density ?? 1000;
      const nominalTempC = (fluid?.temperature ?? 22) + (Math.random() * 6 - 3);
      const ph = fluid?.ph ?? 0;
      const nominalPressure = 1.0 + Math.random() * 1.8; // 1.0–2.8 bar
      return {
        nominalTempC,
        nominalPressure,
        tempHighLimit: 60,
        tempLowLimit: 5,
        pressureHighLimit: 4.0,
        heaterOn: nominalTempC > 30 && Math.random() < 0.3,
        agitatorOn: Math.random() < 0.6,
        ph,
        density,
      };
    });
    for (let i = 0; i < this.tanks.length; i++) {
      this.applyTankNominals(i);
    }

    // ── Pumps ──
    this.pumpNominals = this.pumps.map(() => {
      // Rated curve points — chosen so typical ON state stays green.
      const suction = 0.6 + Math.random() * 1.0;            // 0.6–1.6 bar
      const discharge = suction + 3.0 + Math.random() * 3.0; // ΔP 3–6 bar
      const ratedFlowLpm = 800 + Math.random() * 2000;       // nominal flow
      const ratedPowerKw = 7.5 + Math.random() * 45;          // 7.5–52 kW
      return {
        suctionP: suction,
        dischargeP: discharge,
        ratedFlowLpm,
        ratedSpeedRpm: 1460 + (Math.random() < 0.5 ? 0 : 1440), // 2-pole or 4-pole-ish
        ratedPowerKw,
        ratedCurrentA: ratedPowerKw * 1.8 + Math.random() * 4,
        bearingTempC: 50 + Math.random() * 15,                 // 50–65°C baseline
        motorTempC: 65 + Math.random() * 20,                   // 65–85°C baseline
        vibrationMmS: 1.2 + Math.random() * 1.6,                // ISO10816 zone A/B
        npshA: 5 + Math.random() * 4,                           // 5–9 m
        npshR: 2 + Math.random() * 1.5,                         // 2–3.5 m
        runHours: 200 + Math.random() * 8000,                   // lifetime noise
      };
    });
    for (let i = 0; i < this.pumps.length; i++) {
      this.applyPumpNominals(i);
    }

    // ── Pipes ──
    const DN_OPTIONS = [50, 80, 100, 150, 200];
    this.pipeNominals = this.pipes.map((pipe) => {
      const dn = DN_OPTIONS[Math.floor(Math.random() * DN_OPTIONS.length)];
      // Line temperature follows the source/destination tank temp when known.
      const baseTemp = 22 + (Math.random() * 6 - 3);
      return {
        dnSize: dn,
        temperatureC: baseTemp,
        pressure: 1.5 + Math.random() * 3.5, // 1.5–5 bar
      };
    });
    for (let i = 0; i < this.pipes.length; i++) {
      const pipe = this.pipes[i];
      const nom = this.pipeNominals[i];
      pipe.dnSize = nom.dnSize;
      pipe.temperatureC = nom.temperatureC;
      pipe.pressure = nom.pressure;
      this.applyPipeVelocity(i); // velocity derived from current flow
    }

    // ── Processing Units ──
    const FAULT_SAMPLES = [
      '', '', '', '', '', // mostly no fault
      'Overtemp E-210 cleared',
      'Agitator torque high',
      'Feed pressure low',
    ];
    this.puNominals = this.processingUnits.map(() => {
      const availability = 0.88 + Math.random() * 0.10;   // 88–98 %
      const performance  = 0.80 + Math.random() * 0.15;   // 80–95 %
      const quality      = 0.92 + Math.random() * 0.07;   // 92–99 %
      const cycleTargetS = 40 + Math.random() * 60;       // 40–100 s
      return {
        availability,
        performance,
        quality,
        cycleTargetS,
        mtbfHours: 300 + Math.random() * 600,
        mttrMinutes: 15 + Math.random() * 60,
        runHoursBase: 180 + Math.random() * 300,
        downHoursBase: 2 + Math.random() * 10,
        goodBase: Math.floor(500 + Math.random() * 4000),
        scrapBase: Math.floor(5 + Math.random() * 50),
      };
    });
    for (let i = 0; i < this.processingUnits.length; i++) {
      this.applyProcessingUnitNominals(i, FAULT_SAMPLES);
    }
  }

  /** Apply current per-index tank nominals to the live instance + sync tooltip view. */
  private applyTankNominals(i: number): void {
    const tank = this.tanks[i];
    const n = this.tankNominals[i];
    tank.density = n.density;
    tank.ph = n.ph;
    tank.agitatorOn = n.agitatorOn;
    tank.heatingOn = n.heaterOn;
    tank.tempHighLimit = n.tempHighLimit;
    tank.tempLowLimit = n.tempLowLimit;
    tank.pressureHighLimit = n.pressureHighLimit;
    tank.setTemperature(n.nominalTempC);
    tank.setPressure(n.nominalPressure);
  }

  /** Apply current per-index pump nominals — flow-scaled. */
  private applyPumpNominals(i: number): void {
    const pump = this.pumps[i];
    const n = this.pumpNominals[i];
    const load = pump.isRunning ? Math.min(1, pump.flowRate / n.ratedFlowLpm) : 0;
    pump.suctionPressure = n.suctionP;
    pump.dischargePressure = pump.isRunning
      ? n.suctionP + (n.dischargeP - n.suctionP) * (0.6 + 0.4 * load)
      : n.suctionP;
    pump.speedPercent = pump.isRunning ? 40 + load * 60 : 0;
    pump.speedRpm = pump.isRunning ? n.ratedSpeedRpm * (0.4 + 0.6 * load) : 0;
    pump.powerKw = pump.isRunning ? n.ratedPowerKw * (0.3 + 0.7 * load) : 0;
    pump.currentA = pump.isRunning ? n.ratedCurrentA * (0.35 + 0.65 * load) : 0;
    pump.bearingTempC = n.bearingTempC + (pump.isRunning ? load * 10 : -3);
    pump.motorTempC = n.motorTempC + (pump.isRunning ? load * 15 : -5);
    pump.vibrationMmS = n.vibrationMmS + (pump.isRunning ? load * 0.8 : 0);
    pump.npshAvailable = n.npshA;
    pump.npshRequired = n.npshR;
    pump.runHours = n.runHours;
    pump.setState(pump.vibrationMmS > 4.5 ? 'warning' : 'ok');
    // Force a userData resync so the tooltip observes the new fields.
    pump.start(pump.flowRate); // re-enters start() which calls syncUserData
    if (pump.flowRate === 0) pump.stop();
  }

  /** Derive fluid velocity from live flow and pipe DN. v [m/s] = Q / A. */
  private applyPipeVelocity(i: number): void {
    const pipe = this.pipes[i];
    const n = this.pipeNominals[i];
    const dnMeters = n.dnSize / 1000;
    const area = Math.PI * (dnMeters / 2) ** 2; // m²
    const flowM3S = Math.abs(pipe.flowRate) / 60_000; // L/min → m³/s
    pipe.setVelocity(area > 0 ? flowM3S / area : 0);
  }

  /** Apply per-index PU nominals to the live instance. */
  private applyProcessingUnitNominals(i: number, faultSamples: readonly string[]): void {
    const pu = this.processingUnits[i];
    const n = this.puNominals[i];
    pu.setState('running');
    pu.setOee(n.availability, n.performance, n.quality);
    pu.cycleTargetS = n.cycleTargetS;
    pu.setCycleTime(n.cycleTargetS * (0.95 + Math.random() * 0.12)); // −5%…+7%
    pu.throughputPerHour = pu.cycleTimeS > 0 ? Math.round(3600 / pu.cycleTimeS * n.availability) : 0;
    pu.setCounts(n.goodBase, n.scrapBase);
    pu.mtbfHours = n.mtbfHours;
    pu.mttrMinutes = n.mttrMinutes;
    pu.runHours = n.runHoursBase;
    pu.downHours = n.downHoursBase;
    pu.lastFault = faultSamples[Math.floor(Math.random() * faultSamples.length)];
  }

  /**
   * Drift all instrumentation values each fixed tick. Keeps a low-frequency
   * sine per instance phase-offset by index so nothing twitches identically.
   */
  private updateInstrumentation(dt: number): void {
    const t = this.tAccum;

    // Tanks — temperature + pressure gently drift, derive mass from density.
    for (let i = 0; i < this.tanks.length; i++) {
      const tank = this.tanks[i];
      const n = this.tankNominals[i];
      if (!n) continue;
      const tempDrift = Math.sin(t * 0.15 + i * 0.7) * 0.8;
      const presDrift = Math.sin(t * 0.25 + i * 1.1) * 0.08;
      tank.setTemperature(n.nominalTempC + tempDrift);
      tank.setPressure(Math.max(0, n.nominalPressure + presDrift));
    }

    // Pumps — re-apply curve-based values each frame so the tooltip reacts
    // to live flowRate changes (flow is flipped by the scheduler above).
    for (let i = 0; i < this.pumps.length; i++) {
      const pump = this.pumps[i];
      const n = this.pumpNominals[i];
      if (!n) continue;
      const load = pump.isRunning ? Math.min(1, pump.flowRate / n.ratedFlowLpm) : 0;
      const jitter = 1 + Math.sin(t * 1.1 + i * 0.6) * 0.02;
      pump.suctionPressure = n.suctionP * jitter;
      pump.dischargePressure = pump.isRunning
        ? (n.suctionP + (n.dischargeP - n.suctionP) * (0.6 + 0.4 * load)) * jitter
        : n.suctionP * jitter;
      pump.speedPercent = pump.isRunning ? 40 + load * 60 : 0;
      pump.speedRpm = pump.isRunning ? n.ratedSpeedRpm * (0.4 + 0.6 * load) : 0;
      pump.powerKw = pump.isRunning ? n.ratedPowerKw * (0.3 + 0.7 * load) : 0;
      pump.currentA = pump.isRunning ? n.ratedCurrentA * (0.35 + 0.65 * load) : 0;
      pump.bearingTempC = n.bearingTempC + (pump.isRunning ? load * 10 : -3)
        + Math.sin(t * 0.3 + i) * 0.5;
      pump.motorTempC = n.motorTempC + (pump.isRunning ? load * 15 : -5)
        + Math.sin(t * 0.35 + i) * 0.7;
      pump.vibrationMmS = Math.max(0,
        n.vibrationMmS + (pump.isRunning ? load * 0.8 : 0)
        + Math.sin(t * 1.9 + i * 0.9) * 0.25);
      // Accumulate run hours only when actually running (real seconds → hours).
      if (pump.isRunning) pump.runHours = n.runHours + (t / 3600);
      pump.setState(pump.vibrationMmS > 4.5 ? 'warning' : 'ok');
      // Sync userData view (setState already did). If we changed pressures only,
      // hit start/stop to force a resync without disturbing flow.
      if (pump.isRunning) pump.start(pump.flowRate); else pump.stop();
    }

    // Pipes — velocity derived from live flow; line temp gently drifts.
    for (let i = 0; i < this.pipes.length; i++) {
      const pipe = this.pipes[i];
      const n = this.pipeNominals[i];
      if (!n) continue;
      this.applyPipeVelocity(i);
      pipe.setTemperature(n.temperatureC + Math.sin(t * 0.1 + i * 0.5) * 0.7);
      pipe.setPressure(Math.max(0, n.pressure + Math.sin(t * 0.2 + i) * 0.1));
    }

    // Processing Units — counts slowly accumulate, OEE components drift in a
    // narrow band. Good/scrap increment roughly every cycleTargetS seconds.
    for (let i = 0; i < this.processingUnits.length; i++) {
      const pu = this.processingUnits[i];
      const n = this.puNominals[i];
      if (!n) continue;
      const availDrift = Math.sin(t * 0.07 + i * 0.4) * 0.02;
      const perfDrift  = Math.sin(t * 0.11 + i * 0.6) * 0.03;
      const qualDrift  = Math.sin(t * 0.09 + i * 0.9) * 0.01;
      pu.setOee(
        n.availability + availDrift,
        n.performance + perfDrift,
        n.quality + qualDrift,
      );
      // Accumulate good / scrap at ~ target-rate (use elapsed t / target as a rough
      // integer count increment; keeps numbers moving without a per-cycle trigger).
      const goodEst = n.goodBase + Math.floor((t / n.cycleTargetS) * pu.quality);
      const scrapEst = n.scrapBase + Math.floor((t / n.cycleTargetS) * (1 - pu.quality) * 0.2);
      pu.setCounts(goodEst, scrapEst);
      // Actual cycle time drifts ±8 % around the target.
      pu.setCycleTime(n.cycleTargetS * (1 + Math.sin(t * 0.5 + i * 1.3) * 0.08));
      pu.throughputPerHour = pu.cycleTimeS > 0
        ? Math.round(3600 / pu.cycleTimeS * pu.availability)
        : 0;
      pu.runHours = n.runHoursBase + t / 3600;
    }
    // `dt` is consumed implicitly via `t = this.tAccum`. Silence the linter.
    void dt;
  }
}
