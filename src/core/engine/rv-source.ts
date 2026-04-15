// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion } from 'three';
import {
  RVMovingUnit, InstancedMovingUnit, MUInstancePool,
  computeTemplateAABBInfo, analyzeTemplate,
} from './rv-mu';
import type { IMUAccessor } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';

// Pre-allocated temp vectors (no GC in hot path)
const _sourcePos = new Vector3();
const _lastMUPos = new Vector3();
const _identityQuat = new Quaternion();

/**
 * RVSource - Spawns new MU instances at regular intervals or by distance.
 *
 * Uses a template MU node from the GLB (found by name) and clones it.
 * Template is hidden at load time and used as a clone source.
 */
export class RVSource implements RVComponent {
  static readonly schema: ComponentSchema = {
    AutomaticGeneration: { type: 'boolean', default: true },
    Interval: { type: 'number', default: 0, aliases: ['SpawnInterval'] },
    GenerateIfDistance: { type: 'number', default: 300, aliases: ['SpawnDistance'] },
    PlaceOnTransportSurface: { type: 'boolean', default: true },
    ThisObjectAsMU: { type: 'string', default: '' },
  };

  readonly node: Object3D;
  isOwner = true;

  // Properties — exact C# Inspector field names
  AutomaticGeneration = true;
  Interval = 0;
  GenerateIfDistance = 300;
  PlaceOnTransportSurface = true;
  ThisObjectAsMU = '';

  // Derived properties (computed from schema properties)
  spawnMode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
  spawnInterval = 3;
  spawnDistance = 300;
  muName = '';
  sourceIsTemplate = false;

  /** Template to clone for new MUs */
  muTemplate: Object3D | null = null;
  /** Cached half-size from template (computed once) */
  private templateHalfSize: Vector3 | null = null;
  /** Cached local center offset from template (mesh center vs node origin) */
  private templateLocalCenter: Vector3 | null = null;

  /** Timer for interval-based spawning */
  private timer = 0;
  /** Counter for unique MU names */
  private spawnCount = 0;
  /** Last spawned MU (for distance mode) */
  private lastSpawnedMU: (RVMovingUnit | InstancedMovingUnit) | null = null;
  /** MU ID counter for instanced MUs */
  private muIdCounter = 0;

  /** Parent scene node to add spawned MUs to */
  spawnParent: Object3D | null = null;

  /** Instance pool (non-null when template uses instancing) */
  pool: MUInstancePool | null = null;

  /** Whether this source uses instancing (determined by template analysis) */
  useInstancing = false;

  /** Raw GLB extras for computing spawn config in init() */
  rawExtras: Record<string, unknown> | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  /**
   * Compute spawn config, resolve template, and register with transport manager.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // Read raw extras from node (self-contained — no loader dependency)
    if (!this.rawExtras) {
      const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
      this.rawExtras = (rv?.['Source'] as Record<string, unknown>) ?? null;
    }

    // Compute derived spawn properties from raw extras
    if (this.rawExtras) {
      this.computeSpawnConfig(this.rawExtras);
    }
    this.spawnParent = context.root;

    // Find MU template via registry (path-based, safe)
    let template: Object3D | null = null;
    if (this.sourceIsTemplate) {
      template = this.node;
      debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template=SELF`);
    } else if (this.muName) {
      template = context.registry.getNode(this.muName);
      if (template) {
        debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template="${this.muName}"`);
      } else {
        console.warn(`  Source: ${this.node.name} - MU template "${this.muName}" not found in registry`);
      }
    } else {
      console.warn(`  Source: ${this.node.name} - no MU template configured`);
    }

    if (template) {
      this.setTemplate(template);
    }

    // Register in transport manager
    context.transportManager.sources.push(this);
  }

  /**
   * Compute derived spawn properties from schema properties.
   * Called by loader after applySchema + legacy field handling.
   */
  computeSpawnConfig(extras: Record<string, unknown>): void {
    const interval = this.Interval;
    const distance = this.GenerateIfDistance;
    const autoGen = this.AutomaticGeneration;

    let mode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
    if (interval > 0) {
      mode = 'Interval';
    } else if (autoGen && distance > 0) {
      mode = 'Distance';
    }
    // Override with explicit Spawn field if present (legacy WebViewer format)
    const spawnStr = extras['Spawn'] as string | undefined;
    if (spawnStr === 'Distance') mode = 'Distance';
    else if (spawnStr === 'OnSignal') mode = 'OnSignal';

    this.spawnMode = mode;
    this.spawnInterval = interval > 0 ? interval : 3; // default 3s if not set
    this.spawnDistance = distance;

    // ThisObjectAsMU is serialized as a relative path string (or null/empty if self)
    const templateRef = this.ThisObjectAsMU;
    const nodeName = this.node.name;
    this.sourceIsTemplate = !templateRef || templateRef === '' ||
      templateRef === nodeName || templateRef.endsWith('/' + nodeName);
    this.muName = this.sourceIsTemplate ? nodeName : templateRef;
  }

