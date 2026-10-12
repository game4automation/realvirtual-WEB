// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, SphereGeometry, Vector3, HemisphereLight, DirectionalLight, Texture } from 'three';
import { gltfLoader } from '@rv/core/engine/rv-glb-parse';
import { cellIndex, type Cell, type MazeMap } from './maze-map';
import { disposeMazeObject } from './maze-vehicles';

export class MazeRender {
  readonly root = new Group();
  private readonly matrix = new Matrix4();
  private readonly instances: Array<{ mesh: InstancedMesh; index: number } | undefined>;
  constructor(private readonly map: MazeMap) {
    this.root.name = 'maze-environment';
    this.root.add(new HemisphereLight(0xa0d5ee, 0x171019, 0.6));
    const keyLight = new DirectionalLight(0xa2c7e8, 1.8); keyLight.position.set(4, 12, -2); this.root.add(keyLight);
    this.instances = new Array(map.rows * map.cols);
    const floor = new Mesh(new PlaneGeometry(map.cols * map.cellSize, map.rows * map.cellSize), new MeshStandardMaterial({ color: 0x030507, roughness: 1, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set((map.cols - 1) * map.cellSize / 2, -0.02, (map.rows - 1) * map.cellSize / 2);
    this.root.add(floor);
    this.createLanes();
    this.createPellets(map.pellets, false); this.createPellets(map.powerPellets, true);
    const depot = new Mesh(new BoxGeometry(map.cellSize * 0.8, 0.04, map.cellSize * 0.8), new MeshStandardMaterial({ color: 0x244a50, emissive: 0x22daca, emissiveIntensity: 0.5 }));
    depot.position.set(map.depot.c * map.cellSize, 0.01, map.depot.r * map.cellSize); this.root.add(depot);
  }
  private powerMaterial: MeshStandardMaterial | null = null;
  private pulseTime = 0;
  async loadPallets(url: string, seed = 42): Promise<void> {
    const gltf = await gltfLoader.loadAsync(url);
    try {
      gltf.scene.updateMatrixWorld(true);
      let source: Mesh | undefined;
      gltf.scene.traverse(node => { if (!source && node instanceof Mesh) source = node; });
      if (!source) throw new Error('Europallet contains no mesh.');
      // Copy only render data: never attach the Source/MU-bearing glTF nodes.
      const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!, size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
      geometry.translate(-center.x, -bounds.min.y, -center.z);
      geometry.scale(1, 0.144 / size.y, 1);
      const original = Array.isArray(source.material) ? source.material[0] : source.material;
      const material = original.clone();
      // The library pallet has no textures. Keep any future maps independently owned.
      for (const [key, value] of Object.entries(material)) {
        if (value instanceof Texture) {
          (material as unknown as Record<string, unknown>)[key] = value.clone();
        }
      }
      if (material instanceof MeshStandardMaterial) { material.roughness = 0.95; material.metalness = 0; }
      const count = this.map.walkable.flat().filter(walkable => !walkable).length;
      const mesh = new InstancedMesh(geometry, material, count * 4); mesh.name = 'pallet-walls';
      const random = (): number => {
        let value = seed += 0x6d2b79f5;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
      };
      let index = 0;
      for (let r = 0; r < this.map.rows; r++) for (let c = 0; c < this.map.cols; c++) {
        if (this.map.walkable[r][c]) continue;
        const angle = random() < 0.5 ? 0 : Math.PI / 2;
        const dx = (random() - 0.5) * 0.025, dz = (random() - 0.5) * 0.025;
        for (let layer = 0; layer < 4; layer++) {
          this.matrix.makeRotationY(angle);
          this.matrix.setPosition(c * this.map.cellSize + dx, layer * 0.144, r * this.map.cellSize + dz);
          mesh.setMatrixAt(index++, this.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); this.root.add(mesh);
    } finally { disposeMazeObject(gltf.scene); }
  }
  private createLanes(): void {
    const segments: Array<[number, number, boolean]> = [];
    for (let r = 0; r < this.map.rows; r++) for (let c = 0; c < this.map.cols; c++) {
      if (!this.map.walkable[r][c]) continue;
      if (this.map.walkable[r][c + 1]) segments.push([c + 0.5, r, false]);
      if (this.map.walkable[r + 1]?.[c]) segments.push([c, r + 0.5, true]);
    }
    const mesh = new InstancedMesh(new BoxGeometry(this.map.cellSize, 0.012, 0.035),
      new MeshStandardMaterial({ color: 0x1ce6cf, emissive: 0x13dac7, emissiveIntensity: 2.5 }), segments.length);
    mesh.name = 'neon-lanes';
    segments.forEach(([x, z, vertical], i) => {
      this.matrix.makeRotationY(vertical ? Math.PI / 2 : 0);
      this.matrix.setPosition(x * this.map.cellSize, 0.008, z * this.map.cellSize); mesh.setMatrixAt(i, this.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); this.root.add(mesh);
  }
  animate(dt: number): void {
    this.pulseTime += dt;
    if (this.powerMaterial) this.powerMaterial.emissiveIntensity = 2.5 + Math.sin(this.pulseTime * 4) * 1.2;
  }
  private createPellets(cells: Cell[], power: boolean): void {
    const size = power ? 0.22 : 0.075;
    const material = new MeshStandardMaterial({ color: 0xffd394, emissive: 0xffae45, emissiveIntensity: power ? 3 : 1.8 });
    if (power) this.powerMaterial = material;
    const mesh = new InstancedMesh(new SphereGeometry(size, 12, 8), material, cells.length);
    mesh.name = power ? 'open-source-pellets' : 'order-pellets';
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]; this.matrix.makeTranslation(cell.c * this.map.cellSize, 0.25, cell.r * this.map.cellSize);
      mesh.setMatrixAt(i, this.matrix); this.instances[cellIndex(this.map, cell)] = { mesh, index: i };
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); this.root.add(mesh);
  }
  collect(index: number): void {
    const instance = this.instances[index]; if (!instance) return;
    instance.mesh.setMatrixAt(instance.index, this.matrix.makeScale(0, 0, 0)); instance.mesh.instanceMatrix.needsUpdate = true;
  }
  reset(): void {
    for (let index = 0; index < this.instances.length; index++) {
      const instance = this.instances[index]; if (!instance) continue;
      this.matrix.makeTranslation((index % this.map.cols) * this.map.cellSize, 0.25, Math.floor(index / this.map.cols) * this.map.cellSize);
      instance.mesh.setMatrixAt(instance.index, this.matrix); instance.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  dispose(): void { disposeMazeObject(this.root); }
}
