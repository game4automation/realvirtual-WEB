// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MultiuserPlugin — Multiuser presence plugin for the realvirtual WebViewer.
 *
 * Opens an independent WebSocket connection to the MultiplayerWEB server
 * running on Port 7000 inside the Unity application (separate from the
 * signal-sync connection on Port 8080).
 *
 * Lifecycle:
 *   onStart()   → resolve server URL, connect, start sending avatar_update
 *   onFrame()   → lerp remote avatars toward their targets
 *   onDestroy() → leave room, close connection, dispose avatars
 *
 * Auto-reconnects with 2 s fixed delay (simple retry, not exponential, for
 * presence where fast rejoin is more important than backoff).
 *
 * Pattern: mirrors McpBridgePlugin (own WS connection, no interference with
 * existing WebsocketRealtimeInterface / signal-sync on Port 8080).
 *
 * Phase 3 additions:
 *   - writeSignal(path, value)   — sends signal_write to Unity (operator role required)
 *   - jogDrive(path, forward)    — sends drive_jog  to Unity (operator role required)
 *   - stopDrive(path)            — sends drive_stop to Unity (operator role required)
 *   - sendCursorRay(origin, dir) — broadcasts cursor_ray to other clients
 *   - URL params: ?server=... &name=... &role=... (also multiuserServer/multiuserName for compat)
 *   - role field included in room_join ("operator" | "observer")
 *   - state_snapshot applied on late join (signals, drives, existing avatars)
 */

import { Vector3, Quaternion } from 'three';
import { lastPathSegment } from '../core/engine/rv-constants';
import { RVBehavior } from '../core/rv-behavior';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { AvatarManager } from '../core/engine/rv-avatar-manager';
import { debug } from '../core/engine/rv-debug';
import type { PlayerInfo, AvatarBroadcast } from '../core/engine/rv-avatar-manager';
import { RVMovingUnit, computeTemplateAABBInfo } from '../core/engine/rv-mu';
import type { InstancedMovingUnit } from '../core/engine/rv-mu';
import type { WebXRPlugin } from './webxr-plugin';
import type { AnnotationPluginAPI } from '../core/types/plugin-types';

// ── Public snapshot emitted on every state transition ───────────────────────

export type MultiuserStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface MultiuserSnapshot {
  connected: boolean;
  status: MultiuserStatus;
  statusMessage: string;
  serverUrl: string;
  localName: string;
  localRole: string;
  playerCount: number;
  players: PlayerInfo[];
}

// ── Phase 3: State snapshot payload ─────────────────────────────────────────

export interface SignalSnapshot {
  path: string;
  type: 'bool' | 'float';
  value: boolean | number;
}

export interface DriveSnapshot {
  path: string;
  position: number;
  speed?: number;
}

export interface MUSnapshot {
  path: string;
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  source: string;
  /** When set, the MU is gripped — pos/rot are local coords relative to this parent node. */
  parent?: string;
}

export interface StateSnapshot {
  signals: SignalSnapshot[];
  drives: DriveSnapshot[];
  players: PlayerInfo[];
}

// ── Shared View external subscribers for React ──────────────────────────────

export interface SharedViewSnapshot {
  following: boolean;
  operatorName: string;
  operatorId: string;
  onUnfollow: () => void;
}

type SharedViewListener = () => void;
const _sharedViewListeners = new Set<SharedViewListener>();
let _sharedViewSnapshot: SharedViewSnapshot = {
  following: false,
  operatorName: '',
  operatorId: '',
  onUnfollow: () => {},
};

function _notifySharedView(): void {
  for (const l of _sharedViewListeners) l();
}

export function subscribeSharedView(listener: SharedViewListener): () => void {
  _sharedViewListeners.add(listener);
  return () => { _sharedViewListeners.delete(listener); };
}

export function getSharedViewSnapshot(): SharedViewSnapshot {
  return _sharedViewSnapshot;
}

// ── Default configuration ────────────────────────────────────────────────────

const DEFAULT_PORT = 7000;
const RECONNECT_DELAY_MS = 2000;
const AVATAR_UPDATE_HZ = 30;

/** Hard cap for outgoing avatar_update messages per second (matches AVATAR_UPDATE_HZ). */
const MAX_OUTGOING_HZ = AVATAR_UPDATE_HZ;

/** Warning threshold for incoming messages per second from the server. */
const MAX_INCOMING_MSG_PER_SECOND = 500;

// Reusable temp objects for MU sync (no GC in hot path)
const _tmpVec3 = new Vector3();
const _tmpQuat = new Quaternion();

// ── Plugin ───────────────────────────────────────────────────────────────────

