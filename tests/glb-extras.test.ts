// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GLB Extras Parsing Tests (Browser Mode)
 *
 * Runs in a real browser via Vitest + Playwright.
 * Uses Three.js GLTFLoader to load tests.glb from the dev server,
 * then verifies all realvirtual component data needed for WebViewer simulation.
 *
 * Export the demo scene GLB from Unity and place at: public/models/tests.glb
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Scene, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ─── GLB Loading Helper ────────────────────────────────────────────

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

interface RVNode {
  name: string;
  path: string;
  node: Object3D;
  rv: Record<string, Record<string, unknown>>;
}

let allRVNodes: RVNode[] = [];
let scene: Scene;
let loadError: string | null = null;

function getPath(node: Object3D): string {
  const parts: string[] = [];
  let current: Object3D | null = node;
  while (current && current.parent) {
    parts.unshift(current.name);
    current = current.parent;
  }
  return parts.join('/');
}

function getNodesWithComponent(type: string): RVNode[] {
  return allRVNodes.filter(n => n.rv[type] != null);
}

function getComponentData(rvNode: RVNode, type: string): Record<string, unknown> {
  return rvNode.rv[type] as Record<string, unknown>;
}

function requireGLB(): void {
  if (loadError) {
    throw new Error(`GLB not available: ${loadError}. Export demo scene and place at public/models/tests.glb`);
  }
}

// ─── Load GLB before all tests ─────────────────────────────────────

beforeAll(async () => {
  scene = new Scene();

  // Check if file exists and has content
  try {
    const headResp = await fetch('/models/tests.glb', { method: 'HEAD' });
    if (!headResp.ok) {
      loadError = `HTTP ${headResp.status} - file not found`;
      return;
    }
    const contentLength = headResp.headers.get('content-length');
    if (contentLength && parseInt(contentLength) < 100) {
      loadError = `File too small (${contentLength} bytes) - probably empty placeholder`;
      return;
    }
  } catch (e) {
    loadError = `Fetch failed: ${e}`;
    return;
  }

  try {
    const gltf = await gltfLoader.loadAsync('/models/tests.glb');
    scene.add(gltf.scene);

    // Collect all nodes with realvirtual extras
    gltf.scene.traverse((node: Object3D) => {
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv) {
        allRVNodes.push({
          name: node.name,
          path: getPath(node),
          node,
          rv,
        });
      }
    });

    console.log(`Loaded tests.glb: ${allRVNodes.length} nodes with realvirtual data`);
  } catch (e) {
    loadError = `GLTFLoader failed: ${e}`;
  }
}, 30000); // 30s timeout for loading

// ─── Basic Structure ───────────────────────────────────────────────

describe('GLB structure', () => {
  it('should load tests.glb successfully', () => {
    requireGLB();
  });

  it('should have loaded nodes with realvirtual extras', () => {
    requireGLB();
    expect(allRVNodes.length).toBeGreaterThan(0);
  });

  it('should list all component types found', () => {
    requireGLB();
    const typeCounts = new Map<string, number>();
    for (const n of allRVNodes) {
      for (const key of Object.keys(n.rv)) {
        typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
      }
    }
    const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log('Component types in GLB:');
    for (const [type, count] of sorted) {
      console.log(`  ${type}: ${count}`);
    }
    expect(typeCounts.size).toBeGreaterThan(0);
  });
});

// ─── Drive Components ──────────────────────────────────────────────

describe('Drive extras', () => {
  it('should find Drive components', () => {
    requireGLB();
    const drives = getNodesWithComponent('Drive');
    expect(drives.length).toBeGreaterThan(0);
    console.log(`Found ${drives.length} drives`);
  });

  it('should have Direction on all drives', () => {
    requireGLB();
    for (const n of getNodesWithComponent('Drive')) {
      const d = getComponentData(n, 'Drive');
      expect(d['Direction'], `Drive "${n.path}" missing Direction`).toBeDefined();
      expect(typeof d['Direction']).toBe('string');
    }
  });

  it('should have TargetSpeed on all drives', () => {
    requireGLB();
    for (const n of getNodesWithComponent('Drive')) {
      const d = getComponentData(n, 'Drive');
      expect(d['TargetSpeed'], `Drive "${n.path}" missing TargetSpeed`).toBeDefined();
    }
  });
});

