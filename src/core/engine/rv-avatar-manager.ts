// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-avatar-manager.ts — Manages remote player avatar meshes in the Three.js scene.
 *
 * Each remote player is represented by a billboard card (matching the Unity avatar style):
 *   - Black background with player-colored border
 *   - Person icon (placeholder — can be replaced with user photo later)
 *   - Player name below the icon
 *   - Optional left/right controller spheres (for VR mode)
 *
 * Avatars lerp toward their target position/rotation each frame (factor 0.25, matching
 * the Unity NetworkPlayer pattern).
 *
 * Avatar resources (geometry, material, texture) are explicitly disposed on remove
 * to prevent WebGL memory leaks.
 *
 * Phase 2: VR controller spheres + distance-based LOD (full avatar < 10 m, label-only > 10 m).
 *
 * Phase 3: cursor ray — a colored THREE.Line rendered from origin in direction
 * while the remote user is actively hovering over 3D content. Auto-hides after
 * CURSOR_RAY_TIMEOUT_MS of inactivity (no new cursor_ray messages).
 */

import {
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Color,
  Group,
  CanvasTexture,
  SpriteMaterial,
  Sprite,
  Vector3,
  Quaternion,
  Line,
  LineBasicMaterial,
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import type { Scene, Camera } from 'three';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;   // hex string, e.g. "#2196F3"
  role: string;    // "operator" | "observer"
  xrMode: string;  // "none" | "vr" | "ar"
}

export interface AvatarBroadcast {
  id: string;
  headPos?: [number, number, number];
  headRot?: [number, number, number, number];
  cameraTarget?: [number, number, number];
  leftCtrl?: { pos: [number, number, number]; rot: [number, number, number, number]; active: boolean } | null;
  rightCtrl?: { pos: [number, number, number]; rot: [number, number, number, number]; active: boolean } | null;
}

// ── Internal avatar instance ─────────────────────────────────────────────────

/** Cursor ray auto-hides after this many milliseconds without a new cursor_ray message. */
const CURSOR_RAY_TIMEOUT_MS = 500;
/** Length of the rendered cursor ray line in world units (metres). */
const CURSOR_RAY_LENGTH = 50;

/** Billboard card size in world units (metres). */
const CARD_SIZE = 0.5;

interface AvatarResources {
  cardTexture: CanvasTexture;
  cardMaterial: SpriteMaterial;
  // Optional: controller geometries/materials for VR
  ctrlLeftGeometry?: SphereGeometry;
  ctrlLeftMaterial?: MeshStandardMaterial;
  ctrlRightGeometry?: SphereGeometry;
  ctrlRightMaterial?: MeshStandardMaterial;
  // Phase 3: cursor ray
  cursorRayGeometry?: BufferGeometry;
  cursorRayMaterial?: LineBasicMaterial;
}

interface AvatarInstance {
  info: PlayerInfo;
  group: Group;
  cardSprite: Sprite;
  ctrlLeft: Mesh | null;
  ctrlRight: Mesh | null;
  // Phase 3: cursor ray line (world-space, parented to scene not avatar group)
  cursorRay: Line | null;
  cursorRayHideTimer: ReturnType<typeof setTimeout> | null;
  // Lerp targets
  targetPosition: Vector3;
  targetQuaternion: Quaternion;
  // Resources for explicit disposal
  resources: AvatarResources;
}

// ── AvatarManager ────────────────────────────────────────────────────────────

/** Avatars further than this distance from the camera scale down for LOD. */
const LOD_DISTANCE_FULL = 10; // metres

export class AvatarManager {
  private readonly scene: Scene;
  private readonly avatars: Map<string, AvatarInstance> = new Map();

  // Opt 5: Cached players array — invalidated on add/remove/update/clear
  private _cachedPlayers: PlayerInfo[] | null = null;
  private _playersDirty = true;

  // Opt 10: Shared SphereGeometry singleton for VR controller meshes
  private static _sharedCtrlGeometry: SphereGeometry | null = null;

  /** Lerp factor applied each frame. 0.25 matches Unity's NetworkPlayer.cs. */
  readonly lerpFactor = 0.25;

  /** Optional camera reference used for distance-based LOD. Set via setCamera(). */
  private _camera: Camera | null = null;

