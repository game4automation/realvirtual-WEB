// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebXRPlugin — Immersive VR and AR sessions on WebXR-capable devices.
 *
 * Features:
 * - VR mode: full immersion with teleport, locomotion, snap turn
 * - AR mode: passthrough with hit-test surface placement, pinch-to-scale
 * - Teleport: hold trigger → parabolic arc, release → jump
 * - Left thumbstick: head-direction locomotion
 * - Right thumbstick X: snap turn, Y (AR only): scale up/down
 * - Info panel follows user view, dismissed by trigger press
 * - Controller models rendered
 * - Mobile AR: hit-test reticle on surfaces, tap to place, pinch/drag/rotate gestures
 */

import {
  Group,
  Vector3,
  Box3,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  CircleGeometry,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  CanvasTexture,
  PlaneGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Color,
} from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import type { WebGLRenderer } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { RVXRManager, type XRSupport } from '../core/engine/rv-xr-manager';
import { tooltipStore } from '../core/hmi/tooltip/tooltip-store';

const DEAD_ZONE = 0.15;
const SNAP_DEAD_ZONE = 0.5;
const SNAP_ANGLE = Math.PI / 4;
const SNAP_COOLDOWN = 0.35;
const MOVE_SPEED = 2.5;
const MAX_TELEPORT_DIST = 20;
const ARC_VELOCITY = 6.5;
const ARC_GRAVITY = 9.8;
const ARC_DT = 0.02;
const ARC_MAX_STEPS = 120;
const ARC_LINE_SEGMENTS = ARC_MAX_STEPS;
/** AR scale speed (multiplier per second at full stick deflection). */
const AR_SCALE_SPEED = 1.5;
const AR_MIN_SCALE = 0.01;
const AR_MAX_SCALE = 5.0;

type SessionMode = 'none' | 'vr' | 'ar';

export class WebXRPlugin implements RVViewerPlugin {
  readonly id = 'webxr';

  /** True when AR sessions are supported by the browser. */
  arSupported = false;
  /** True when VR sessions are supported by the browser. */
  vrSupported = false;
  /** Eager XR support check — starts immediately, doesn't need viewer/model. */
  private _supportReady: Promise<XRSupport>;

  constructor() {
    // Start XR support detection eagerly so the AR button appears before model load
    this._supportReady = RVXRManager.checkSupport().then(s => {
      this.arSupported = s.ar;
      this.vrSupported = s.vr;
      return s;
    });
  }

  private vrButton: HTMLElement | null = null;
  private arButton: HTMLElement | null = null;
  private viewer: RVViewer | null = null;
  /** Cached WebGLRenderer cast — only set when XR is supported (not WebGPU). */
  private glRenderer: WebGLRenderer | null = null;
  private initialized = false;
  private presenting = false;
  private sessionMode: SessionMode = 'none';

  // Camera rig
  private dolly: Group | null = null;
  private modelBoundingBox: Box3 | null = null;

  // Scene container for AR scaling (contains the actual model)
  private sceneContent: Group | null = null;
  private arScale = 1.0;

  // Snap turn state
  private snapCooldown = 0;

  // Teleport visuals
  private teleportReticle: Group | null = null;
  private teleportArc: Line | null = null;
  private readonly _controllerDir = new Vector3();
  private readonly _controllerPos = new Vector3();

  // Controller references
  private rightController: Group | null = null;
  private leftController: Group | null = null;

  // Trigger state tracking
  private rightTriggerWasPressed = false;
  private leftTriggerWasPressed = false;

  // Info panel
  private infoPanel: Mesh | null = null;
  private infoPanelDismissed = false;

  // Reusable vectors
  private readonly _headDir = new Vector3();

  // Saved scene state for AR
  private savedBackground: Color | null | undefined = undefined;
  private hiddenForAR: { obj: Mesh; visible: boolean }[] = [];

  // Mobile AR touch gesture state
  private arOverlay: HTMLDivElement | null = null;
  private arTouchHandlers: {
    start: (e: TouchEvent) => void;
    move: (e: TouchEvent) => void;
    end: (e: TouchEvent) => void;
  } | null = null;
  private touchState = { lastPinchDist: 0, lastAngle: 0, lastX: 0, lastY: 0, count: 0 };
  private placementMode = false;
  private placementBtn: HTMLButtonElement | null = null;
  private scaleBadge: HTMLDivElement | null = null;
  private replaceBtn: HTMLButtonElement | null = null;

  // Hit-test surface placement
  private hitTestSource: unknown = null;
  private hitReticle: Group | null = null;
  private hitTestMode = false;
  private lastPlaceBtnTap = 0;
  private instructionEl: HTMLDivElement | null = null;

  // AR drive selection & tooltip
  private arSelectedDrive: import('../core/engine/rv-drive').RVDrive | null = null;
  private arStyleEl: HTMLStyleElement | null = null;