// ─── TransportSurface Components ───────────────────────────────────

describe('TransportSurface extras', () => {
  it('should find TransportSurface components', () => {
    requireGLB();
    const surfaces = getNodesWithComponent('TransportSurface');
    expect(surfaces.length).toBeGreaterThan(0);
    console.log(`Found ${surfaces.length} transport surfaces:`);
    for (const s of surfaces) {
      console.log(`  ${s.path}`);
    }
  });

  it('should log all TransportSurface properties', () => {
    requireGLB();
    const surfaces = getNodesWithComponent('TransportSurface');
    for (const s of surfaces) {
      const data = getComponentData(s, 'TransportSurface');
      console.log(`TransportSurface "${s.path}":`);
      for (const [key, val] of Object.entries(data)) {
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  ${key}: ${display}`);
      }
    }
  });

  it('should have TransportDirection for movement vector', () => {
    requireGLB();
    for (const s of getNodesWithComponent('TransportSurface')) {
      const data = getComponentData(s, 'TransportSurface');
      expect(data['TransportDirection'], `"${s.path}" missing TransportDirection`).toBeDefined();
      const dir = data['TransportDirection'] as Record<string, number>;
      console.log(`  "${s.path}": TransportDirection=(${dir.x?.toFixed(3)}, ${dir.y?.toFixed(3)}, ${dir.z?.toFixed(3)})`);
    }
  });

  it('should have Drive on same node or parent for speed/direction', () => {
    requireGLB();
    for (const s of getNodesWithComponent('TransportSurface')) {
      const hasDrive = s.rv['Drive'] != null;
      if (!hasDrive) {
        let parent = s.node.parent;
        let foundOnParent = false;
        while (parent) {
          if (parent.userData?.realvirtual?.Drive) {
            foundOnParent = true;
            console.log(`  "${s.path}": Drive found on parent "${parent.name}"`);
            break;
          }
          parent = parent.parent;
        }
        if (!foundOnParent) {
          console.warn(`  WARNING: "${s.path}" has no Drive on same node or any parent!`);
        }
      }
    }
  });

  it('should have collider data for AABB computation', () => {
    requireGLB();
    for (const s of getNodesWithComponent('TransportSurface')) {
      const hasBoxCollider = s.rv['BoxCollider'] != null;
      const hasColliders = Array.isArray(s.rv['colliders']) && (s.rv['colliders'] as unknown[]).length > 0;
      if (!hasBoxCollider && !hasColliders) {
        console.warn(`  "${s.path}": no collider data - will fallback to mesh bounds`);
      }
    }
  });
});

// ─── Sensor Components ─────────────────────────────────────────────

describe('Sensor extras', () => {
  it('should find Sensor components', () => {
    requireGLB();
    const sensors = getNodesWithComponent('Sensor');
    expect(sensors.length).toBeGreaterThan(0);
    console.log(`Found ${sensors.length} sensors:`);
    for (const s of sensors) {
      console.log(`  ${s.path}`);
    }
  });

  it('should log all Sensor properties', () => {
    requireGLB();
    const sensors = getNodesWithComponent('Sensor');
    if (sensors.length > 0) {
      const data = getComponentData(sensors[0], 'Sensor');
      console.log(`Sensor "${sensors[0].path}" properties:`);
      for (const [key, val] of Object.entries(data)) {
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  ${key}: ${display}`);
      }
    }
  });

  it('should have collider data for AABB (box sensors only)', () => {
    requireGLB();
    for (const s of getNodesWithComponent('Sensor')) {
      const hasCollider = s.rv['BoxCollider'] != null ||
        (Array.isArray(s.rv['colliders']) && (s.rv['colliders'] as unknown[]).length > 0);
      if (!hasCollider) {
        // Not all sensors use BoxCollider (e.g., Raycast sensors)
        console.log(`  Sensor "${s.path}": no BoxCollider - may be Raycast sensor`);
      }
    }
  });
});