  /** Set the template MU and pre-compute its half-size and center offset */
  setTemplate(template: Object3D): void {
    this.muTemplate = template;
    const info = computeTemplateAABBInfo(template);
    this.templateHalfSize = info.halfSize;
    this.templateLocalCenter = info.localCenter;
    // Hide template (it's just for cloning)
    template.visible = false;

    // Analyze template for instancing capability
    const analysis = analyzeTemplate(template);
    if (analysis) {
      this.useInstancing = true;
      this.pool = new MUInstancePool(
        analysis.geometry,
        analysis.material,
        template.name,
        this.templateHalfSize,
        this.templateLocalCenter ?? undefined,
      );
      debug('loader', `Source "${this.node.name}": using InstancedMesh for template "${template.name}"`);
    } else {
      this.useInstancing = false;
      debug('loader', `Source "${this.node.name}": using clone() for multi-mesh template "${template.name}"`);
    }
  }

  /**
   * Update source timer and spawn MU if ready.
   * Returns new MU (clone or instanced) or null.
   */
  update(dt: number): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.isOwner) return null; // Server is authority for MU lifecycle
    if (!this.muTemplate || !this.spawnParent) return null;

    if (this.spawnMode === 'Interval') {
      this.timer += dt;
      if (this.timer >= this.spawnInterval) {
        this.timer -= this.spawnInterval;
        return this.spawn();
      }
    } else if (this.spawnMode === 'Distance') {
      // Distance mode: spawn when previous MU has moved spawnDistance mm away
      // (or immediately if no MU has been spawned yet)
      if (!this.lastSpawnedMU || this.lastSpawnedMU.markedForRemoval) {
        return this.spawn();
      }
      // Measure distance from source to last spawned MU (in meters)
      this.node.getWorldPosition(_sourcePos);
      this.lastSpawnedMU.getWorldPosition(_lastMUPos);
      const distM = _sourcePos.distanceTo(_lastMUPos);
      const distMM = distM * MM_TO_METERS;
      if (distMM >= this.spawnDistance) {
        return this.spawn();
      }
    }
    // OnSignal mode not implemented for PoC

    return null;
  }

  /** Create a new MU at this source's position (clone or instanced) */
  private spawn(): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.muTemplate || !this.spawnParent || !this.templateHalfSize) return null;

    // ── Instanced path ──
    if (this.useInstancing && this.pool) {
      // Add pool's InstancedMesh to scene if not already added
      if (!this.pool.instancedMesh.parent) {
        this.spawnParent.add(this.pool.instancedMesh);
      }

      this.node.getWorldPosition(_sourcePos);
      const muId = `imu_${this.node.name}_${this.muIdCounter++}`;

      const mu = this.pool.spawn(_sourcePos, _identityQuat, muId, this.node.name);
      this.lastSpawnedMU = mu;
      this.spawnCount++;
      return mu;
    }

    // ── Clone path (multi-mesh fallback) ──
    const clone = this.muTemplate.clone();
    // Ensure entire clone subtree is visible (template was hidden for cloning)
    clone.visible = true;
    clone.traverse((child) => { child.visible = true; });
    clone.name = `${this.muTemplate.name}_${this.spawnCount++}`;

    // Position at source location (convert world → spawnParent local space)
    this.node.getWorldPosition(clone.position);
    this.spawnParent.worldToLocal(clone.position);

    this.spawnParent.add(clone);

    const mu = new RVMovingUnit(clone, this.node.name, this.templateHalfSize.clone(), this.templateLocalCenter?.clone());
    this.lastSpawnedMU = mu;
    return mu;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Source',
  schema: RVSource.schema,
  capabilities: {
    badgeColor: '#ab47bc',
    simulationActive: true,
  },
  create: (node) => new RVSource(node),
});