  // Last successful hit-test result — used so tap-to-place works even when the
  // current frame has no results (ARCore hit-test is intermittent on some devices).
  private lastHitSeen = false;
  private lastHitTime = 0;

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.modelBoundingBox = result.boundingBox;
    if (!this.initialized) {
      this.initialized = true;
      this.initXR(viewer);
    }
  }

  onRender(frameDt: number): void {
    if (!this.viewer || !this.dolly || !this.presenting) return;
    this.updateInfoPanel();
    this.updateTeleport();
    this.updateThumbstickLocomotion(frameDt);
    this.updateSnapTurn(frameDt);
    if (this.sessionMode === 'ar') this.updateARScale(frameDt);
  }

  /** Detect if running on a VR headset browser (Quest, Pico, etc.) vs mobile/desktop. */
  private static isHeadsetBrowser(): boolean {
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('oculus') || ua.includes('quest')
        || ua.includes('pico') || ua.includes('vive')
        || ua.includes('wolvic') || ua.includes('magic leap');
  }

  private async initXR(viewer: RVViewer): Promise<void> {
    // Await eagerly-started support check (already running from constructor)
    await this._supportReady;

    if (viewer.isWebGPU || !RVXRManager.isXRCapable(viewer.renderer)) {
      console.warn('[WebXR] Renderer does not support WebXR');
      return;
    }
    const glRenderer = viewer.renderer as unknown as WebGLRenderer;
    this.glRenderer = glRenderer;

    // Create camera rig (dolly group for locomotion)
    this.dolly = new Group();
    this.dolly.name = 'VRCameraRig';
    viewer.scene.add(this.dolly);
    this.dolly.add(viewer.camera);

    // Setup controllers inside the dolly
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = glRenderer.xr.getController(i);
      this.dolly.add(controller);
      const grip = glRenderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      this.dolly.add(grip);

      if (i === 0) this.leftController = controller;
      if (i === 1) this.rightController = controller;
    }

    this.createTeleportVisuals(viewer);

    glRenderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
    glRenderer.xr.addEventListener('sessionend', () => this.onSessionEnd());

    // Only show overlay VR/AR buttons on actual headset browsers (Quest, Pico, etc.)
    // On mobile/desktop, entry is handled through the app menu instead.
    if (!WebXRPlugin.isHeadsetBrowser()) return;

    const buttonStyle = {
      position: 'fixed',
      bottom: '20px',
      padding: '12px 32px',
      border: 'none',
      borderRadius: '8px',
      fontSize: '16px',
      fontWeight: '700',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      zIndex: '10000',
      letterSpacing: '0.5px',
    };

    // VR button
    if (this.vrSupported) {
      const button = VRButton.createButton(glRenderer);
      Object.assign(button.style, {
        ...buttonStyle,
        left: this.arSupported ? 'calc(50% - 90px)' : '50%',
        transform: this.arSupported ? 'none' : 'translateX(-50%)',
        background: 'rgba(79, 195, 247, 0.9)',
        color: '#000',
        boxShadow: '0 4px 20px rgba(79, 195, 247, 0.3)',
      });
      this.vrButton = button;
      document.body.appendChild(button);
    }

    // AR button (headset only — e.g. Quest passthrough)
    if (this.arSupported) {
      const arBtn = document.createElement('button');
      arBtn.textContent = 'ENTER AR';
      Object.assign(arBtn.style, {
        ...buttonStyle,
        left: this.vrSupported ? 'calc(50% + 90px)' : '50%',
        transform: this.vrSupported ? 'none' : 'translateX(-50%)',
        background: 'rgba(129, 199, 132, 0.9)',
        color: '#000',
        boxShadow: '0 4px 20px rgba(129, 199, 132, 0.3)',
      });
      arBtn.addEventListener('click', () => this.startAR());
      this.arButton = arBtn;
      document.body.appendChild(arBtn);
    }
  }

  /** Start an AR passthrough session (can be called externally, e.g. from TopBar). */
  async startAR(): Promise<void> {
    if (!this.viewer || !this.glRenderer) return;
    const renderer = this.glRenderer;
    const isMobile = !WebXRPlugin.isHeadsetBrowser();

    try {
      // On mobile: create DOM overlay for touch gestures (pinch-to-scale, drag-to-move)
      const sessionInit: XRSessionInit = {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'hand-tracking'],
      };

      if (isMobile) {
        this.arOverlay = document.createElement('div');
        this.arOverlay.style.cssText = 'position:fixed;inset:0;touch-action:none;';
        document.body.appendChild(this.arOverlay);
        // Move #react-root into overlay so React UI renders in AR
        const reactRoot = document.getElementById('react-root');
        if (reactRoot) this.arOverlay.appendChild(reactRoot);
        // Inject CSS to hide all HMI except MessagePanel during AR
        this.arStyleEl = document.createElement('style');
        this.arStyleEl.id = 'ar-hmi-overrides';
        this.arStyleEl.textContent = `
          #react-root > * > * { display: none !important; }
          #react-root [data-ar-show] { display: flex !important; }
        `;
        document.head.appendChild(this.arStyleEl);
        // dom-overlay must be required (not optional) so the browser guarantees
        // DOM touch-event routing through the overlay element. When only optional,
        // Chrome Android can start the session without overlay-mode and the
        // touch handlers on this.arOverlay never fire → tap-to-place is dead.
        sessionInit.requiredFeatures!.push('dom-overlay');
        (sessionInit as Record<string, unknown>).domOverlay = { root: this.arOverlay };
      }

      const session = await navigator.xr!.requestSession('immersive-ar', sessionInit);

      this.sessionMode = 'ar';
      // Use native device resolution for sharp AR camera passthrough
      renderer.xr.setFramebufferScaleFactor(window.devicePixelRatio);
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);

      // Setup touch handlers after session is active (sceneContent exists after onSessionStart)
      if (isMobile && this.arOverlay) {
        this.setupMobileARTouch(this.arOverlay);
        await this.requestHitTest(session);
      }
    } catch (e) {
      console.warn('[WebXR] AR session failed:', e);
      this.teardownMobileARTouch();
    }
  }

  /** Create teleport reticle and arc line. */
  private createTeleportVisuals(viewer: RVViewer): void {
    this.teleportReticle = new Group();
    this.teleportReticle.visible = false;

    const ringGeo = new RingGeometry(0.22, 0.28, 32).rotateX(-Math.PI / 2);
    const ringMat = new MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.85 });
    this.teleportReticle.add(new Mesh(ringGeo, ringMat));

    const discGeo = new CircleGeometry(0.18, 32).rotateX(-Math.PI / 2);
    const discMat = new MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.25 });
    this.teleportReticle.add(new Mesh(discGeo, discMat));

    viewer.scene.add(this.teleportReticle);

    const positions = new Float32Array((ARC_LINE_SEGMENTS + 1) * 3);
    const arcGeo = new BufferGeometry();
    arcGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    arcGeo.setDrawRange(0, 0);
    const arcMat = new LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.6 });
    this.teleportArc = new Line(arcGeo, arcMat);
    this.teleportArc.visible = false;
    this.teleportArc.frustumCulled = false;
    viewer.scene.add(this.teleportArc);
  }

  /** Create info panel with mode-specific instructions. */
  private createInfoPanel(mode: SessionMode): Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 380;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(18, 18, 18, 0.92)';
    roundRect(ctx, 0, 0, 512, 380, 16);
    ctx.fill();

    ctx.strokeStyle = mode === 'ar' ? 'rgba(129, 199, 132, 0.4)' : 'rgba(79, 195, 247, 0.4)';
    ctx.lineWidth = 2;
    roundRect(ctx, 1, 1, 510, 378, 16);
    ctx.stroke();

    const accent = mode === 'ar' ? '#81c784' : '#4fc3f7';

    ctx.fillStyle = accent;
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(mode === 'ar' ? 'AR Navigation' : 'VR Navigation', 256, 48);

    ctx.textAlign = 'left';
    const lines: [string, string][] = mode === 'ar' ? [
      ['L stick', 'Walk (follows head direction)'],
      ['R stick X', 'Turn left / right'],
      ['R stick Y', 'Scale model up / down'],
      ['Trigger', 'Hold to aim, release to teleport'],
    ] : [
      ['L stick', 'Walk (follows head direction)'],
      ['R stick', 'Turn left / right'],
      ['Trigger', 'Hold to aim arc, release to jump'],
      ['', ''],
    ];

    let y = 95;
    for (const [label, text] of lines) {
      if (!label && !text) { y += 42; continue; }
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillStyle = accent;
      ctx.fillText(label, 36, y);
      ctx.font = '17px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(text, 170, y);
      y += 42;
    }

    ctx.fillStyle = accent;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Press any trigger to start', 256, 345);

    const texture = new CanvasTexture(canvas);
    const geo = new PlaneGeometry(0.8, 0.6);
    const mat = new MeshBasicMaterial({ map: texture, transparent: true, side: DoubleSide, depthTest: false });
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 9999;
    return mesh;
  }

  /** Called when any XR session starts (VR or AR). */
  private onSessionStart(): void {
    this.presenting = true;
    if (!this.dolly || !this.modelBoundingBox || !this.viewer) return;

    // Detect session mode if not already set (VRButton sets it automatically)
    if (this.sessionMode === 'none') {
      this.sessionMode = 'vr';
    }

    const center = new Vector3();
    const size = new Vector3();
    this.modelBoundingBox.getCenter(center);
    this.modelBoundingBox.getSize(size);

    // Clear highlights BEFORE wrapping children into sceneContent,
    // otherwise scene.remove() can't find overlays that moved into the group.
    this.viewer.highlighter.clear();
    // Disable raycast hover so no new highlights appear during XR
    if (this.viewer.raycastManager) this.viewer.raycastManager.setEnabled(false);

    if (this.sessionMode === 'ar') {
      // AR mode: make background transparent for passthrough
      this.savedBackground = this.viewer.scene.background as Color | null;
      this.viewer.scene.background = null;

      // Hide ground plane and other large floor meshes for passthrough
      this.hiddenForAR = [];
      this.viewer.scene.traverse((obj) => {
        if (obj instanceof Mesh && obj.geometry instanceof PlaneGeometry) {
          const params = (obj.geometry as PlaneGeometry).parameters;
          if (params.width >= 50 && params.height >= 50) {
            this.hiddenForAR.push({ obj, visible: obj.visible });
            obj.visible = false;
          }
        }
      });

      // Wrap scene content in a group for scaling
      this.sceneContent = new Group();
      this.sceneContent.name = 'ARSceneContent';

      // Move all scene children (except dolly, teleport visuals) into sceneContent
      const children = [...this.viewer.scene.children];
      for (const child of children) {
        if (child === this.dolly || child === this.teleportReticle || child === this.teleportArc) continue;
        this.sceneContent.add(child);
      }
      this.viewer.scene.add(this.sceneContent);

      // Start at 1:1 scale
      this.arScale = 1.0;
      this.sceneContent.scale.setScalar(this.arScale);

      const isMobileAR = !WebXRPlugin.isHeadsetBrowser();
      if (isMobileAR) {
        // Hide model until placed via hit-test tap
        this.sceneContent.visible = false;
        this.sceneContent.position.set(0, 0, 0);
        // Freeze simulation while the user is placing / adjusting the model.
        // Resumes after "Done" is tapped (exit placementMode) — see updatePlacementButton.
        this.viewer.setSimulationPaused('ar-placement', true);
      } else {
        // Headset AR: position model at floor level, 2m in front of user
        this.sceneContent.position.set(
          -center.x,
          -this.modelBoundingBox.min.y,
          -2.0 - center.z,
        );
      }

      // Dolly at origin for AR (user stands where they are)
      this.dolly.position.set(0, 0, 0);
      this.dolly.rotation.set(0, 0, 0);
    } else {
      // VR mode: position outside the machine
      const maxHoriz = Math.max(size.x, size.z, 0.5);
      const standDist = maxHoriz * 1.2;

      this.dolly.position.set(
        center.x + standDist * 0.7,
        0,
        center.z + standDist * 0.7,
      );

      const lookTarget = new Vector3(center.x, 0, center.z);
      const dollyPos = this.dolly.position.clone();
      const dir = lookTarget.sub(dollyPos).normalize();
      const angle = Math.atan2(dir.x, dir.z);
      this.dolly.rotation.set(0, angle, 0);
    }

    this.snapCooldown = 0;
    this.rightTriggerWasPressed = false;
    this.leftTriggerWasPressed = false;

    // (highlights already cleared before wrapping into sceneContent above)

    // Show info panel (skip on mobile AR — no controllers to dismiss it)
    const isMobileAR = this.sessionMode === 'ar' && !WebXRPlugin.isHeadsetBrowser();
    if (isMobileAR) {
      this.infoPanelDismissed = true;
    } else {
      this.infoPanelDismissed = false;
      this.infoPanel = this.createInfoPanel(this.sessionMode);
      this.dolly.add(this.infoPanel);
      this.infoPanel.position.set(0, 1.5, -1.2);
    }
  }

  /** Reset when leaving XR. */
  private onSessionEnd(): void {
    this.presenting = false;
    if (!this.dolly || !this.viewer) return;

    // Always release the AR placement pause — whether it was still held (session
    // ended mid-placement) or already released (set false on Done). Idempotent:
    // releasing an inactive reason is a no-op.
    this.viewer.setSimulationPaused('ar-placement', false);

    // Restore scene content from AR wrapper
    if (this.sceneContent) {
      this.sceneContent.scale.setScalar(1);
      this.sceneContent.position.set(0, 0, 0);
      this.sceneContent.visible = true;
      const children = [...this.sceneContent.children];
      for (const child of children) {
        this.viewer.scene.add(child);
      }
      this.viewer.scene.remove(this.sceneContent);
      this.sceneContent = null;
    }

    // Restore ground plane visibility
    for (const { obj, visible } of this.hiddenForAR) {
      obj.visible = visible;
    }
    this.hiddenForAR = [];

    // Restore background
    if (this.savedBackground !== undefined) {
      this.viewer.scene.background = this.savedBackground;
      this.savedBackground = undefined;
    }

    this.viewer.scene.add(this.viewer.camera);
    this.dolly.position.set(0, 0, 0);
    this.dolly.rotation.set(0, 0, 0);

    if (this.teleportReticle) this.teleportReticle.visible = false;
    if (this.teleportArc) this.teleportArc.visible = false;

    this.removeInfoPanel();
    this.teardownMobileARTouch();

    // Re-enable raycast hover (was disabled on session start)
    if (this.viewer.raycastManager) {
      this.viewer.raycastManager.setEnabled(true);
    }

    // Clean up hit-test resources
    if (this.hitTestSource) {
      try { (this.hitTestSource as { cancel(): void }).cancel(); } catch (_) { /* ok */ }
      this.hitTestSource = null;
    }
    this.hitTestMode = false;
    if (this.hitReticle) {
      this.hitReticle.removeFromParent();
      this.hitReticle.traverse((child) => {
        if (child instanceof Mesh) {
          child.geometry.dispose();
          (child.material as MeshBasicMaterial).dispose();
        }
      });
      this.hitReticle = null;
    }

    this.sessionMode = 'none';
    this.arScale = 1.0;
  }

  /** Keep info panel in front of user, dismiss on trigger. */
  private updateInfoPanel(): void {
    if (!this.infoPanel || this.infoPanelDismissed || !this.viewer) return;

    const xrCamera = this.glRenderer!.xr.getCamera();
    const camDir = new Vector3();
    xrCamera.getWorldDirection(camDir);
    const camPos = new Vector3();
    xrCamera.getWorldPosition(camPos);

    const worldTarget = camPos.clone().add(camDir.multiplyScalar(1.2));
    if (this.dolly) this.dolly.worldToLocal(worldTarget);
    this.infoPanel.position.copy(worldTarget);

    // lookAt() expects world coordinates and points -Z toward the target.
    // PlaneGeometry texture is on the +Z face. To show the texture toward the camera,
    // we look at the reflection of the camera THROUGH the panel (i.e. away from camera).
    const panelWorld = new Vector3();
    this.infoPanel.getWorldPosition(panelWorld);
    const awayFromCam = panelWorld.clone().multiplyScalar(2).sub(camPos);
    this.infoPanel.lookAt(awayFromCam);

    const session = this.glRenderer!.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      const trigger = source.gamepad.buttons[0];
      if (trigger && trigger.pressed) {
        this.infoPanelDismissed = true;
        this.removeInfoPanel();
        this.rightTriggerWasPressed = true;
        this.leftTriggerWasPressed = true;
        return;
      }
    }
  }

  /** Parabolic arc from controller to ground. */
  private computeArc(origin: Vector3, direction: Vector3): { points: Vector3[]; landing: Vector3 } | null {
    const points: Vector3[] = [];
    const vel = direction.clone().multiplyScalar(ARC_VELOCITY);
    const pos = origin.clone();
    points.push(pos.clone());

    for (let i = 0; i < ARC_MAX_STEPS; i++) {
      const prevY = pos.y;
      vel.y -= ARC_GRAVITY * ARC_DT;
      pos.x += vel.x * ARC_DT;
      pos.y += vel.y * ARC_DT;
      pos.z += vel.z * ARC_DT;
      points.push(pos.clone());

      if (pos.y <= 0 && prevY > 0) {
        const t = prevY / (prevY - pos.y);
        const landing = new Vector3(
          points[points.length - 2].x + (pos.x - points[points.length - 2].x) * t,
          0,
          points[points.length - 2].z + (pos.z - points[points.length - 2].z) * t,
        );
        points[points.length - 1] = landing;
        if (origin.distanceTo(landing) > MAX_TELEPORT_DIST) return null;
        return { points, landing };
      }

      if (pos.y < -5) return null;
    }
    return null;
  }

  /** Hold trigger → show arc + reticle. Release → teleport. */
  private updateTeleport(): void {
    if (!this.viewer || !this.dolly) return;
    if (this.infoPanel && !this.infoPanelDismissed) return;

    const session = this.glRenderer!.xr.getSession();
    if (!session) return;

    const prevRight = this.rightTriggerWasPressed;
    const prevLeft = this.leftTriggerWasPressed;
    const rightHeld = this.isTriggerPressed(session, 'right');
    const leftHeld = this.isTriggerPressed(session, 'left');
    this.rightTriggerWasPressed = rightHeld;
    this.leftTriggerWasPressed = leftHeld;

    // Teleport on trigger release
    if (!rightHeld && prevRight && this.teleportReticle?.visible) {
      this.dolly.position.x = this.teleportReticle.position.x;
      this.dolly.position.z = this.teleportReticle.position.z;
      this.dolly.position.y = 0;
    } else if (!leftHeld && prevLeft && this.teleportReticle?.visible) {
      this.dolly.position.x = this.teleportReticle.position.x;
      this.dolly.position.z = this.teleportReticle.position.z;
      this.dolly.position.y = 0;
    }

    if (!rightHeld && !leftHeld) {
      if (this.teleportReticle) this.teleportReticle.visible = false;
      if (this.teleportArc) this.teleportArc.visible = false;
      return;
    }

    const ctrl = rightHeld ? this.rightController : this.leftController;
    if (!ctrl) return;

    ctrl.getWorldPosition(this._controllerPos);
    ctrl.getWorldDirection(this._controllerDir);
    // Negate: getWorldDirection returns -Z but Quest controllers point along +Z
    this._controllerDir.negate();

    const arc = this.computeArc(this._controllerPos, this._controllerDir);
    if (!arc) {
      if (this.teleportReticle) this.teleportReticle.visible = false;
      if (this.teleportArc) this.teleportArc.visible = false;
      return;
    }

    if (this.teleportReticle) {
      this.teleportReticle.position.copy(arc.landing);
      this.teleportReticle.position.y = 0.02;
      this.teleportReticle.visible = true;
    }

    if (this.teleportArc) {
      const posAttr = this.teleportArc.geometry.attributes.position as Float32BufferAttribute;
      const maxPts = ARC_LINE_SEGMENTS + 1;
      const numPts = Math.min(arc.points.length, maxPts);
      for (let i = 0; i < numPts; i++) {
        posAttr.setXYZ(i, arc.points[i].x, arc.points[i].y, arc.points[i].z);
      }
      posAttr.needsUpdate = true;
      this.teleportArc.geometry.setDrawRange(0, numPts);
      this.teleportArc.visible = true;
    }
  }

  private isTriggerPressed(session: XRSession, hand: 'left' | 'right'): boolean {
    for (const source of session.inputSources) {
      if (source.handedness === hand && source.gamepad) {
        return (source.gamepad.buttons[0]?.pressed ?? false)
            || (source.gamepad.buttons[1]?.pressed ?? false);
      }
    }
    return false;
  }

  /** Left thumbstick: walk in head direction. */
  private updateThumbstickLocomotion(dt: number): void {
    if (!this.viewer || !this.dolly) return;
    if (this.infoPanel && !this.infoPanelDismissed) return;

    const session = this.glRenderer!.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'left') continue;
      const axes = source.gamepad.axes;

      const axX = axes.length > 2 ? axes[2] : axes[0];
      const axY = axes.length > 3 ? axes[3] : axes[1];
      const moveX = Math.abs(axX) > DEAD_ZONE ? axX : 0;
      const moveZ = Math.abs(axY) > DEAD_ZONE ? axY : 0;
      if (moveX === 0 && moveZ === 0) continue;

      const xrCamera = this.glRenderer!.xr.getCamera();
      xrCamera.getWorldDirection(this._headDir);
      this._headDir.y = 0;
      this._headDir.normalize();

      const fwdX = this._headDir.x;
      const fwdZ = this._headDir.z;
      const rightX = -this._headDir.z;
      const rightZ = this._headDir.x;

      const speed = MOVE_SPEED * dt;
      this.dolly.position.x += (fwdX * -moveZ + rightX * moveX) * speed;
      this.dolly.position.z += (fwdZ * -moveZ + rightZ * moveX) * speed;
      this.dolly.position.y = 0;
    }
  }

  /** Right thumbstick X: snap turn. */
  private updateSnapTurn(dt: number): void {
    if (!this.viewer || !this.dolly) return;
    if (this.infoPanel && !this.infoPanelDismissed) return;

    const session = this.glRenderer!.xr.getSession();
    if (!session) return;

    if (this.snapCooldown > 0) this.snapCooldown -= dt;

    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'right') continue;
      const axes = source.gamepad.axes;

      const axX = axes.length > 2 ? axes[2] : axes[0];
      const turnX = Math.abs(axX) > SNAP_DEAD_ZONE ? axX : 0;

      if (turnX !== 0 && this.snapCooldown <= 0) {
        const snapDir = turnX > 0 ? -1 : 1;
        this.dolly.rotation.y += SNAP_ANGLE * snapDir;
        this.snapCooldown = SNAP_COOLDOWN;
      }
    }
  }

  /** Right thumbstick Y in AR mode: scale the model up/down. */
  private updateARScale(dt: number): void {
    if (!this.sceneContent || !this.viewer) return;
    if (this.infoPanel && !this.infoPanelDismissed) return;

    const session = this.glRenderer!.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'right') continue;
      const axes = source.gamepad.axes;

      const axY = axes.length > 3 ? axes[3] : axes[1];
      const scaleInput = Math.abs(axY) > DEAD_ZONE ? axY : 0;
      if (scaleInput === 0) continue;

      // Stick up (negative Y) = scale up, stick down = scale down
      const factor = Math.pow(AR_SCALE_SPEED, -scaleInput * dt);
      this.arScale = Math.max(AR_MIN_SCALE, Math.min(AR_MAX_SCALE, this.arScale * factor));
      this.sceneContent.scale.setScalar(this.arScale);
    }
  }

  // ─── Hit-test surface placement ───────────────────────────────────────

  /** Request WebXR hit-test source for surface detection. */
  private async requestHitTest(session: XRSession): Promise<void> {
    try {
      if (typeof (session as any).requestHitTestSource !== 'function') {
        console.warn('[WebXR] Session does not support requestHitTestSource — hit-test feature may not be enabled');
        this.placeModelDefault();
        return;
      }
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = await (session as any).requestHitTestSource({ space: viewerSpace });
      if (!this.hitTestSource) {
        console.warn('[WebXR] requestHitTestSource returned null');
        this.placeModelDefault();
        return;
      }
      this.hitTestMode = true;
      console.log('[WebXR] Hit-test source created successfully');

      // Create reticle mesh (green ring on detected surfaces)
      this.hitReticle = this.createHitReticle();
      this.viewer!.scene.add(this.hitReticle);

      // Start per-frame hit-test loop
      this.startHitTestLoop(session);
    } catch (e) {
      console.warn('[WebXR] Hit-test not supported:', e);
      this.placeModelDefault();
    }
  }

  /** Create a ring reticle that appears on detected surfaces. */
  private createHitReticle(): Group {
    const group = new Group();
    group.visible = false;

    // Outer ring — enlarged (matches three.js AR example). depthTest:false +
    // renderOrder so the reticle is never occluded by camera-near geometry
    // or z-fights with the detected ground plane.
    const ringGeo = new RingGeometry(0.15, 0.20, 32).rotateX(-Math.PI / 2);
    const ringMat = new MeshBasicMaterial({
      color: 0x81c784, transparent: true, opacity: 0.95, side: DoubleSide,
      depthTest: false, depthWrite: false,
    });
    const ring = new Mesh(ringGeo, ringMat);
    ring.renderOrder = 9998;
    group.add(ring);

    // Center dot
    const dotGeo = new CircleGeometry(0.03, 16).rotateX(-Math.PI / 2);
    const dotMat = new MeshBasicMaterial({
      color: 0x81c784, transparent: true, opacity: 0.75, side: DoubleSide,
      depthTest: false, depthWrite: false,
    });
    const dot = new Mesh(dotGeo, dotMat);
    dot.renderOrder = 9998;
    group.add(dot);

    return group;
  }

  /** Per-frame hit-test loop using session.requestAnimationFrame. */
  private startHitTestLoop(session: XRSession): void {
    let frameCount = 0;
    let firstHitLogged = false;
    const onFrame = (_time: number, frame: unknown): void => {
      if (!this.hitTestMode || !this.hitTestSource) return;

      const refSpace = this.glRenderer?.xr.getReferenceSpace();
      if (!refSpace) {
        session.requestAnimationFrame(onFrame as XRFrameRequestCallback);
        return;
      }

      frameCount++;
      try {
        const results = (frame as any).getHitTestResults(this.hitTestSource);
        if (results.length > 0) {
          const pose = results[0].getPose(refSpace);
          if (pose && this.hitReticle) {
            if (!firstHitLogged) {
              firstHitLogged = true;
            }
            this.hitReticle.visible = true;
            const p = pose.transform.position;
            const q = pose.transform.orientation;
            this.hitReticle.position.set(p.x, p.y, p.z);
            this.hitReticle.quaternion.set(q.x, q.y, q.z, q.w);
            this.lastHitSeen = true;
            this.lastHitTime = performance.now();
          }
        } else if (this.hitReticle) {
          this.hitReticle.visible = false;
          // Diagnostic hint if ARCore isn't detecting surfaces after ~5s
          if (!firstHitLogged && frameCount === 300) {
            console.warn('[WebXR] No surfaces detected after ~5s. '
              + 'Move the device slowly left-right; ensure the floor has visible texture and good lighting.');
          }
        }
      } catch (_e) {
        // Hit-test results not available on every frame (transient, don't spam console)
      }

      session.requestAnimationFrame(onFrame as XRFrameRequestCallback);
    };
    session.requestAnimationFrame(onFrame as XRFrameRequestCallback);
  }

  /** Place model at the hit-test reticle position. */
  private placeModelAtReticle(): void {
    if (!this.hitReticle || !this.sceneContent || !this.modelBoundingBox) return;

    const center = new Vector3();
    const size = new Vector3();
    this.modelBoundingBox.getCenter(center);
    this.modelBoundingBox.getSize(size);

    // Auto-scale model to table-top size (~0.8 m diagonal) on first placement,
    // so large industrial scenes (factory floors, production lines) fit into a
    // typical room without the user ending up inside the model. Users can still
    // pinch-to-scale up to full 1:1 after placement (AR_MAX_SCALE = 5x of auto-fit).
    const maxHoriz = Math.max(size.x, size.z, 0.001);
    const TARGET_AR_SIZE = 0.8;  // 80 cm across
    if (this.arScale === 1.0 && maxHoriz > TARGET_AR_SIZE) {
      this.arScale = TARGET_AR_SIZE / maxHoriz;
      this.sceneContent.scale.setScalar(this.arScale);
      this.updateScaleBadge();
      console.log('[WebXR] Auto-scaled model:', this.arScale.toFixed(3),
        `(original ${maxHoriz.toFixed(2)}m → ${TARGET_AR_SIZE}m)`);
    }

    // Position model so its bottom-center aligns with the reticle.
    // Bounding box coords are in pre-scale space, so multiply by current arScale.
    this.sceneContent.position.set(
      this.hitReticle.position.x - center.x * this.arScale,
      this.hitReticle.position.y - this.modelBoundingBox.min.y * this.arScale,
      this.hitReticle.position.z - center.z * this.arScale,
    );
    this.sceneContent.visible = true;

    console.log('[WebXR] Placed at scale', this.arScale.toFixed(3),
      `(bbox ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}m)`);

    // Exit hit-test mode
    this.hitTestMode = false;
    this.hitReticle.visible = false;
    if (this.hitTestSource) {
      try { (this.hitTestSource as { cancel(): void }).cancel(); } catch (_) { /* ok */ }
      this.hitTestSource = null;
    }

    // Show placement controls, hide instruction
    if (this.instructionEl) this.instructionEl.style.display = 'none';
    if (this.placementBtn) this.placementBtn.style.display = '';
    if (this.scaleBadge) this.scaleBadge.style.display = '';
    if (this.replaceBtn) this.replaceBtn.style.display = '';

    // Enter adjustment mode by default after placing
    this.placementMode = true;
    this.updatePlacementButton(true);
  }

  /** Fallback: place model 2m in front when hit-test is unavailable. */
  private placeModelDefault(): void {
    if (!this.sceneContent || !this.modelBoundingBox) return;

    const center = new Vector3();
    this.modelBoundingBox.getCenter(center);
    this.sceneContent.position.set(-center.x, -this.modelBoundingBox.min.y, -2.0 - center.z);
    this.sceneContent.visible = true;

    this.hitTestMode = false;
    if (this.instructionEl) this.instructionEl.style.display = 'none';
    if (this.placementBtn) this.placementBtn.style.display = '';
    if (this.scaleBadge) this.scaleBadge.style.display = '';
    if (this.replaceBtn) this.replaceBtn.style.display = '';
  }

  /** Re-enter hit-test mode to place the model on a new surface. */
  private reenterHitTest(): void {
    if (!this.sceneContent || !this.viewer) return;

    // Hide model and placement controls
    this.sceneContent.visible = false;
    this.placementMode = false;
    if (this.placementBtn) this.placementBtn.style.display = 'none';
    if (this.scaleBadge) this.scaleBadge.style.display = 'none';
    if (this.replaceBtn) this.replaceBtn.style.display = 'none';
    if (this.instructionEl) this.instructionEl.style.display = '';

    // Pause simulation again while user picks a new surface
    this.viewer.setSimulationPaused('ar-placement', true);

    // Re-start hit-test
    const session = this.glRenderer!.xr.getSession();
    if (session) {
      this.requestHitTest(session);
    }
  }

  // ─── Mobile AR touch UI & gestures ────────────────────────────────────

  /** Setup touch listeners and overlay UI for mobile AR gestures. */
  private setupMobileARTouch(overlay: HTMLDivElement): void {
    // Overlay captures touches (for hit-test tap and placement gestures)
    overlay.style.pointerEvents = 'auto';
    this.placementMode = false;

    // --- Overlay UI buttons ---
    const btnStyle = 'pointer-events:auto;border:none;border-radius:24px;font-weight:700;'
      + 'font-family:system-ui,sans-serif;cursor:pointer;letter-spacing:0.5px;';

    // Exit AR button (top-left) — always visible
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'Exit AR';
    exitBtn.style.cssText = `${btnStyle}position:fixed;top:16px;left:16px;z-index:10001;`
      + 'padding:10px 20px;font-size:14px;background:rgba(239,83,80,0.85);color:#fff;';
    exitBtn.addEventListener('click', () => {
      this.glRenderer?.xr.getSession()?.end();
    });
    overlay.appendChild(exitBtn);

    // Instruction text (shown during hit-test mode)
    this.instructionEl = document.createElement('div');
    this.instructionEl.textContent = 'Point at a surface \u00b7 Tap to place';
    this.instructionEl.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);'
      + 'z-index:10001;padding:12px 24px;border-radius:16px;background:rgba(0,0,0,0.7);'
      + 'color:#81c784;font:bold 15px system-ui,sans-serif;white-space:nowrap;pointer-events:none;';
    overlay.appendChild(this.instructionEl);

    // Place mode toggle (bottom-center) — hidden until model is placed
    this.placementBtn = document.createElement('button');
    this.updatePlacementButton(false);
    this.placementBtn.style.cssText = `${btnStyle}position:fixed;bottom:24px;left:50%;`
      + 'transform:translateX(-50%);z-index:10001;padding:12px 28px;font-size:15px;'
      + 'box-shadow:0 4px 20px rgba(0,0,0,0.3);display:none;';
    this.placementBtn.addEventListener('click', () => {
      // Double-tap detection: reset scale to 1:1
      const now = Date.now();
      if (now - this.lastPlaceBtnTap < 400) {
        this.arScale = 1.0;
        if (this.sceneContent) this.sceneContent.scale.setScalar(1.0);
        this.updateScaleBadge();
        this.lastPlaceBtnTap = 0;
        return;
      }
      this.lastPlaceBtnTap = now;

      this.placementMode = !this.placementMode;
      this.updatePlacementButton(this.placementMode);
      // Freeze simulation while in placement/adjustment mode, resume when "Done"
      this.viewer?.setSimulationPaused('ar-placement', this.placementMode);
    });
    overlay.appendChild(this.placementBtn);

    // Scale badge (bottom, above place button) — hidden until model is placed
    this.scaleBadge = document.createElement('div');
    this.scaleBadge.style.cssText = 'pointer-events:none;position:fixed;bottom:76px;left:50%;'
      + 'transform:translateX(-50%);z-index:10001;padding:4px 12px;border-radius:12px;'
      + 'background:rgba(0,0,0,0.6);color:#81c784;font:bold 12px system-ui,sans-serif;display:none;';
    this.updateScaleBadge();
    overlay.appendChild(this.scaleBadge);

    // Re-place button (top-right) — hidden until model is placed
    this.replaceBtn = document.createElement('button');
    this.replaceBtn.textContent = '\u21BB Re-place';
    this.replaceBtn.style.cssText = `${btnStyle}position:fixed;top:16px;right:16px;z-index:10001;`
      + 'padding:10px 18px;font-size:13px;background:rgba(129,199,132,0.85);color:#000;display:none;';
    this.replaceBtn.addEventListener('click', () => this.reenterHitTest());
    overlay.appendChild(this.replaceBtn);

    // --- Touch gesture handlers ---
    const handlers = {
      start: (e: TouchEvent) => {
        // Never block button clicks
        if ((e.target as HTMLElement).closest('button')) return;

        if (this.hitTestMode) {
          // In hit-test mode: record position for tap detection
          e.preventDefault();
          if (e.touches.length === 1) {
            this.touchState.lastX = e.touches[0].clientX;
            this.touchState.lastY = e.touches[0].clientY;
          }
          return;
        }

        if (!this.placementMode) {
          // Not in placement mode: track touch start for tap-to-select
          if (e.touches.length === 1) {
            this.touchState.lastX = e.touches[0].clientX;
            this.touchState.lastY = e.touches[0].clientY;
          }
          return;
        }
        e.preventDefault();
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          this.touchState.lastPinchDist = Math.hypot(dx, dy);
          this.touchState.lastAngle = Math.atan2(dy, dx);
          this.touchState.count = 2;
        } else if (e.touches.length === 1) {
          this.touchState.lastX = e.touches[0].clientX;
          this.touchState.lastY = e.touches[0].clientY;
          this.touchState.count = 1;
        }
      },
      move: (e: TouchEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        if (this.hitTestMode) { e.preventDefault(); return; }
        if (!this.placementMode) return;
        e.preventDefault();
        if (!this.sceneContent || !this.viewer) return;

        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);

          if (this.touchState.lastPinchDist > 0) {
            // Pinch to scale
            const factor = dist / this.touchState.lastPinchDist;
            this.arScale = Math.max(AR_MIN_SCALE, Math.min(AR_MAX_SCALE, this.arScale * factor));
            this.sceneContent.scale.setScalar(this.arScale);
            this.updateScaleBadge();

            // Two-finger rotate
            const angleDelta = angle - this.touchState.lastAngle;
            this.sceneContent.rotation.y -= angleDelta;
          }
          this.touchState.lastPinchDist = dist;
          this.touchState.lastAngle = angle;
          this.touchState.count = 2;
        } else if (e.touches.length === 1 && this.touchState.count !== 2) {
          // One-finger drag to move model (camera-relative)
          const sdx = e.touches[0].clientX - this.touchState.lastX;
          const sdy = e.touches[0].clientY - this.touchState.lastY;

          const cam = this.glRenderer!.xr.getCamera();
          const camDir = new Vector3();
          cam.getWorldDirection(camDir);
          camDir.y = 0;
          camDir.normalize();
          const camRight = new Vector3(-camDir.z, 0, camDir.x);

          // 1px ≈ 1mm world movement
          const s = 0.001;
          this.sceneContent.position.x += (camRight.x * sdx - camDir.x * sdy) * s;
          this.sceneContent.position.z += (camRight.z * sdx - camDir.z * sdy) * s;

          this.touchState.lastX = e.touches[0].clientX;
          this.touchState.lastY = e.touches[0].clientY;
        }
      },
      end: (e: TouchEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;

        if (this.hitTestMode && e.changedTouches.length > 0) {
          // Detect tap: touchend close to touchstart position → place model.
          // Tolerant: accept taps up to 40 CSS-px movement (Android taps drift a bit)
          // and don't require the reticle to be visible *this frame* — ARCore hit-test
          // results are intermittent. We use the last known good hit if it was seen
          // within 500 ms, so the tap feels responsive even in gap frames.
          const ct = e.changedTouches[0];
          const dx = ct.clientX - this.touchState.lastX;
          const dy = ct.clientY - this.touchState.lastY;
          const dist = Math.hypot(dx, dy);
          const recentHit = this.lastHitSeen
            && (performance.now() - this.lastHitTime) < 500;
          if (dist < 40 && (this.hitReticle?.visible || recentHit)) {
            this.placeModelAtReticle();
          }
          return;
        }

        if (!this.placementMode) {
          // Not in placement mode: detect tap for drive selection
          if (e.changedTouches.length > 0) {
            const ct = e.changedTouches[0];
            const dx = ct.clientX - this.touchState.lastX;
            const dy = ct.clientY - this.touchState.lastY;
            if (Math.hypot(dx, dy) < 20) {
              this.arTapSelect(ct.clientX, ct.clientY);
            }
          }
          return;
        }
        if (e.touches.length < 2) this.touchState.lastPinchDist = 0;
        if (e.touches.length === 1) {
          this.touchState.lastX = e.touches[0].clientX;
          this.touchState.lastY = e.touches[0].clientY;
        }
        this.touchState.count = e.touches.length;
      },
    };

    overlay.addEventListener('touchstart', handlers.start, { passive: false });
    overlay.addEventListener('touchmove', handlers.move, { passive: false });
    overlay.addEventListener('touchend', handlers.end);
    this.arTouchHandlers = handlers;
  }

  private updatePlacementButton(active: boolean): void {
    if (!this.placementBtn) return;
    this.placementBtn.textContent = active ? 'Done' : 'Place';
    this.placementBtn.style.background = active
      ? 'rgba(79, 195, 247, 0.9)' : 'rgba(129, 199, 132, 0.9)';
    this.placementBtn.style.color = '#000';
  }

  private updateScaleBadge(): void {
    if (!this.scaleBadge) return;
    const pct = Math.round(this.arScale * 100);
    this.scaleBadge.textContent = `${pct}%`;
  }

  /** Remove touch listeners, overlay UI, and DOM overlay. */
  private teardownMobileARTouch(): void {
    if (this.arOverlay && this.arTouchHandlers) {
      this.arOverlay.removeEventListener('touchstart', this.arTouchHandlers.start);
      this.arOverlay.removeEventListener('touchmove', this.arTouchHandlers.move);
      this.arOverlay.removeEventListener('touchend', this.arTouchHandlers.end);
      this.arTouchHandlers = null;
    }
    if (this.arOverlay) {
      // Restore #react-root back to document.body before removing overlay
      const reactRoot = document.getElementById('react-root');
      if (reactRoot && this.arOverlay.contains(reactRoot)) {
        document.body.appendChild(reactRoot);
      }
      this.arOverlay.remove();
      this.arOverlay = null;
    }
    if (this.arStyleEl) {
      this.arStyleEl.remove();
      this.arStyleEl = null;
    }
    this.placementBtn = null;
    this.scaleBadge = null;
    this.replaceBtn = null;
    this.instructionEl = null;
    this.placementMode = false;
    this.hitTestMode = false;
    this.clearARSelection();
  }

  // ─── AR drive selection & tooltip ──────────────────────────────────────

  /**
   * Raycast from a screen-space touch position and select/highlight the drive.
   * Uses multi-point sampling (center + 8 surrounding points) for easier tapping.
   * If no drive is hit, clears the current selection.
   */
  private arTapSelect(clientX: number, clientY: number): void {
    if (!this.viewer || !this.viewer.registry || !this.glRenderer) return;
    const renderer = this.glRenderer;
    const xrCamera = renderer.xr.isPresenting
      ? renderer.xr.getCamera() as import('three').PerspectiveCamera
      : undefined;

    // Delegate to RaycastManager's 9-point AR tap sampling
    if (this.viewer.raycastManager) {
      const result = this.viewer.raycastManager.arTapRaycast(clientX, clientY, xrCamera);

      if (!result || result.nodeType !== 'Drive') {
        this.clearARSelection();
        return;
      }

      const drive = this.viewer.registry.findInParent<import('../core/engine/rv-drive').RVDrive>(result.node, 'Drive');
      if (!drive) {
        this.clearARSelection();
        return;
      }

      // Same drive already selected — ignore
      if (drive === this.arSelectedDrive) return;

      this.clearARSelection();
      this.arSelectedDrive = drive;
      this.viewer.highlighter.highlight(drive.node, true, { includeChildDrives: true });
      this.showARTooltip(drive, clientX, clientY);
    }
  }

  /** Show a tooltip for the selected drive using the generic tooltip system. */
  private showARTooltip(drive: import('../core/engine/rv-drive').RVDrive, x: number, y: number): void {
    this.removeARTooltip();
    tooltipStore.show({
      id: 'ar-drive',
      data: { type: 'drive', driveName: drive.name },
      mode: 'fixed',
      fixedPos: { x, y },
      priority: 20, // Higher than normal drive tooltip
    });
  }

  private clearARSelection(): void {
    if (this.arSelectedDrive) {
      this.viewer?.highlighter.clear();
      this.arSelectedDrive = null;
    }
    this.removeARTooltip();
  }

  private removeARTooltip(): void {
    tooltipStore.hide('ar-drive');
  }

  private removeInfoPanel(): void {
    if (!this.infoPanel) return;
    this.infoPanel.removeFromParent();
    const mat = this.infoPanel.material as MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.infoPanel.geometry.dispose();
    this.infoPanel = null;
  }

  // ── Public getters for controller positions (Phase 2: multiuser VR avatar) ──

  /** True while a VR or AR session is active. */
  get isPresenting(): boolean { return this.presenting; }

  /** Current session mode: 'none' | 'vr' | 'ar'. */
  get currentSessionMode(): SessionMode { return this.sessionMode; }

  /**
   * World position of the left controller, or null when not presenting.
   * The returned Vector3 is a snapshot (cloned) — safe to cache for one frame.
   */
  getLeftControllerPosition(): Vector3 | null {
    if (!this.leftController || !this.presenting) return null;
    const v = new Vector3();
    this.leftController.getWorldPosition(v);
    return v;
  }

  /**
   * World position of the right controller, or null when not presenting.
   * The returned Vector3 is a snapshot (cloned) — safe to cache for one frame.
   */
  getRightControllerPosition(): Vector3 | null {
    if (!this.rightController || !this.presenting) return null;
    const v = new Vector3();
    this.rightController.getWorldPosition(v);
    return v;
  }

  /**
   * Camera-rig (dolly) group, or null before XR is initialised.
   * Read-only — do not modify.
   */
  getDolly(): Group | null { return this.dolly; }

  dispose(): void {
    // Release any held simulation pause — plugin teardown must never leave
    // the simulation frozen for the next model/plugin instance.
    this.viewer?.setSimulationPaused('ar-placement', false);

    if (this.vrButton) { this.vrButton.remove(); this.vrButton = null; }
    if (this.arButton) { this.arButton.remove(); this.arButton = null; }
    if (this.teleportReticle) {
      this.teleportReticle.removeFromParent();
      this.teleportReticle.traverse((child) => {
        if (child instanceof Mesh) {
          child.geometry.dispose();
          (child.material as MeshBasicMaterial).dispose();
        }
      });
      this.teleportReticle = null;
    }
    if (this.teleportArc) {
      this.teleportArc.removeFromParent();
      this.teleportArc.geometry.dispose();
      (this.teleportArc.material as LineBasicMaterial).dispose();
      this.teleportArc = null;
    }
    this.removeInfoPanel();
    this.teardownMobileARTouch();
    if (this.hitReticle) {
      this.hitReticle.removeFromParent();
      this.hitReticle.traverse((child) => {
        if (child instanceof Mesh) {
          child.geometry.dispose();
          (child.material as MeshBasicMaterial).dispose();
        }
      });
      this.hitReticle = null;
    }
    this.hitTestSource = null;
    if (this.dolly && this.viewer) {
      this.viewer.scene.add(this.viewer.camera);
      this.viewer.scene.remove(this.dolly);
    }
    this.dolly = null;
    this.rightController = null;
    this.leftController = null;
    this.presenting = false;
    this.sessionMode = 'none';
    this.viewer = null;
    this.initialized = false;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
