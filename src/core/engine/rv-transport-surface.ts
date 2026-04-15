// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, MathUtils, Mesh, RepeatWrapping } from 'three';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import type { MeshStandardMaterial, Texture } from 'three';
import { AABB } from './rv-aabb';
import type { RVDrive } from './rv-drive';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';

// Pre-allocated temp vectors (no GC in hot path)
const _movement = new Vector3();
const _offset = new Vector3();

/**
 * RVTransportSurface - Moves MUs along a direction at the associated Drive's speed.
 *
 * TransportDirection comes from GLB extras (computed by Unity at export time).
 * Speed comes from the associated RVDrive's currentSpeed.
 */
export class RVTransportSurface implements RVComponent {
  static readonly schema: ComponentSchema = {
    TransportDirection: { type: 'vector3', unityCoords: true },
    Radial: { type: 'boolean', default: false },
    TextureScale: { type: 'number', default: 1 },
    HeightOffsetOverride: { type: 'number', default: 0 },
    AnimateSurface: { type: 'boolean', default: true },
    DriveReference: { type: 'componentRef' },
  };

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  TransportDirection = new Vector3(1, 0, 0);
  Radial = false;
  TextureScale = 1;
  HeightOffsetOverride = 0;
  AnimateSurface = true;
  DriveReference: RVDrive | null = null;

  /** Raw Unity local transport direction for UV animation (before coordinate conversion) */
  rawLocalDir: { x: number; y: number; z: number } = { x: 1, y: 0, z: 0 };

  /** Associated drive (provides speed). Found during scene loading. */
  drive: RVDrive | null = null;

  /** Normalized transport direction in world space */
  private direction = new Vector3();
  /** Rotation axis for radial transport */
  private rotationAxis = new Vector3();

  /** Cloned textures for independent conveyor belt animation */
  private _texMaps: Texture[] = [];
  /** Raw Unity local direction X component for UV animation */
  private _uvDirX = 0;
  /** Raw Unity local direction Z component for UV animation */
  private _uvDirZ = 0;
  /** Raw Unity local direction Y component for radial UV direction sign */
  private _uvDirY = 0;
  /** Accumulated radial texture offset (wraps to avoid precision loss) */
  private _radialOffsetX = 0;

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  /** Reusable quaternion for world-space direction transform */
  private static _worldQuat = new Quaternion();

  /**
   * Transform transport direction to world space, resolve drive, initialize transport.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // TransportDirection is stored in local space by Unity (InverseTransformDirection).
    // Transform to world space using the node's world quaternion.
    this.node.getWorldQuaternion(RVTransportSurface._worldQuat);
    this.TransportDirection.applyQuaternion(RVTransportSurface._worldQuat).normalize();

    // Initialize transport internals (direction, radial, texture animation)
    this.initTransport();

    // Find associated drive: DriveReference first (explicit ref resolved by resolveComponentRefs),
    // then parent hierarchy walk-up
    if (this.DriveReference) {
      this.drive = this.DriveReference;
    }
    if (!this.drive) {
      this.drive = context.registry.findInParent<RVDrive>(this.node, 'Drive');
    }
    if (!this.drive) {
      console.warn(`  TransportSurface "${this.node.name}": no Drive found - will not transport`);
    }

    // Mark drive as transport surface drive (matches Unity's _istransportsurface flag).
    // This is used by multiuser sync to distinguish conveyor drives from positioning drives.
    if (this.drive) {
      this.drive.isTransportSurface = true;
    }

    // Auto-start: if the drive has a target speed but isn't jogging (Forward signal was false/missing),
    // default to running. In Unity the PLC/LogicStep sets Forward=true during play, but in the
    // WebViewer we want conveyor belts to run out of the box.
    if (this.drive && this.drive.targetSpeed > 0 && !this.drive.jogForward && !this.drive.jogBackward) {
      this.drive.jogForward = true;
    }

    // Register in transport manager
    context.transportManager.surfaces.push(this);

    debug('transport',
      `TransportSurface: ${this.node.name}` +
      ` dir=(${this.TransportDirection.x.toFixed(2)}, ${this.TransportDirection.y.toFixed(2)}, ${this.TransportDirection.z.toFixed(2)})` +
      ` radial=${this.Radial}` +
      (this.drive ? ` drive=${this.drive.name} jogFwd=${this.drive.jogForward}` : ' NO DRIVE')
    );
  }

  /**
   * Initialize transport after properties are set (direction, radial, texture animation).
   * Called by the loader after applySchema + quaternion transform.
   */
  initTransport(): void {
    // Normalize the transport direction
    this.direction.copy(this.TransportDirection).normalize();

    if (this.Radial) {
      // For radial transport, the direction IS the rotation axis
      this.rotationAxis.copy(this.direction);
    }

    // Texture animation setup
    if (this.AnimateSurface !== false) {
      this._uvDirX = this.rawLocalDir?.x ?? 0;
      this._uvDirY = this.rawLocalDir?.y ?? 0;
      this._uvDirZ = this.rawLocalDir?.z ?? 0;
      this._initTextureAnimation();
    }
  }

  /** Current transport speed in mm/s from the associated Drive */
  get speed(): number {
    if (!this.drive) return 0;
    // Use drive's actual current speed (respects acceleration ramps)
    return this.drive.currentSpeed;
  }