export class MultiuserPlugin extends RVBehavior {
  readonly id = 'multiuser';
  readonly order = 15; // after interface plugins (10), before XR (20)

  // ── Configuration (set before model load or via joinSession) ──
  private _serverUrl: string = '';
  private _localName: string = '';
  private _localColor: string = '#2196F3';
  private _localRole: string = 'observer';
  private _joinCode: string = '';

  // ── WebSocket state ──
  private _ws: WebSocket | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _destroyed = false;
  private _inRoom = false;
  private _status: MultiuserStatus = 'idle';
  private _statusMessage = '';

  // ── Avatar manager ──
  private _avatarManager: AvatarManager | null = null;

  // ── Outgoing avatar_update throttle ──
  // _sendAccumulator accumulates dt; a message is only sent when it reaches _sendInterval.
  // MAX_OUTGOING_HZ acts as a hard cap: the interval is never smaller than 1/MAX_OUTGOING_HZ.
  private _sendAccumulator = 0;
  private readonly _sendInterval = Math.max(1 / AVATAR_UPDATE_HZ, 1 / MAX_OUTGOING_HZ);

  // ── Incoming message rate tracking ──
  private _incomingMsgCount = 0;
  private _incomingWindowStart = 0;

  // ── MU sync state ──
  private _muSyncActive = false;

  // ── Drive lookup cache (built once on first drive_sync for O(1) matching) ──
  private _driveMap: Map<string, import('../core/engine/rv-drive').RVDrive> | null = null;

  // ── Shared View state ──
  private _sharedViewFollowing = false;
  private _sharedViewOperatorId = '';
  private _sharedViewOperatorName = '';
  private _sharedViewLastBroadcast = 0;
  /** Whether this client is the shared view operator. */
  private _isSharedViewOperator = false;

  // ── Shared View auto-unfollow timeout (5s without avatar_broadcast from operator) ──
  private static readonly SHARED_VIEW_TIMEOUT_MS = 5000;

  // ── "Latest only" message buffers ──
  // Unity sends drive_sync/mu_sync every FixedUpdate (~50Hz). Between browser
  // render frames only the latest message matters — older ones are stale.
  // _handleMessage stores the latest payload; onFrame() applies & clears it.
  private _pendingDriveSync: DriveSnapshot[] | null = null;
  private _pendingMUSync: MUSnapshot[] | null = null;

  // ── Public getters (satisfy MultiuserPluginAPI) ────────────────────────────

  get serverUrl(): string { return this._serverUrl; }
  get localName(): string { return this._localName; }
  get joinCode(): string { return this._joinCode; }
  get localRole(): string { return this._localRole; }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Connect to a MultiplayerWEB server. Safe to call before or after model load. */
  joinSession(serverUrl: string, name: string, color = '#2196F3', role = 'observer', joinCode = ''): void {
    this._serverUrl = serverUrl;
    this._localName = name;
    this._localColor = color;
    this._localRole = role;
    this._joinCode = joinCode;
    this._disconnect();
    this._destroyed = false;
    this._connect();
    this._emitChanged();
  }

  // ── Phase 3: Collaborative control ─────────────────────────────────────────

  /**
   * Write a signal value on the Unity side.
   * Only works when the local role is "operator"; the server enforces this too.
   * @param signalPath  Full hierarchy path to the signal GameObject (e.g. "Cell/Signals/Start")
   * @param value       Boolean or numeric value to write
   */
  writeSignal(signalPath: string, value: boolean | number): void {
    this._send({ type: 'signal_write', signalPath, value });
  }

  /**
   * Jog a Drive component on the Unity side.
   * Only works when the local role is "operator"; the server enforces this too.
   * @param drivePath  Full hierarchy path to the Drive GameObject
   * @param forward    true = Drive.Forward(), false = Drive.Backward()
   */
  jogDrive(drivePath: string, forward: boolean): void {
    this._send({ type: 'drive_jog', drivePath, forward });
  }

  /**
   * Stop a Drive component on the Unity side.
   * Only works when the local role is "operator"; the server enforces this too.
   * @param drivePath  Full hierarchy path to the Drive GameObject
   */
  stopDrive(drivePath: string): void {
    this._send({ type: 'drive_stop', drivePath });
  }

  /**
   * Broadcast a cursor ray to all other connected clients so they can see
   * where this user is pointing in the 3D scene.
   * Both operators and observers may send cursor rays.
   * @param origin     Ray origin in world space [x, y, z]
   * @param direction  Ray direction (unit vector) in world space [x, y, z]
   */
  sendCursorRay(origin: [number, number, number], direction: [number, number, number]): void {
    this._send({ type: 'cursor_ray', origin, direction });
  }

