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

import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import { RVPipe } from '../core/engine/rv-pipe';
import { RVTank } from '../core/engine/rv-tank';
import { RVPump } from '../core/engine/rv-pump';

interface FluidDef {
  name: string;
  color: number;
  emissive: number;
}

// Paint / coatings / resin plant palette — spans raw solvents & resins →
// intermediates → finished products → recycled solvent. Must stay in sync
// with RESOURCE_COLORS in tank-fill-history-plugin.tsx so the 3-D pipe
// color matches the trend-line color for every medium.
const FLUIDS: ReadonlyArray<FluidDef> = [
  { name: 'Xylene',            color: 0xb39ddb, emissive: 0x7e57c2 },
  { name: 'MEK',               color: 0x90caf9, emissive: 0x1976d2 },
  { name: 'Epoxy Resin',       color: 0xffb74d, emissive: 0xef6c00 },
  { name: 'Pigment Paste',     color: 0xd84315, emissive: 0xb71c1c },
  { name: 'Automotive Paint',  color: 0x3949ab, emissive: 0x1a237e },
  { name: 'Wood Varnish',      color: 0x6d4c41, emissive: 0x3e2723 },
  { name: 'Recovered Solvent', color: 0x4db6ac, emissive: 0x00695c },
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
 *  tank fill liquid + surface-ring so they read as "the medium, but lit". */
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

export class ProcessIndustryPlugin implements RVViewerPlugin {
  readonly id = 'processindustry';
  readonly order = 150;

  private pipes: RVPipe[] = [];
  private tanks: RVTank[] = [];
  private pumps: RVPump[] = [];

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

  /** Connected tank+pipe subgraphs discovered at load time. Edges follow pipe↔tank
   *  and pipe↔pipe references; Pumps and ProcessingUnits act as barriers. Every
   *  tank and pipe in a subgraph is assigned the SAME fluid so the contents of a
   *  physically connected piping network are coherent instead of randomly mixed. */
  private fluidSubgraphs: Array<{ tanks: RVTank[]; pipes: RVPipe[] }> = [];

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

  /** Toggle fluid recoloring for pipes and tanks. When switching on, every
   *  pipe + tank is repainted AND the scrolling flow rings are tinted to
   *  match the fluid. When switching off, each mesh's original GLB material
   *  is restored and rings revert to default cyan. Idempotent. */
  setColoringEnabled(enabled: boolean): void {
    if (this.coloringEnabled === enabled) return;
    this.coloringEnabled = enabled;
    if (enabled) {
      for (const pipe of this.pipes) this.applyFlowMaterial(pipe);
      for (const tank of this.tanks) this.applyTankMaterial(tank);
    } else {
      for (const [mesh, original] of this.originalMaterials) {
        mesh.material = original as Mesh['material'];
      }
      this.viewer?.pipeFlowManager?.resetAllRingColors();
      this.viewer?.tankFillManager?.resetAllFillColors();
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    // Discover instances via the _rvComponentInstance attached by the class constructors.
    viewer.scene.traverse((n) => {
      const inst = n.userData._rvComponentInstance;
      if (inst instanceof RVPipe) this.pipes.push(inst);
      else if (inst instanceof RVTank) this.tanks.push(inst);
      else if (inst instanceof RVPump) this.pumps.push(inst);
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

    // Assign a random fluid per subgraph — all tanks and pipes in the same
    // subgraph end up with the same resourceName.
    this.reassignFluids();

    // Kick-start: every pipe starts flowing at load so no pipe shows flow=0
    // during the window before its first scheduled flip.
    for (const pipe of this.pipes) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      pipe.setFlow(dir * randomFlowMagnitude());
      this.applyFlowMaterial(pipe);
    }
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
    this.tanksByLeaf.clear();
    this.pipesByLeaf.clear();
    this.pipeEndpoints = [];
    this.fluidSubgraphs = [];
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
  private resolveTank(viewer: RVViewer, path: string | null): RVTank | null {
    if (!path) return null;
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
  private resolvePipe(viewer: RVViewer, path: string | null): RVPipe | null {
    if (!path) return null;
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
    const directTank = this.resolveTank(viewer, endpointPath);
    if (directTank) return directTank;

    // Otherwise try to resolve to a neighbour Pipe and walk one hop.
    const neighbour = this.resolvePipe(viewer, endpointPath);
    if (neighbour && neighbour !== originPipe) {
      const neighbourSrc = this.resolveTank(viewer, neighbour.sourcePath);
      if (neighbourSrc) return neighbourSrc;
      const neighbourDst = this.resolveTank(viewer, neighbour.destinationPath);
      if (neighbourDst) return neighbourDst;
    }

    // ProcessingUnit, deeper chains, or genuinely unresolvable → give up.
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
   * Walk the pipe-tank graph and populate `this.fluidSubgraphs` with the
   * connected components. Edges are undirected and follow the references each
   * pipe declares:
   *   - Pipe → Tank            : edge pipe↔tank (direct endpoint is a tank).
   *   - Pipe → Pipe            : edge pipe↔pipe (chained pipes).
   *   - Pipe → Pump / PU / ∅   : barrier — NO edge. A fluid identity stops here.
   * Must be called AFTER tank and pipe instances are discovered; uses the same
   * `resolveTank` / `resolvePipe` helpers the endpoint resolver uses, so leaf
   * fallbacks work here too.
   */
  private buildFluidSubgraphs(viewer: RVViewer): void {
    const instanceByUuid = new Map<string, RVTank | RVPipe>();
    const adj = new Map<string, Set<string>>();

    const addNode = (uuid: string, inst: RVTank | RVPipe) => {
      instanceByUuid.set(uuid, inst);
      if (!adj.has(uuid)) adj.set(uuid, new Set());
    };
    for (const tank of this.tanks) addNode(tank.node.uuid, tank);
    for (const pipe of this.pipes) addNode(pipe.node.uuid, pipe);

    const addEdge = (a: string, b: string) => {
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    };

    for (const pipe of this.pipes) {
      for (const path of [pipe.sourcePath, pipe.destinationPath]) {
        if (!path) continue;
        const tank = this.resolveTank(viewer, path);
        if (tank) { addEdge(pipe.node.uuid, tank.node.uuid); continue; }
        const neighbour = this.resolvePipe(viewer, path);
        if (neighbour && neighbour !== pipe) {
          addEdge(pipe.node.uuid, neighbour.node.uuid);
          continue;
        }
        // Anything else (Pump, ProcessingUnit, unresolvable) is a barrier.
      }
    }

    // Authoring-time override: pipes with the same non-negative circuitId are
    // declared to share a circuit. Link them so they end up in the same subgraph
    // even when the reference-based traversal couldn't connect them (e.g. missing
    // refs or a ProcessingUnit barrier the author wants to bridge explicitly).
    const byCircuit = new Map<number, RVPipe[]>();
    for (const pipe of this.pipes) {
      if (pipe.circuitId < 0) continue;
      const group = byCircuit.get(pipe.circuitId);
      if (group) group.push(pipe);
      else byCircuit.set(pipe.circuitId, [pipe]);
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
      const queue: string[] = [startUuid];
      visited.add(startUuid);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const inst = instanceByUuid.get(cur);
        if (inst instanceof RVTank) tanks.push(inst);
        else if (inst instanceof RVPipe) pipes.push(inst);
        for (const nb of adj.get(cur)!) {
          if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
      }
      this.fluidSubgraphs.push({ tanks, pipes });
    }

    const multi = this.fluidSubgraphs.filter((sg) => sg.tanks.length + sg.pipes.length > 1).length;
    console.log(
      `[ProcessIndustryPlugin] Fluid subgraphs: ${this.fluidSubgraphs.length} ` +
      `(${multi} multi-node, ${this.fluidSubgraphs.length - multi} singletons) ` +
      `covering ${this.tanks.length} tanks + ${this.pipes.length} pipes`,
    );
  }

  /** Pick a random fluid per subgraph so every tank and pipe in a physically
   *  connected piping network carries the same medium. Repaints pipe AND
   *  tank meshes (no-ops when coloring is disabled). */
  private reassignFluids(): void {
    for (const sg of this.fluidSubgraphs) {
      const f = FLUIDS[Math.floor(Math.random() * FLUIDS.length)];
      for (const tank of sg.tanks) tank.setResource(f.name);
      for (const pipe of sg.pipes) pipe.setResource(f.name);
    }
    for (const pipe of this.pipes) this.applyFlowMaterial(pipe);
    for (const tank of this.tanks) this.applyTankMaterial(tank);
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

    // Tint the scrolling rings to the fluid's color too.
    const color = this.fluidColorByName.get(pipe.resourceName);
    if (color != null) this.viewer?.pipeFlowManager?.setRingColor(pipe.node, color);
  }

  /** Paint a tank's vessel meshes with its fluid color and retint the liquid
   *  fill + surface-line overlays to match. No-op when coloring is disabled.
   *  The fill overlay material itself is kept (it has clipping planes we
   *  can't replace) — only its `color` is swapped via the TankFillManager. */
  private applyTankMaterial(tank: RVTank): void {
    if (!this.coloringEnabled) return;

    const fluid = tank.resourceName;
    const template = this.fluidTemplates.get(fluid);
    if (!template) return;

    tank.node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData._tankFillViz) return; // handled separately below
      if (!this.originalMaterials.has(mesh)) {
        this.originalMaterials.set(mesh, mesh.material);
      }
      mesh.material = template;
    });

    // Retint the liquid inside the tank so "the fluid" visibly IS the fluid.
    // The raw base color reads too dark through a transparent overlay, so we
    // brighten it; the surface ring is brighter still so it pops against the
    // fill but stays the same hue (not washed to white).
    const base = this.fluidColorByName.get(fluid);
    if (base != null) {
      const fill = brighten(base, 0.30);
      const line = brighten(base, 0.55);
      this.viewer?.tankFillManager?.setFillColor(tank.node, fill, line);
    }
  }
}