// ─── Source Components ─────────────────────────────────────────────

describe('Source extras', () => {
  it('should find Source components', () => {
    requireGLB();
    const sources = getNodesWithComponent('Source');
    expect(sources.length).toBeGreaterThan(0);
    console.log(`Found ${sources.length} sources`);
  });

  it('should log all Source properties', () => {
    requireGLB();
    for (const s of getNodesWithComponent('Source')) {
      const data = getComponentData(s, 'Source');
      console.log(`Source "${s.path}" properties:`);
      for (const [key, val] of Object.entries(data)) {
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  ${key}: ${display}`);
      }
    }
  });
});

// ─── Sink Components ───────────────────────────────────────────────

describe('Sink extras', () => {
  it('should find Sink components', () => {
    requireGLB();
    const sinks = getNodesWithComponent('Sink');
    expect(sinks.length).toBeGreaterThan(0);
    console.log(`Found ${sinks.length} sinks`);
  });

  it('should have collider data', () => {
    requireGLB();
    for (const s of getNodesWithComponent('Sink')) {
      const hasCollider = s.rv['BoxCollider'] != null ||
        (Array.isArray(s.rv['colliders']) && (s.rv['colliders'] as unknown[]).length > 0);
      if (!hasCollider) {
        console.warn(`  Sink "${s.path}": no collider data`);
      }
    }
  });
});

// ─── MU (Moving Unit) Templates ────────────────────────────────────

describe('MU extras', () => {
  it('should check for MU template nodes', () => {
    requireGLB();
    const mus = getNodesWithComponent('MU');
    console.log(`Found ${mus.length} MU nodes (templates for cloning)`);
    for (const m of mus) {
      console.log(`  ${m.path}`);
    }
    if (mus.length === 0) {
      console.warn('  No MU templates in GLB - Source will need fallback geometry');
    }
  });

  it('should log MU properties', () => {
    requireGLB();
    for (const m of getNodesWithComponent('MU')) {
      const data = getComponentData(m, 'MU');
      console.log(`MU "${m.path}" properties:`);
      for (const [key, val] of Object.entries(data)) {
        const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  ${key}: ${display}`);
      }
    }
  });
});

// ─── Drive-TransportSurface Association ────────────────────────────

describe('Drive-TransportSurface association', () => {
  it('should verify every TransportSurface can derive direction from a Drive', () => {
    requireGLB();
    const surfaces = getNodesWithComponent('TransportSurface');
    let allHaveDrive = true;

    for (const s of surfaces) {
      // Check same node
      if (s.rv['Drive']) {
        const drive = s.rv['Drive'] as Record<string, unknown>;
        console.log(`  "${s.path}": Drive on same node, Direction=${drive['Direction']}`);
        continue;
      }

      // Walk up hierarchy
      let parent = s.node.parent;
      let found = false;
      while (parent) {
        const parentDrive = parent.userData?.realvirtual?.Drive as Record<string, unknown> | undefined;
        if (parentDrive) {
          console.log(`  "${s.path}": Drive on parent "${parent.name}", Direction=${parentDrive['Direction']}`);
          found = true;
          break;
        }
        parent = parent.parent;
      }

      if (!found) {
        console.error(`  FAIL: "${s.path}" has NO Drive in hierarchy!`);
        allHaveDrive = false;
      }
    }

    expect(allHaveDrive, 'All TransportSurfaces must have a Drive in their hierarchy').toBe(true);
  });
});