  // ── Shared View API ──────────────────────────────────────────────────────

  /**
   * Toggle shared view mode — operator forces all observers to follow their camera.
   * Only operators can activate; observers can only unfollow.
   */
  toggleSharedView(active: boolean): void {
    if (active) {
      this._isSharedViewOperator = true;
      this._send({ type: 'shared_view_on' });
    } else {
      this._isSharedViewOperator = false;
      this._send({ type: 'shared_view_off' });
    }
  }

  /** Whether this client is currently the shared view operator. */
  get isSharedViewOperator(): boolean { return this._isSharedViewOperator; }

  /** Whether this client is currently following a shared view operator. */
  get isFollowingSharedView(): boolean { return this._sharedViewFollowing; }

  /** Stop following the shared view operator (observer-initiated unfollow). */
  unfollowSharedView(): void {
    this._stopFollowing();
  }

  /**
   * Send a "look at this" ping to all observers.
   * @param target World-space position to orbit to
   */
  sendLookAt(target: [number, number, number]): void {
    this._send({ type: 'look_at', target });
  }

  /** Disconnect from the current session and remove all remote avatars. */
  leaveSession(): void {
    this._destroyed = true;
    this._clearReconnect();
    this._sendLeave();
    this._stopFollowing(); // Auto-unfollow on leave
    this._isSharedViewOperator = false;
    this._disconnect();
    this._avatarManager?.clear();
    this._inRoom = false;
    this._status = 'idle';
    this._statusMessage = '';

    // Restore local ownership when leaving multiuser
    if (this.viewer) {
      if (this._muSyncActive && this.viewer.transportManager) {
        for (const source of this.viewer.transportManager.sources) {
          source.isOwner = true;
        }
        for (const sink of this.viewer.transportManager.sinks) {
          sink.isOwner = true;
        }
        this._muSyncActive = false;
      }
      // Restore drive ownership — drive's onOwnershipChanged handles cleanup
      if (this._driveMap) {
        for (const drive of this.viewer.drives) {
          drive.isOwner = true;
          drive.onOwnershipChanged(true);
        }
        this._driveMap = null;
      }
    }

    this._emitChanged();
  }

  /** Returns the list of currently visible remote players. */
  getConnectedUsers(): PlayerInfo[] {
    return this._avatarManager?.getPlayers() ?? [];
  }

  /** True while the WebSocket is open and the room_join handshake has been sent. */
  get isConnected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN && this._inRoom;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  protected onStart(_result: LoadResult): void {
    if (!this.scene) return;
    this._avatarManager = new AvatarManager(this.scene);

    // Provide camera for distance-based LOD
    if (this.viewer?.camera) {
      this._avatarManager.setCamera(this.viewer.camera);
    }

    // Set up annotation sync: connect the annotation plugin to our send method
    if (this.viewer) {
      const annPlugin = this.viewer.getPlugin<AnnotationPluginAPI & { setSyncSend?(fn: (type: string, payload: object) => void): void }>('annotations');
      if (annPlugin && typeof annPlugin.setSyncSend === 'function') {
        annPlugin.setSyncSend((type: string, payload: object) => {
          this._send({ type, ...payload });
        });
      }
    }

    // Phase 3: Check URL query parameters — support both short keys (?server, ?name, ?role)
    // and the original Phase 1 keys (?multiuserServer, ?multiuserName) for backward compatibility.
    const params = new URLSearchParams(window.location.search);
    const server = params.get('server') ?? params.get('relay') ?? params.get('multiuserServer');
    const name = params.get('name') ?? params.get('multiuserName') ?? 'Browser';
    const color = params.get('multiuserColor') ?? '#2196F3';
    const role = params.get('role') ?? params.get('multiuserRole') ?? 'observer';
    const code = params.get('joinCode') ?? params.get('code') ?? '';
    if (server) {
      this.joinSession(server, name, color, role, code);
    } else if (this._serverUrl) {
      // URL was already set via joinSession() before model loaded
      this._connect();
    } else {
      // Default: try same host on port 7000
      const host = window.location.hostname || 'localhost';
      this._serverUrl = `ws://${host}:${DEFAULT_PORT}`;
    }
  }

  protected onDestroy(): void {
    this._destroyed = true;
    this._clearReconnect();
    this._sendLeave();
    this._disconnect();
    this._avatarManager?.clear();
    this._avatarManager = null;
    this._inRoom = false;
  }

