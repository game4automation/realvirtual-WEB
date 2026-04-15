// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVXRHitTester — AR surface detection and model placement.
 * Uses WebXR Hit Test API to show a reticle on detected surfaces.
 */
import {
  RingGeometry,
  MeshBasicMaterial,
  Mesh,
  Scene,
  Vector3,
  Object3D,
} from 'three';

export class RVXRHitTester {
  private reticle: Mesh;
  private hitTestSource: XRHitTestSource | null = null;
  private hitTestSourceRequested = false;

  constructor(scene: Scene) {
    const geometry = new RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
    const material = new MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8 });
    this.reticle = new Mesh(geometry, material);
    this.reticle.visible = false;
    this.reticle.matrixAutoUpdate = false;
    scene.add(this.reticle);
  }

  get reticleMesh(): Mesh { return this.reticle; }

  update(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    if (!this.hitTestSourceRequested) {
      this.hitTestSourceRequested = true;
      const session = frame.session;
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource?.({ space: viewerSpace })?.then((source: XRHitTestSource) => {
          this.hitTestSource = source;
        });
      });
    }
    if (!this.hitTestSource) return;
    const results = frame.getHitTestResults(this.hitTestSource);
    if (results.length > 0) {
      const hit = results[0];
      const pose = hit.getPose(referenceSpace);
      if (pose) {
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
      }
    } else {
      this.reticle.visible = false;
    }
  }

  placeModel(model: Object3D): boolean {
    if (!this.reticle.visible) return false;
    const pos = new Vector3();
    pos.setFromMatrixPosition(this.reticle.matrix);
    model.position.copy(pos);
    return true;
  }

  reset(): void {
    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.reticle.visible = false;
  }

  dispose(scene: Scene): void {
    scene.remove(this.reticle);
    this.reticle.geometry.dispose();
    (this.reticle.material as MeshBasicMaterial).dispose();
    this.reset();
  }
}