  /** Is the surface actively transporting? */
  get isActive(): boolean {
    return this.drive != null && this.speed > 0;
  }

  /**
   * Move a MU along the transport direction.
   * Linear transport: direct position offset.
   */
  transportMU(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    if (this.Radial) {
      this.transportMURadial(mu, dt);
      return;
    }

    // Linear transport: position += direction * speed * dt
    // Speed is in mm/s, Three.js positions are in meters -> divide by MM_TO_METERS
    const speedM = this.speed / MM_TO_METERS;
    _movement.copy(this.direction).multiplyScalar(speedM * dt);
    mu.getPosition().add(_movement);
  }

  /**
   * Rotate a MU around the surface center (turntable).
   */
  private transportMURadial(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Speed is in degrees/s for rotational drives
    const angleDeg = this.speed * dt;
    const angleRad = MathUtils.degToRad(angleDeg);

    // Get surface center in world space
    const surfacePos = this.node.getWorldPosition(_offset);

    // Offset from surface center to MU
    _movement.copy(mu.getPosition()).sub(surfacePos);
    // Rotate offset around axis
    _movement.applyAxisAngle(this.rotationAxis, angleRad);
    // Apply new position
    _offset.copy(surfacePos).add(_movement);
    mu.setPosition(_offset);

    // Also rotate the MU itself
    mu.rotateOnAxis(this.rotationAxis, angleRad);
  }

  /**
   * Animate conveyor belt texture based on drive speed.
   * Mirrors Unity's TransportSurface.UpdateTextureAnimation().
   */
  updateTextureAnimation(dt: number): void {
    if (this._texMaps.length === 0 || !this.drive || this.speed === 0) return;

    if (this.Radial) {
      this._updateRadialTexture(dt);
    } else {
      this._updateLinearTexture(dt);
    }
  }

  /** Update AABB (call once per frame, before overlap checks) */
  updateAABB(): void {
    this.aabb.update();
  }

  // ── Texture Animation (private) ──────────────────────────────────

  /**
   * Find mesh children with textures and clone their maps for independent offset control.
   * Mirrors Unity creating material instances for texture animation.
   */
  private _initTextureAnimation(): void {
    let meshCount = 0;
    let texCount = 0;
    this.node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      meshCount++;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i] as MeshStandardMaterial;
        if (mat.map) {
          // Clone texture to get independent offset (image data stays shared on GPU)
          const tex = mat.map.clone();
          tex.wrapS = RepeatWrapping;
          tex.wrapT = RepeatWrapping;
          tex.needsUpdate = true;
          mat.map = tex;
          this._texMaps.push(tex);
          texCount++;
        }
      }
    });
    if (texCount > 0) {
      debug('transport', `TransportSurface "${this.node.name}": texture animation enabled (${texCount} textures on ${meshCount} meshes, uvDir=(${this._uvDirX.toFixed(2)}, ${this._uvDirZ.toFixed(2)}))`);
    } else {
      debug('transport', `TransportSurface "${this.node.name}": no textures found for animation (${meshCount} meshes, all without map)`);
    }
  }

  /**
   * Linear texture animation: scroll UV based on drive speed and transport direction.
   * Matches Unity: uvOffset = (localDir.x, localDir.z) * TextureScale * dt * speed / Scale
   */
  private _updateLinearTexture(dt: number): void {
    // speed is mm/s, /MM_TO_METERS converts to m/s (matches Unity's /Scale)
    const speedFactor = this.TextureScale * dt * this.speed / MM_TO_METERS;
    // Use raw Unity local direction for UV (UV coords are in Unity space)
    const du = this._uvDirX * speedFactor;
    const dv = this._uvDirZ * speedFactor;

    for (const tex of this._texMaps) {
      tex.offset.x += du;
      tex.offset.y += dv;
    }
  }

  /**
   * Radial texture animation: scroll U based on angular speed.
   * Matches Unity: rotationSpeed = speed/360, offset.x += movement * sign(localDir.y)
   */
  private _updateRadialTexture(dt: number): void {
    // speed is degrees/s for rotational drives
    const rotationSpeed = this.speed / 360; // revolutions per second
    const movement = rotationSpeed * dt;
    const direction = Math.sign(this._uvDirY);

    this._radialOffsetX += movement * direction;
    // Wrap to [0, 1] to avoid float precision loss over long runs
    this._radialOffsetX -= Math.floor(this._radialOffsetX);

    for (const tex of this._texMaps) {
      tex.offset.x = this._radialOffsetX;
    }
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'TransportSurface',
  schema: RVTransportSurface.schema,
  needsAABB: true,
  capabilities: {
    badgeColor: '#ffa726',
    filterLabel: 'Conveyors',
    simulationActive: true,
  },
  create: (node, aabb) => new RVTransportSurface(node, aabb!),
  beforeSchema: (inst, extras) => {
    const rawDir = extras['TransportDirection'] as { x: number; y: number; z: number } | undefined;
    (inst as RVTransportSurface).rawLocalDir = rawDir
      ? { x: rawDir.x, y: rawDir.y, z: rawDir.z } : { x: 1, y: 0, z: 0 };
  },
});