  /** Reusable vector to avoid per-frame allocation in lerpAvatars. */
  private readonly _lodVec = new Vector3();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Set the camera used for distance-based LOD.
   * Call this once after the viewer camera is available.
   * @param camera The Three.js camera to measure distance against.
   */
  setCamera(camera: Camera): void {
    this._camera = camera;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Add a new remote avatar for the given player. Idempotent (safe to call twice). */
  addAvatar(info: PlayerInfo): void {
    if (this.avatars.has(info.id)) {
      // Update name/color if already present (e.g. room_state refresh)
      this.updateAvatarInfo(info.id, info);
      return;
    }

    const color = new Color(info.color);

    // ── Billboard card ──
    const cardTexture = this._createCardTexture(info.name, info.color);
    const cardMaterial = new SpriteMaterial({ map: cardTexture, depthTest: false, transparent: true });
    const cardSprite = new Sprite(cardMaterial);
    cardSprite.scale.set(CARD_SIZE, CARD_SIZE, 1);

    // ── Group ──
    const group = new Group();
    group.name = `Avatar_${info.name}_${info.id}`;
    group.add(cardSprite);
    this.scene.add(group);

    // ── Optional VR controllers ──
    let ctrlLeft: Mesh | null = null;
    let ctrlRight: Mesh | null = null;
    let ctrlLeftGeometry: SphereGeometry | undefined;
    let ctrlLeftMaterial: MeshStandardMaterial | undefined;
    let ctrlRightGeometry: SphereGeometry | undefined;
    let ctrlRightMaterial: MeshStandardMaterial | undefined;

    if (info.xrMode === 'vr') {
      // Opt 10: Share a single SphereGeometry across all VR controller meshes
      if (!AvatarManager._sharedCtrlGeometry) {
        AvatarManager._sharedCtrlGeometry = new SphereGeometry(0.05, 8, 8);
      }
      ctrlLeftGeometry = AvatarManager._sharedCtrlGeometry;
      ctrlLeftMaterial = new MeshStandardMaterial({ color, roughness: 0.5 });
      ctrlLeft = new Mesh(ctrlLeftGeometry, ctrlLeftMaterial);
      ctrlLeft.visible = false;
      group.add(ctrlLeft);

      ctrlRightGeometry = AvatarManager._sharedCtrlGeometry;
      ctrlRightMaterial = new MeshStandardMaterial({ color, roughness: 0.5 });
      ctrlRight = new Mesh(ctrlRightGeometry, ctrlRightMaterial);
      ctrlRight.visible = false;
      group.add(ctrlRight);
    }

    const instance: AvatarInstance = {
      info,
      group,
      cardSprite,
      ctrlLeft,
      ctrlRight,
      cursorRay: null,
      cursorRayHideTimer: null,
      targetPosition: new Vector3(),
      targetQuaternion: new Quaternion(),
      resources: {
        cardTexture,
        cardMaterial,
        ctrlLeftGeometry,
        ctrlLeftMaterial,
        ctrlRightGeometry,
        ctrlRightMaterial,
      },
    };

    this.avatars.set(info.id, instance);
    this._playersDirty = true; // Opt 5: invalidate cache
  }

  /** Remove and dispose a remote avatar by playerId. */
  removeAvatar(playerId: string): void {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return;

    // Cancel cursor-ray hide timer
    if (avatar.cursorRayHideTimer !== null) {
      clearTimeout(avatar.cursorRayHideTimer);
      avatar.cursorRayHideTimer = null;
    }
    // Remove cursor ray from scene
    if (avatar.cursorRay) {
      this.scene.remove(avatar.cursorRay);
    }

    this.scene.remove(avatar.group);
    this._disposeAvatar(avatar);
    this.avatars.delete(playerId);
    this._playersDirty = true; // Opt 5: invalidate cache
  }

  /** Update a remote avatar's target position/rotation from an avatar_broadcast message. */
  updateAvatar(data: AvatarBroadcast): void {
    const avatar = this.avatars.get(data.id);
    if (!avatar) return;

    if (data.headPos) {
      avatar.targetPosition.set(data.headPos[0], data.headPos[1], data.headPos[2]);
    }
    if (data.headRot) {
      avatar.targetQuaternion.set(data.headRot[0], data.headRot[1], data.headRot[2], data.headRot[3]);
    }

    // VR controller updates
    if (avatar.ctrlLeft && data.leftCtrl) {
      avatar.ctrlLeft.visible = data.leftCtrl.active ?? true;
      avatar.ctrlLeft.position.set(
        data.leftCtrl.pos[0],
        data.leftCtrl.pos[1],
        data.leftCtrl.pos[2],
      );
    }
    if (avatar.ctrlRight && data.rightCtrl) {
      avatar.ctrlRight.visible = data.rightCtrl.active ?? true;
      avatar.ctrlRight.position.set(
        data.rightCtrl.pos[0],
        data.rightCtrl.pos[1],
        data.rightCtrl.pos[2],
      );
    }
  }

  /** Reference frame rate for frame-rate independent lerp (matches Unity AvatarLerp). */
  private static readonly REFERENCE_FPS = 60;

  /**
   * Smooth all avatars toward their targets. Call this each render frame.
   * Uses frame-rate independent exponential lerp so behaviour is identical at 30fps and 60fps.
   * Applies distance-based LOD: avatars further than LOD_DISTANCE_FULL from
   * the camera scale down to reduce visual clutter.
   * @param dt Frame delta time in seconds.
   */
  lerpAvatars(dt: number): void {
    // Frame-rate independent lerp: identical behaviour at 30fps and 60fps
    const t = 1 - Math.pow(1 - this.lerpFactor, dt * AvatarManager.REFERENCE_FPS);

    // Cache camera world position ONCE per frame (not per avatar)
    let camPos: Vector3 | null = null;
    if (this._camera) {
      camPos = this._camera.getWorldPosition(this._lodVec);
    }

    for (const avatar of this.avatars.values()) {
      avatar.group.position.lerp(avatar.targetPosition, t);
      avatar.group.quaternion.slerp(avatar.targetQuaternion, t);

      // Distance-based LOD — only when a camera is set
      if (camPos) {
        const dist = avatar.group.position.distanceTo(camPos);
        const showFull = dist <= LOD_DISTANCE_FULL;
        // Scale card down at distance
        const scale = showFull ? CARD_SIZE : CARD_SIZE * 0.6;
        avatar.cardSprite.scale.set(scale, scale, 1);
        // Controller spheres follow the same rule
        if (avatar.ctrlLeft) avatar.ctrlLeft.visible = showFull && (avatar.ctrlLeft.visible || false);
        if (avatar.ctrlRight) avatar.ctrlRight.visible = showFull && (avatar.ctrlRight.visible || false);
      }
    }
  }

  /** Remove and dispose ALL avatars (called on session disconnect). */
  clear(): void {
    for (const [id] of this.avatars) {
      this.removeAvatar(id);
    }
  }

  /** Returns a cached snapshot of all currently tracked avatar player infos. */
  getPlayers(): PlayerInfo[] {
    if (!this._playersDirty && this._cachedPlayers) return this._cachedPlayers;
    this._cachedPlayers = Array.from(this.avatars.values()).map(a => a.info);
    this._playersDirty = false;
    return this._cachedPlayers;
  }

  /** Returns the number of active remote avatars. */
  get count(): number {
    return this.avatars.size;
  }

  /**
   * Show or update the cursor ray for a remote player.
   * The ray is a colored Line rendered from `origin` in `direction` for
   * CURSOR_RAY_LENGTH metres. It auto-hides after CURSOR_RAY_TIMEOUT_MS of
   * inactivity. Phase 3 stub — geometry is created lazily on first call.
   * @param playerId  Remote player identifier.
   * @param origin    Ray origin in world space [x, y, z].
   * @param direction Ray direction (unit vector) in world space [x, y, z].
   */
  updateCursorRay(
    playerId: string,
    origin: [number, number, number],
    direction: [number, number, number],
  ): void {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return;

    // Lazily create the ray geometry/material on first cursor_ray message
    if (!avatar.cursorRay) {
      const geo = new BufferGeometry();
      const positions = new Float32Array(6); // two points × 3 components
      geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
      const mat = new LineBasicMaterial({ color: new Color(avatar.info.color), transparent: true, opacity: 0.7 });
      avatar.cursorRay = new Line(geo, mat);
      avatar.cursorRay.frustumCulled = false;
      avatar.resources.cursorRayGeometry = geo;
      avatar.resources.cursorRayMaterial = mat;
      this.scene.add(avatar.cursorRay);
    }

    // Update ray endpoint positions
    const end: [number, number, number] = [
      origin[0] + direction[0] * CURSOR_RAY_LENGTH,
      origin[1] + direction[1] * CURSOR_RAY_LENGTH,
      origin[2] + direction[2] * CURSOR_RAY_LENGTH,
    ];
    const posAttr = avatar.cursorRay.geometry.attributes['position'] as Float32BufferAttribute;
    posAttr.setXYZ(0, origin[0], origin[1], origin[2]);
    posAttr.setXYZ(1, end[0], end[1], end[2]);
    posAttr.needsUpdate = true;
    avatar.cursorRay.visible = true;

    // Reset auto-hide timer
    if (avatar.cursorRayHideTimer !== null) clearTimeout(avatar.cursorRayHideTimer);
    avatar.cursorRayHideTimer = setTimeout(() => {
      if (avatar.cursorRay) avatar.cursorRay.visible = false;
      avatar.cursorRayHideTimer = null;
    }, CURSOR_RAY_TIMEOUT_MS);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private updateAvatarInfo(id: string, info: PlayerInfo): void {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    avatar.info = info;
    this._playersDirty = true; // Opt 5: invalidate cache on info change
    // Refresh card texture if name/color changed
    avatar.resources.cardTexture.dispose();
    const newTexture = this._createCardTexture(info.name, info.color);
    avatar.resources.cardTexture = newTexture;
    (avatar.cardSprite.material as SpriteMaterial).map = newTexture;
    (avatar.cardSprite.material as SpriteMaterial).needsUpdate = true;
  }

  /**
   * Creates a billboard card texture matching the Unity avatar style:
   * black background, person icon (placeholder for future user photo),
   * player name, and color accent.
   */
  private _createCardTexture(name: string, hexColor: string): CanvasTexture {
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d')!;

    // ── Background with rounded corners ──
    const margin = 8;
    const radius = 16;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath();
    ctx.roundRect(margin, margin, S - margin * 2, S - margin * 2, radius);
    ctx.fill();

    // ── Color border ──
    ctx.strokeStyle = hexColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(margin, margin, S - margin * 2, S - margin * 2, radius);
    ctx.stroke();

    // ── Person icon (head circle + shoulders arc) ──
    const cx = S / 2;
    const iconY = S * 0.38;

    // Head circle
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, iconY - 28, 24, 0, Math.PI * 2);
    ctx.fill();

    // Shoulders arc
    ctx.beginPath();
    ctx.arc(cx, iconY + 32, 36, Math.PI, 0);
    ctx.closePath();
    ctx.fill();

    // ── Name text ──
    ctx.fillStyle = hexColor;
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const displayName = name.length > 14 ? name.substring(0, 13) + '\u2026' : name;
    ctx.fillText(displayName, cx, S * 0.78);

    return new CanvasTexture(canvas);
  }

  private _disposeAvatar(avatar: AvatarInstance): void {
    const r = avatar.resources;
    r.cardTexture.dispose();
    r.cardMaterial.dispose();
    // Opt 10: Don't dispose shared geometry — only dispose per-avatar materials
    if (r.ctrlLeftGeometry && r.ctrlLeftGeometry !== AvatarManager._sharedCtrlGeometry) {
      r.ctrlLeftGeometry.dispose();
    }
    if (r.ctrlLeftMaterial) r.ctrlLeftMaterial.dispose();
    if (r.ctrlRightGeometry && r.ctrlRightGeometry !== AvatarManager._sharedCtrlGeometry) {
      r.ctrlRightGeometry.dispose();
    }
    if (r.ctrlRightMaterial) r.ctrlRightMaterial.dispose();
    if (r.cursorRayGeometry) r.cursorRayGeometry.dispose();
    if (r.cursorRayMaterial) r.cursorRayMaterial.dispose();
  }
}