  protected onPreFixedUpdate(_dt: number): void {
    // Apply buffered drive/MU sync BEFORE drive.update() so interpolation starts same tick.
    if (this._pendingDriveSync) {
      this._applyDriveSync(this._pendingDriveSync);
      this._pendingDriveSync = null;
    }
    if (this._pendingMUSync) {
      this._applyMUSync(this._pendingMUSync);
      this._pendingMUSync = null;
    }
  }

  protected onLateFixedUpdate(dt: number): void {
    if (!this._inRoom) return;

    // Throttle avatar_update sends to AVATAR_UPDATE_HZ
    this._sendAccumulator += dt;
    if (this._sendAccumulator >= this._sendInterval) {
      this._sendAccumulator = 0;
      this._sendAvatarUpdate();
    }
  }

  protected onFrame(frameDt: number): void {
    this._avatarManager?.lerpAvatars(frameDt);

    // Shared view auto-unfollow: if no avatar_broadcast from operator for 5s
    if (this._sharedViewFollowing && this._sharedViewLastBroadcast > 0) {
      const elapsed = performance.now() - this._sharedViewLastBroadcast;
      if (elapsed > MultiuserPlugin.SHARED_VIEW_TIMEOUT_MS) {
        debug('multiuser', 'Shared view operator timeout — auto-unfollowing');
        this._stopFollowing();
      }
    }
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

  private _connect(): void {
    if (this._destroyed) return;
    if (!this._serverUrl) return;

    this._status = 'connecting';
    this._statusMessage = `Connecting to ${this._serverUrl}…`;
    this._emitChanged();

    try {
      this._ws = new WebSocket(this._serverUrl);
    } catch {
      this._status = 'error';
      this._statusMessage = 'Invalid server URL';
      this._emitChanged();
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._sendRoomJoin();
      this._inRoom = true;
      this._status = 'connected';
      this._statusMessage = 'Connected';
      this._emitChanged();
    };

    this._ws.onmessage = (e) => {
      this._handleMessage(e.data as string);
    };

    this._ws.onerror = () => {
      // Suppress console noise; onclose handles reconnect
    };

    this._ws.onclose = () => {
      this._inRoom = false;
      this._stopFollowing(); // Auto-unfollow on disconnect
      this._isSharedViewOperator = false;
      const wasConnected = this._status === 'connected';
      this._status = 'error';
      this._statusMessage = wasConnected ? 'Connection lost — reconnecting…' : 'Could not connect — retrying…';
      this._emitChanged();
      this._scheduleReconnect();
    };
  }

  private _disconnect(): void {
    if (!this._ws) return;
    this._ws.onclose = null;
    this._ws.onerror = null;
    this._ws.onmessage = null;
    this._ws.close();
    this._ws = null;
    this._inRoom = false;
  }

  private _scheduleReconnect(): void {
    if (this._destroyed) return;
    this._ws = null;
    this._clearReconnect();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  private _clearReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ── Outgoing messages ─────────────────────────────────────────────────────

  /** Resolve the WebXRPlugin instance from the viewer's plugin array, if present. */
  private _getXRPlugin(): WebXRPlugin | null {
    if (!this.viewer) return null;
    const plugins = (this.viewer as unknown as Record<string, unknown>)['_plugins'] as { id: string }[] | undefined;
    if (!plugins) return null;
    return (plugins.find(p => p.id === 'webxr') as WebXRPlugin | undefined) ?? null;
  }

  /** Returns the current XR mode string ('none' | 'vr' | 'ar') from the WebXRPlugin, or 'none'. */
  private _currentXrMode(): string {
    const xr = this._getXRPlugin();
    if (!xr || !xr.isPresenting) return 'none';
    return xr.currentSessionMode;
  }

  private _sendRoomJoin(): void {
    const msg: Record<string, unknown> = {
      type: 'room_join',
      name: this._localName,
      color: this._localColor,
      role: this._localRole,
      xrMode: this._currentXrMode(),
    };
    if (this._joinCode) msg.joinCode = this._joinCode;
    this._send(msg);
  }

  private _sendLeave(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._send({ type: 'room_leave' });
  }

  private _sendAvatarUpdate(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (!this.viewer) return;

    const xr = this._getXRPlugin();
    const xrMode = this._currentXrMode();

    // When presenting in VR, use the XR camera for head position
    let pos: { x: number; y: number; z: number };
    let rot: { x: number; y: number; z: number; w: number };
    let leftCtrl: { pos: [number, number, number]; rot: [number, number, number, number]; active: boolean } | null = null;
    let rightCtrl: { pos: [number, number, number]; rot: [number, number, number, number]; active: boolean } | null = null;

    if (xr && xr.isPresenting) {
      // Use the Three.js camera (already updated by XR each frame)
      const cam = this.viewer.camera;
      pos = cam.position;
      rot = cam.quaternion;

      if (xrMode === 'vr') {
        const leftPos = xr.getLeftControllerPosition();
        if (leftPos) {
          leftCtrl = {
            pos: [leftPos.x, leftPos.y, leftPos.z],
            rot: [0, 0, 0, 1],
            active: true,
          };
        }
        const rightPos = xr.getRightControllerPosition();
        if (rightPos) {
          rightCtrl = {
            pos: [rightPos.x, rightPos.y, rightPos.z],
            rot: [0, 0, 0, 1],
            active: true,
          };
        }
      }
    } else {
      // Desktop / browser: use orbit-controls camera
      const cam = this.viewer.camera;
      pos = cam.position;
      rot = cam.quaternion;
    }

    const target = this.viewer.controls.target;

    this._send({
      type: 'avatar_update',
      headPos: [pos.x, pos.y, pos.z],
      headRot: [rot.x, rot.y, rot.z, rot.w],
      cameraTarget: [target.x, target.y, target.z],
      leftCtrl,
      rightCtrl,
    });
  }

  private _send(payload: object): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify(payload));
    } catch {
      // Connection dropped between readyState check and send — ignore
    }
  }

  // ── Incoming message handling ─────────────────────────────────────────────

  /** Track incoming message rate. Logs a warning if > MAX_INCOMING_MSG_PER_SECOND. */
  private _checkIncomingRate(): void {
    const now = performance.now();
    if (now - this._incomingWindowStart >= 1000) {
      this._incomingWindowStart = now;
      this._incomingMsgCount = 0;
    }
    this._incomingMsgCount++;
    if (this._incomingMsgCount > MAX_INCOMING_MSG_PER_SECOND) {
      console.warn(
        `[MultiuserPlugin] Incoming message rate exceeded: ${this._incomingMsgCount} msg/s > ${MAX_INCOMING_MSG_PER_SECOND}`,
      );
    }
  }

  private _handleMessage(raw: string): void {
    this._checkIncomingRate();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg['type'] as string | undefined;
    if (!type) return;

    switch (type) {
      case 'room_state':
        this._handleRoomState(msg);
        break;
      case 'room_leave':
        this._handleRoomLeave(msg);
        break;
      case 'avatar_broadcast':
        this._handleAvatarBroadcast(msg);
        break;
      // Phase 3
      case 'state_snapshot':
        this._handleStateSnapshot(msg);
        break;
      case 'drive_sync':
        // Buffer — only the latest per frame matters (applied in onFrame)
        this._pendingDriveSync = msg['drives'] as DriveSnapshot[] ?? null;
        break;
      case 'mu_sync':
        // Buffer — only the latest per frame matters (applied in onFrame)
        this._pendingMUSync = msg['mus'] as MUSnapshot[] ?? null;
        break;
      case 'cursor_ray':
        this._handleCursorRay(msg);
        break;
      // ── Shared View messages ──
      case 'shared_view_on':
        this._handleSharedViewOn(msg);
        break;
      case 'shared_view_off':
        this._handleSharedViewOff(msg);
        break;
      case 'look_at':
        this._handleLookAt(msg);
        break;
      // ── Annotation messages ──
      case 'annotation_add':
      case 'annotation_update':
      case 'annotation_remove':
      case 'annotation_sync':
        this._handleAnnotationMessage(type, msg);
        break;
      case 'error':
        this._handleServerError(msg);
        break;
    }
  }

  private _handleRoomState(msg: Record<string, unknown>): void {
    const players = msg['players'] as PlayerInfo[] | undefined;
    if (!players || !this._avatarManager) return;

    // Sync avatar manager: add new, ignore self
    const seenIds = new Set<string>();
    for (const p of players) {
      // Skip ourselves (server echoes our own join in room_state, but we don't render our own avatar)
      if (p.name === this._localName) continue;
      seenIds.add(p.id);
      this._avatarManager.addAvatar(p);
    }

    // Remove avatars that are no longer in the room
    for (const existingPlayer of this._avatarManager.getPlayers()) {
      if (!seenIds.has(existingPlayer.id)) {
        this._avatarManager.removeAvatar(existingPlayer.id);
      }
    }

    this._emitChanged();
  }

  private _handleRoomLeave(msg: Record<string, unknown>): void {
    const id = msg['id'] as string | undefined;
    if (!id || !this._avatarManager) return;
    this._avatarManager.removeAvatar(id);
    this._emitChanged();
  }

  private _handleAvatarBroadcast(msg: Record<string, unknown>): void {
    if (!this._avatarManager) return;
    this._avatarManager.updateAvatar(msg as unknown as AvatarBroadcast);

    // ── Shared View: follow operator's camera ──
    const senderId = msg['id'] as string | undefined;
    if (this._sharedViewFollowing && senderId === this._sharedViewOperatorId && this.viewer) {
      this._sharedViewLastBroadcast = performance.now();

      const headPos = msg['headPos'] as [number, number, number] | undefined;
      const headRot = msg['headRot'] as [number, number, number, number] | undefined;
      const cameraTarget = msg['cameraTarget'] as [number, number, number] | undefined;

      if (headPos && headRot && cameraTarget) {
        // Frame-rate-independent lerp: t = 1 - (1 - 0.25)^(dt * 60)
        // Using fixed dt approximation at 30Hz avatar update rate
        const t = 0.25;
        const cam = this.viewer.camera;
        cam.position.lerp(_tmpVec3.set(headPos[0], headPos[1], headPos[2]), t);
        cam.quaternion.slerp(_tmpQuat.set(headRot[0], headRot[1], headRot[2], headRot[3]), t);
        this.viewer.controls.target.lerp(_tmpVec3.set(cameraTarget[0], cameraTarget[1], cameraTarget[2]), t);
        this.viewer.controls.update();
        this.viewer.markRenderDirty();
      }
    }
  }

  // ── Phase 3 incoming handlers ─────────────────────────────────────────────

  /**
   * Apply a state_snapshot received on late join.
   * Bulk-applies signal values via the viewer's signal store,
   * bulk-applies drive positions via the viewer's drive registry,
   * and adds players already in the room to the avatar manager.
   */
  private _handleStateSnapshot(msg: Record<string, unknown>): void {
    const signals = msg['signals'] as SignalSnapshot[] | undefined;
    const drives = msg['drives'] as DriveSnapshot[] | undefined;
    const players = msg['players'] as PlayerInfo[] | undefined;

    // Apply signal values via the viewer's signal store
    if (signals && this.viewer) {
      const store = (this.viewer as unknown as Record<string, unknown>)['signalStore'] as
        | { setByPath(path: string, value: boolean | number): void }
        | undefined;
      if (store) {
        for (const sig of signals) {
          store.setByPath(sig.path, sig.value);
        }
      }
    }

    // Apply drive sync — reuse _applyDriveSync (state_snapshot is applied immediately, not buffered)
    if (drives && drives.length > 0) {
      this._applyDriveSync(drives);
    }

    // Add players already in the room to the avatar manager
    if (players && this._avatarManager) {
      for (const p of players) {
        if (p.name === this._localName) continue;
        this._avatarManager.addAvatar(p);
      }
      this._emitChanged();
    }
  }

  /**
   * Build the drive lookup map. Called lazily on first drive_sync or state_snapshot.
   * Sets isOwner=false on all drives, which triggers onOwnershipChanged() —
   * each drive self-manages its multiuser behavior.
   * Also stops any running DrivesPlayback (server is now authority for drive positions).
   */
  private _buildDriveMap(): void {
    if (this._driveMap || !this.viewer) return;
    this._driveMap = new Map();
    const reg = this.viewer.registry;

    // Stop local DrivesPlayback — server is authority for drive positions
    if (this.viewer.playback?.isPlaying) {
      this.viewer.playback.stop();
      debug('multiuser', 'Stopped local DrivesPlayback — server is authority.');
    }

    for (const dr of this.viewer.drives) {
      // Register by full path, Unity-compatible path (without GLTF root), and name
      if (reg) {
        const fullPath = reg.getPathForNode(dr.node);
        if (fullPath) {
          this._driveMap.set(fullPath, dr);
          // Unity's GetFullPath() does NOT include the GLTF root node (it starts at
          // scene root GameObjects like "Robot", "DemoCell"). Three.js computeNodePath()
          // includes the GLTF root (gltf.scene) as an extra prefix.
          // Strip the first segment to produce Unity-compatible paths.
          const slashIdx = fullPath.indexOf('/');
          if (slashIdx >= 0) {
            const unityPath = fullPath.substring(slashIdx + 1);
            this._driveMap.set(unityPath, dr);
          }
        }
      }
      this._driveMap.set(dr.name, dr);
      // Transfer ownership — drive's update() skips physics when !isOwner
      dr.isOwner = false;
      dr.onOwnershipChanged(false);
    }
    debug('multiuser', `Drive map: ${this._driveMap.size} entries for ${this.viewer.drives.length} drives`);
  }

  /**
   * Apply continuous drive sync from the server.
   * Each drive's applySyncData() handles conveyor vs positioning internally.
   */
  /** Track whether we've logged unmatched drives (only log once). */
  private _loggedUnmatched = false;

  private _applyDriveSync(drives: DriveSnapshot[]): void {
    if (!this.viewer) return;

    this._buildDriveMap();

    for (const d of drives) {
      // O(1) lookup: try full path first, then last segment
      let drive = this._driveMap!.get(d.path);
      if (!drive) {
        drive = this._driveMap!.get(lastPathSegment(d.path));
      }
      if (drive) {
        drive.applySyncData(d.position, d.speed);
      } else if (!this._loggedUnmatched) {
        console.warn(`[multiuser] Unmatched drive from server: "${d.path}" (lastSeg="${lastPathSegment(d.path)}")`);
      }
    }
    if (!this._loggedUnmatched) {
      this._loggedUnmatched = true;
    }
  }

  /**
   * Apply MU sync from the server. The mu_sync message contains the complete
   * list of all MUs in Unity. The WebViewer compares with its local MU set:
   *   - New paths → create MU from template via Source
   *   - Missing paths → mark MU for removal
   *   - Existing paths → update position/rotation
   *
   * When connected to multiuser, local Source spawning is disabled (server is authority).
   */
  private _applyMUSync(mus: MUSnapshot[]): void {
    if (!this.viewer) return;

    const tm = this.viewer.transportManager;
    if (!tm) return;

    // Disable local source spawning on first mu_sync (server is authority)
    if (!this._muSyncActive) {
      this._muSyncActive = true;
      for (const source of tm.sources) {
        source.isOwner = false;
      }
      // Also disable sinks (server controls MU removal)
      for (const sink of tm.sinks) {
        sink.isOwner = false;
      }
      debug('multiuser', 'Disabled local Source/Sink — server is authority for MU lifecycle.');
    }

    // Build O(1) lookup maps for incoming MUs (keyed by last path segment AND name)
    const incomingByKey = new Map<string, MUSnapshot>();
    for (const muData of mus) {
      const lastSeg = lastPathSegment(muData.path);
      incomingByKey.set(lastSeg, muData);
      if (muData.name !== lastSeg) incomingByKey.set(muData.name, muData);
    }

    // Remove local MUs not in server's list — O(N) instead of O(N×M)
    for (let i = tm.mus.length - 1; i >= 0; i--) {
      const localMU = tm.mus[i];
      if (!localMU.markedForRemoval && !incomingByKey.has(localMU.getName())) {
        localMU.markedForRemoval = true;
      }
    }

    // Build O(1) lookup for local MUs
    const localByName = new Map<string, RVMovingUnit | InstancedMovingUnit>();
    for (const m of tm.mus) {
      if (!m.markedForRemoval) localByName.set(m.getName(), m);
    }

    // Update positions of existing MUs or create new ones — O(N) lookups
    for (const muData of mus) {
      const lastSeg = lastPathSegment(muData.path);

      // Find existing MU by name — O(1) lookup
      const localMU = localByName.get(lastSeg) ?? localByName.get(muData.name);

      if (localMU) {
        // Gripped MUs: reparent under grip node, use local coords (eliminates jitter)
        // Non-gripped MUs: keep under spawn parent, use world coords
        const node = localMU.node;
        if (muData.parent && this.viewer.registry) {
          // Gripped — reparent under grip node (e.g. GripTarget on robot)
          const gripNode = this.viewer.registry.getNode(muData.parent);
          if (gripNode && node.parent !== gripNode) {
            gripNode.add(node);
          }
        } else if (!muData.parent) {
          // Not gripped — ensure MU is under its spawn parent (not a grip node)
          const sourceName = muData.source ? lastPathSegment(muData.source) : '';
          const source = tm.sources.find(s => s.node.name === sourceName);
          const defaultParent = source?.spawnParent ?? this.scene;
          if (defaultParent && node.parent !== defaultParent) {
            defaultParent.add(node);
          }
        }
        // pos/rot are local when gripped, world when free (both in glTF coords)
        localMU.setPosition(_tmpVec3.set(muData.pos[0], muData.pos[1], muData.pos[2]));
        localMU.setQuaternion(_tmpQuat.set(muData.rot[0], muData.rot[1], muData.rot[2], muData.rot[3]));
        localMU.updateAABB();
      } else {
        // Create new MU from matching Source template
        const sourceName = muData.source ? lastPathSegment(muData.source) : '';
        const source = tm.sources.find(s => s.node.name === sourceName);
        if (source?.muTemplate && source.spawnParent) {
          const template = source.muTemplate;
          const clone = template.clone();
          clone.visible = true;
          clone.traverse((child) => { child.visible = true; });
          clone.name = lastSeg;
          clone.position.set(muData.pos[0], muData.pos[1], muData.pos[2]);
          clone.quaternion.set(muData.rot[0], muData.rot[1], muData.rot[2], muData.rot[3]);
          source.spawnParent.add(clone);

          const info = computeTemplateAABBInfo(clone);
          const newMU = new RVMovingUnit(clone, sourceName, info.halfSize, info.localCenter);
          tm.mus.push(newMU);
          tm.totalSpawned++;
        }
      }
    }

    // Update pool matrices
    tm.updatePoolMatrices();
  }

  /**
   * Forward a cursor_ray to the avatar manager so it can render the
   * highlighting ray from the remote avatar's position.
   */
  private _handleCursorRay(msg: Record<string, unknown>): void {
    if (!this._avatarManager) return;
    const id = msg['id'] as string | undefined;
    const origin = msg['origin'] as [number, number, number] | undefined;
    const direction = msg['direction'] as [number, number, number] | undefined;
    if (id && origin && direction) {
      this._avatarManager.updateCursorRay(id, origin, direction);
    }
  }

  // ── Shared View handlers ──────────────────────────────────────────────────

  private _handleSharedViewOn(msg: Record<string, unknown>): void {
    const operatorId = msg['id'] as string | undefined;
    if (!operatorId || !this.viewer) return;

    // Find operator name from avatar manager
    const players = this._avatarManager?.getPlayers() ?? [];
    const operator = players.find(p => p.id === operatorId);
    const operatorName = operator?.name ?? 'Operator';

    this._sharedViewFollowing = true;
    this._sharedViewOperatorId = operatorId;
    this._sharedViewOperatorName = operatorName;
    this._sharedViewLastBroadcast = performance.now();

    this.viewer.setSharedViewMode(true);

    this._emitSharedViewSnapshot();
    debug('multiuser', `Now following ${operatorName}'s view`);
  }

  private _handleSharedViewOff(msg: Record<string, unknown>): void {
    const operatorId = msg['id'] as string | undefined;
    if (!operatorId) return;
    // Only unfollow if we were following this specific operator
    if (this._sharedViewOperatorId === operatorId) {
      this._stopFollowing();
    }
  }

  private _handleLookAt(msg: Record<string, unknown>): void {
    if (!this.viewer) return;
    const target = msg['target'] as [number, number, number] | undefined;
    if (!target) return;

    const targetVec = new Vector3(target[0], target[1], target[2]);
    this.viewer.controls.target.copy(targetVec);
    this.viewer.controls.update();
    this.viewer.markRenderDirty();
  }

  /** Stop following shared view — re-enable controls. */
  private _stopFollowing(): void {
    if (!this._sharedViewFollowing) return;
    this._sharedViewFollowing = false;
    this._sharedViewOperatorId = '';
    this._sharedViewOperatorName = '';

    this.viewer?.setSharedViewMode(false);
    this._emitSharedViewSnapshot();
    debug('multiuser', 'Stopped following shared view');
  }

  private _emitSharedViewSnapshot(): void {
    const self = this;
    _sharedViewSnapshot = {
      following: this._sharedViewFollowing,
      operatorName: this._sharedViewOperatorName,
      operatorId: this._sharedViewOperatorId,
      onUnfollow: () => self._stopFollowing(),
    };
    _notifySharedView();
  }

  // ── Annotation sync handler ──────────────────────────────────────────────

  private _handleAnnotationMessage(type: string, msg: Record<string, unknown>): void {
    if (!this.viewer) return;
    const annPlugin = this.viewer.getPlugin<AnnotationPluginAPI & { handleRemoteMessage?(type: string, msg: Record<string, unknown>): void }>('annotations');
    if (annPlugin && typeof annPlugin.handleRemoteMessage === 'function') {
      annPlugin.handleRemoteMessage(type, msg);
    }
  }

  private _handleServerError(msg: Record<string, unknown>): void {
    const code = msg['code'] as string | undefined;
    const message = msg['message'] as string | undefined;
    console.warn(`[MultiuserPlugin] Server error: ${code} — ${message}`);
  }

  // ── State emission ────────────────────────────────────────────────────────

  private _emitChanged(): void {
    this.emit('multiuser-changed', {
      connected: this.isConnected,
      status: this._status,
      statusMessage: this._statusMessage,
      serverUrl: this._serverUrl,
      localName: this._localName,
      localRole: this._localRole,
      playerCount: this._avatarManager?.count ?? 0,
      players: this._avatarManager?.getPlayers() ?? [],
    } satisfies MultiuserSnapshot);
  }
}
