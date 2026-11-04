// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-gizmo.ts -- Virtual component visualization.
 *
 * Renders wireframe boxes, entry/exit point spheres, connection lines,
 * and name labels for DES components that have no visual mesh.
 * Used in Animated mode for debugging and layout visualization.
 *
 * Uses simple Three.js primitives — no external dependencies.
 */

import {
  BoxGeometry,
  SphereGeometry,
  BufferGeometry,
  LineBasicMaterial,
  MeshBasicMaterial,
  WireframeGeometry,
  LineSegments,
  Mesh,
  Group,
  Vector3,
  Float32BufferAttribute,
} from 'three';
import type { Scene } from 'three';
import type { DESComponent } from './rv-des-component';

// ── Shared materials (created once) ──

const WIRE_MAT = new LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.6 });
const IN_MAT = new MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.7 });
const OUT_MAT = new MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.7 });
const CONN_MAT = new LineBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.5 });

// ── Shared geometries ──

const SPHERE_GEO = new SphereGeometry(0.033, 8, 6);
const BOX_GEO = new WireframeGeometry(new BoxGeometry(1, 1, 1));

// ── Temp vectors ──

const _a = new Vector3();
const _b = new Vector3();

/**
 * DESGizmoRenderer — manages gizmo visualizations for DES components.
 *
 * Call update() each frame in Animated mode. The renderer creates/disposes
 * Three.js objects as needed and pools connection lines.
 */
export class DESGizmoRenderer {
  private group: Group;
  private gizmos = new Map<DESComponent, Group>();

  constructor(scene: Scene) {
    this.group = new Group();
    this.group.name = '__DES_Gizmos';
    scene.add(this.group);
  }

  /**
   * Update gizmos for all components.
   * Creates gizmos for virtual components (no mesh), removes stale ones.
   */
  update(components: DESComponent[]): void {
    const active = new Set<DESComponent>();

    for (const comp of components) {
      active.add(comp);

      if (!comp.hasVisualMesh) {
        let g = this.gizmos.get(comp);
        if (!g) {
          g = this.createGizmo(comp);
          this.gizmos.set(comp, g);
          this.group.add(g);
        }
        this.updateGizmo(comp, g);
      }
    }

    // Remove gizmos for removed components
    for (const [comp, g] of this.gizmos) {
      if (!active.has(comp)) {
        this.group.remove(g);
        this.gizmos.delete(comp);
      }
    }

    // Update connection lines (separate pass — connections may cross components)
    this.updateConnectionLines(components);
  }

  dispose(): void {
    for (const [, g] of this.gizmos) {
      this.group.remove(g);
    }
    this.gizmos.clear();
    this.group.parent?.remove(this.group);
  }

  // ── Internal ──

  private createGizmo(comp: DESComponent): Group {
    const g = new Group();
    g.name = `Gizmo_${comp.node.name}`;

    // Wireframe box
    const wire = new LineSegments(BOX_GEO, WIRE_MAT);
    wire.name = 'wire';
    g.add(wire);

    // Entry sphere (green)
    const inSphere = new Mesh(SPHERE_GEO, IN_MAT);
    inSphere.name = 'in';
    g.add(inSphere);

    // Exit sphere (red)
    const outSphere = new Mesh(SPHERE_GEO, OUT_MAT);
    outSphere.name = 'out';
    g.add(outSphere);

    return g;
  }

  private updateGizmo(comp: DESComponent, g: Group): void {
    // Position wireframe at component
    const wire = g.getObjectByName('wire');
    if (wire) {
      comp.effectiveNode.getWorldPosition(wire.position);
    }

    // Position spheres
    const inSphere = g.getObjectByName('in');
    if (inSphere) {
      const inPos = comp.getInputPosition();
      inSphere.position.copy(inPos);
    }

    const outSphere = g.getObjectByName('out');
    if (outSphere) {
      const outPos = comp.getOutputPosition();
      outSphere.position.copy(outPos);
    }
  }

  /** Connection line pool */
  private connectionLines: LineSegments[] = [];
  private activeConnectionCount = 0;

  private updateConnectionLines(components: DESComponent[]): void {
    let lineIdx = 0;

    for (const comp of components) {
      for (const next of comp.nextComponents) {
        const outPos = comp.getOutputPosition();
        const inPos = next.getInputPosition();
        _a.copy(outPos);
        _b.copy(inPos);

        let line: LineSegments;
        if (lineIdx < this.connectionLines.length) {
          line = this.connectionLines[lineIdx];
        } else {
          const geo = new BufferGeometry();
          geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
          line = new LineSegments(geo, CONN_MAT);
          line.name = 'conn';
          this.connectionLines.push(line);
          this.group.add(line);
        }

        const posAttr = line.geometry.getAttribute('position');
        const arr = posAttr.array as Float32Array;
        arr[0] = _a.x; arr[1] = _a.y; arr[2] = _a.z;
        arr[3] = _b.x; arr[4] = _b.y; arr[5] = _b.z;
        posAttr.needsUpdate = true;
        line.visible = true;

        lineIdx++;
      }
    }

    // Hide unused lines
    for (let i = lineIdx; i < this.connectionLines.length; i++) {
      this.connectionLines[i].visible = false;
    }
    this.activeConnectionCount = lineIdx;
  }
}
