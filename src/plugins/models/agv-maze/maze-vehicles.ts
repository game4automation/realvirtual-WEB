// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { Box3, BoxGeometry, CanvasTexture, CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, InstancedMesh, Material, Mesh,
  MeshStandardMaterial, MeshBasicMaterial, Shape, ShapeGeometry, DoubleSide, Object3D, PlaneGeometry, Quaternion, Sprite, SpriteMaterial, Texture, Vector3 } from 'three';
import { gltfLoader } from '@rv/core/engine/rv-glb-parse';
import { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import type { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import type { MazeGraph } from './maze-builder';
import { cellIndex, MAZE_SEED, type Cell, type Dir, type MazeMap } from './maze-map';
import { GHOSTS } from './ghost-router';
import type { GhostMode } from './game-state';
import { MAZE_PALETTE } from './maze-palette';

export interface CabinetConfig { displayName: string; travelerId: string; color: number; }

const QUIPS: readonly (readonly string[])[] = [
  ['Block not configured', 'It is in the manual', 'Hardware config loaded'],
  ['Not my module', 'Other department', 'You need a licence for that'],
  ['Maintenance window', 'Unplanned downtime', 'That was the last shift'],
  ['Axis referenced!', 'Cuckoo!', 'Zero point lost'],
];

/** Independent seeded speech stream: cosmetic timing never changes routing. */
class MazeSpeech {
  readonly root = new Group();
  private seed = 0;
  private remaining = 0;
  private speaking = false;
  constructor(private readonly index: number) {
    this.root.name = 'speech-bubble'; this.root.position.y = 2.35;
    for (const text of QUIPS[index]) {
      const bubble = textSprite(text, true);
      bubble.name = text; bubble.scale.set(2.7, 0.51, 1);
      this.root.add(bubble);
    }
    this.reset();
  }
  reset(): void {
    this.seed = MAZE_SEED + this.index; this.remaining = 3 + this.index * 4;
    this.speaking = false; this.root.visible = false;
    for (const child of this.root.children) child.visible = false;
  }
  tick(dt: number, mode: GhostMode): void {
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.speaking = !this.speaking;
      let value = this.seed += 0x6d2b79f5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      const random = ((value ^ value >>> 14) >>> 0) / 4294967296;
      this.remaining = this.speaking ? 3 : 18 + random * 4;
      const selected = Math.floor(random * this.root.children.length);
      this.root.children.forEach((child, i) => { child.visible = this.speaking && i === selected; });
    }
    this.root.visible = this.speaking && mode !== 'eaten';
  }
}

export function textSprite(text: string, speech = false): Sprite {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = speech ? 112 : 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('AGV Maze requires a canvas 2D context for labels.');
  ctx.fillStyle = '#15202d';
  if (speech) {
    ctx.beginPath(); ctx.roundRect(0, 0, 512, 92, 12); ctx.fill();
    ctx.beginPath(); ctx.moveTo(236, 90); ctx.lineTo(256, 112); ctx.lineTo(276, 90); ctx.fill();
  } else ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f3f6fa'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center';
  ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 48, 484);
  const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthWrite: false }));
  sprite.scale.set(1.8, 0.34, 1); return sprite;
}

export function buildCabinetGhost(config: CabinetConfig): Group {
  const root = new Group(); root.name = config.travelerId;
  const body = new Group(); body.name = 'cabinet-body'; root.add(body);
  const stainless = new MeshStandardMaterial(MAZE_PALETTE.stainless);
  const paint = new MeshStandardMaterial({ color: config.color, metalness: 0,
    roughness: config.color === MAZE_PALETTE['RAL 7016'].color ? 0.48 : 0.45 });
  const silhouette = new Shape();
  silhouette.moveTo(-0.36, 0); silhouette.lineTo(0.36, 0); silhouette.lineTo(0.36, 0.53);
  silhouette.quadraticCurveTo(0.36, 0.85, 0, 0.85);
  silhouette.quadraticCurveTo(-0.36, 0.85, -0.36, 0.53); silhouette.closePath();
  const shellGeometry = new ExtrudeGeometry(silhouette, { depth: 0.5, bevelEnabled: true,
    bevelSegments: 2, steps: 1, bevelSize: 0.018, bevelThickness: 0.018, curveSegments: 12 });
  shellGeometry.translate(0, 0, -0.25);
  const frame = new Mesh(shellGeometry, stainless); frame.name = 'cabinet-frame'; frame.position.y = 0.31; body.add(frame);
  const cabinet = new Mesh(shellGeometry, paint); cabinet.name = 'cabinet-paint';
  cabinet.scale.set(0.91, 0.95, 1.08); cabinet.position.y = 0.33; body.add(cabinet);
  const chassis = new Mesh(new BoxGeometry(0.78, 0.09, 0.65), new MeshStandardMaterial(MAZE_PALETTE['RAL 7016']));
  chassis.position.y = 0.075; body.add(chassis);
  const bellows = new Group(); bellows.name = 'bellows'; body.add(bellows);
  const rubber = new MeshStandardMaterial(MAZE_PALETTE['RAL 9005']);
  const ringGeometry = new BoxGeometry(0.74, 0.023, 0.59);
  for (let i = 0; i < 5; i++) {
    const ring = new Mesh(ringGeometry, i % 2 === 0 ? stainless : rubber);
    ring.position.set(i % 2 === 0 ? -0.012 : 0.012, 0.14 + i * 0.038, 0);
    bellows.add(ring);
  }
  // An inclined operator panel keeps real lamp lenses readable from the overview camera.
  const face = new Group(); face.name = 'operator-face'; face.position.set(0, 0.82, 0.30);
  face.rotation.x = -Math.PI / 6; body.add(face);
  const panel = new Mesh(new BoxGeometry(0.6, 0.43, 0.035), paint); face.add(panel);
  const eyes = new Group(); eyes.name = 'indicator-eyes'; face.add(eyes);
  const eyeMaterial = new MeshStandardMaterial(MAZE_PALETTE['lamp-white']);
  const bezelGeometry = new CylinderGeometry(0.115, 0.115, 0.035, 20);
  const lensGeometry = new CylinderGeometry(0.085, 0.095, 0.05, 20);
  for (const x of [-0.17, 0.17]) {
    const bezel = new Mesh(bezelGeometry, stainless); bezel.rotation.x = Math.PI / 2;
    bezel.position.set(x, 0.09, 0.035); face.add(bezel);
    const lens = new Mesh(lensGeometry, eyeMaterial); lens.rotation.x = Math.PI / 2;
    lens.position.set(x, 0.09, 0.064); eyes.add(lens);
  }
  const grilleBack = new Mesh(new BoxGeometry(0.43, 0.14, 0.02), rubber);
  grilleBack.position.set(0, -0.11, 0.03); face.add(grilleBack);
  const grille = new Group(); grille.name = 'vent-grille'; face.add(grille);
  const slatGeometry = new BoxGeometry(0.39, 0.017, 0.026);
  for (let i = 0; i < 4; i++) {
    const slat = new Mesh(slatGeometry, stainless); slat.position.set(0, -0.16 + i * 0.033, 0.051); grille.add(slat);
  }
  const faultGrille = new Group(); faultGrille.name = 'fault-grille'; faultGrille.visible = false; face.add(faultGrille);
  const faultMaterial = new MeshStandardMaterial(MAZE_PALETTE['lamp-red']);
  const zigGeometry = new BoxGeometry(0.085, 0.02, 0.026);
  for (let i = 0; i < 6; i++) {
    const slat = new Mesh(zigGeometry, faultMaterial); slat.position.set(-0.165 + i * 0.066, -0.11, 0.055);
    slat.rotation.z = i % 2 === 0 ? Math.PI / 5 : -Math.PI / 5; faultGrille.add(slat);
  }
  const warning = textSprite('STOERUNG  F-0471');
  const front = new Mesh(new PlaneGeometry(0.6, 0.2), new MeshBasicMaterial({ map: warning.material.map }));
  warning.material.dispose();
  front.name = 'fault-front'; front.position.set(0, 0.48, 0.292); front.visible = false; body.add(front);
  const lamp = new Mesh(new CylinderGeometry(0.1, 0.1, 0.32, 12),
    new MeshStandardMaterial({ color: config.color, emissive: config.color, emissiveIntensity: 5 }));
  lamp.name = 'signal-column'; lamp.position.y = 1.35; root.add(lamp);
  const label = textSprite(config.displayName); label.name = 'name-label'; label.position.y = 1.85; root.add(label);
  return root;
}

/** Only releases resources owned by a separately loaded/procedurally built tree. */
export function disposeMazeObject(root: Object3D): void {
  root.removeFromParent();
  const geometries = new Set<Mesh['geometry']>(), materials = new Set<Material>(), textures = new Set<Texture>();
  root.traverse(node => {
    if (node instanceof InstancedMesh) node.dispose();
    if (node instanceof Mesh) geometries.add(node.geometry);
    if (node instanceof Mesh || node instanceof Sprite) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.clear();
}

export class MazeVehicle {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly traveler: PathTraveler;
  private readonly startPath;
  private readonly body: Object3D | undefined;
  private readonly lamp: Mesh | undefined;
  private readonly label: Object3D | undefined;
  private readonly front: Object3D | undefined;
  private readonly eyes: Object3D | undefined;
  private readonly eyeMaterial: MeshStandardMaterial | null;
  private readonly grille: Object3D | undefined;
  private readonly faultGrille: Object3D | undefined;
  private readonly lampMaterial: MeshStandardMaterial | null;
  private readonly color: number;
  private readonly speech: MazeSpeech | null;
  private readonly beaconMaterial: MeshStandardMaterial | null;
  private beaconPhase = 0;
  constructor(readonly object: Object3D, id: string, start: Cell, map: MazeMap, graph: MazeGraph, network: RVPathNetwork) {
    const exits = graph.outgoing[cellIndex(map, start)];
    this.startPath = exits.E ?? exits.N ?? exits.S ?? exits.W!;
    this.traveler = new PathTraveler(id, this.startPath, network);
    this.body = object.getObjectByName('cabinet-body'); this.label = object.getObjectByName('name-label');
    this.lamp = object.getObjectByName('signal-column') as Mesh | undefined; this.front = object.getObjectByName('fault-front');
    this.lampMaterial = this.lamp ? this.lamp.material as MeshStandardMaterial : null;
    this.eyes = object.getObjectByName('indicator-eyes');
    this.eyeMaterial = this.eyes ? (this.eyes.children[0] as Mesh).material as MeshStandardMaterial : null;
    this.grille = object.getObjectByName('vent-grille'); this.faultGrille = object.getObjectByName('fault-grille');
    this.color = this.lampMaterial?.color.getHex() ?? 0;
    const beacon = object.getObjectByName('player-beacon') as Mesh | undefined;
    this.beaconMaterial = beacon ? beacon.material as MeshStandardMaterial : null;
    const ghostIndex = GHOSTS.findIndex(ghost => ghost.travelerId === id);
    this.speech = ghostIndex >= 0 ? new MazeSpeech(ghostIndex) : null;
    if (this.speech) object.add(this.speech.root);
    this.reset();
  }
  reset(): void {
    this.beaconPhase = 0; this.updateBeacon(0, false, Infinity, 1);
    this.speech?.reset();
    this.traveler.path = this.startPath; this.traveler.s = 0; this.traveler.v = 0;
    this.traveler.atEnd = false; this.traveler.blocked = false; this.writePose();
    this.updateAppearance('scatter', 0);
  }
  writePose(): void {
    this.traveler.getPose(this.position, this.quaternion);
    this.object.position.copy(this.position); this.object.quaternion.copy(this.quaternion);
  }
  updateAppearance(mode: GhostMode, frightenedLeft: number): void {
    if (!this.lampMaterial) return;
    this.body!.visible = mode !== 'eaten'; this.label!.visible = mode !== 'eaten';
    // Rotate only the cabinet/chassis; the traveler's route and pose stay intact.
    this.body!.rotation.y = mode === 'frightened' ? Math.PI : 0;
    if (mode === 'eaten' && this.speech) this.speech.root.visible = false;
    this.front!.visible = mode === 'frightened';
    this.eyes!.visible = mode !== 'eaten';
    const eye = MAZE_PALETTE[mode === 'frightened' ? 'lamp-red' : 'lamp-white'];
    this.eyeMaterial!.color.setHex(eye.color); this.eyeMaterial!.emissive.setHex(eye.emissive);
    this.eyeMaterial!.emissiveIntensity = mode === 'eaten' ? 0 : eye.emissiveIntensity;
    this.grille!.visible = mode !== 'frightened'; this.faultGrille!.visible = mode === 'frightened';
    const blinking = mode === 'frightened' && Math.floor(frightenedLeft * (frightenedLeft <= 2 ? 8 : 3)) % 2 === 0;
    const color = mode === 'frightened' ? MAZE_PALETTE['lamp-red'].color : this.color;
    this.lampMaterial.color.setHex(color); this.lampMaterial.emissive.setHex(color);
    this.lampMaterial.emissiveIntensity = mode === 'frightened' ? (blinking ? 5 : 0.15) : 5;
  }
  updateSpeech(dt: number, mode: GhostMode): void { this.speech?.tick(dt, mode); }
  /** Distance in metres squared, reused from the fixed-step contact check. */
  updateBeacon(dt: number, frightened: boolean, nearestSquared: number, cellSize: number): void {
    if (!this.beaconMaterial) return;
    const proximity = 1 - Math.min(1, Math.sqrt(nearestSquared) / (cellSize * 6));
    this.beaconPhase = (this.beaconPhase + dt * (1 + proximity * 4)) % 1;
    const lamp = MAZE_PALETTE[frightened ? 'lamp-green' : 'lamp-amber'];
    this.beaconMaterial.color.setHex(lamp.color); this.beaconMaterial.emissive.setHex(lamp.emissive);
    this.beaconMaterial.emissiveIntensity = this.beaconPhase < 0.5 ? lamp.emissiveIntensity : 0;
  }
}

export async function loadPlayerObject(url: string): Promise<Group> {
  const gltf = await gltfLoader.loadAsync(url);
  const root = new Group(); root.name = 'maze-player';
  root.add(gltf.scene);
  // The shipped CAD export has generic material names. These slots are the dark
  // chassis, bumpers and running gear; the remaining panels receive yellow paint.
  const chassisMaterials = new Set(['Standard_1', 'Standard_3', 'Standard_5', 'Standard_8',
    'Standard_9', 'Standard_11', 'Standard_20', 'Standard_21', 'Standard_22']);
  gltf.scene.traverse(node => {
    if (node instanceof Mesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material instanceof MeshStandardMaterial) {
        const paint = MAZE_PALETTE[chassisMaterials.has(material.name) ? 'RAL 7016' : 'RAL 1023'];
        material.color.setHex(paint.color); material.emissive.setHex(0); material.emissiveIntensity = 0;
        material.metalness = paint.metalness; material.roughness = paint.roughness;
      }
    }
  });
  const bounds = new Box3().setFromObject(gltf.scene), center = bounds.getCenter(new Vector3());
  gltf.scene.position.add(new Vector3(-center.x, -bounds.min.y, -center.z));
  const roofHeight = bounds.max.y - bounds.min.y;
  const base = new Mesh(new CylinderGeometry(0.1, 0.11, 0.04, 20), new MeshStandardMaterial(MAZE_PALETTE['RAL 7016']));
  base.name = 'player-beacon-base'; base.position.y = roofHeight + 0.02; root.add(base);
  const beacon = new Mesh(new CylinderGeometry(0.07, 0.085, 0.11, 20), new MeshStandardMaterial(MAZE_PALETTE['lamp-amber']));
  beacon.name = 'player-beacon'; beacon.position.y = roofHeight + 0.095; root.add(beacon);
  root.updateMatrixWorld(true);
  return root;
}

export function createMazeVehicles(player: Group, map: MazeMap, graph: MazeGraph, network: RVPathNetwork): MazeVehicle[] {
  const vehicles = [new MazeVehicle(player, 'maze-player', map.playerStart, map, graph, network)];
  for (let i = 0; i < GHOSTS.length; i++) {
    const config = GHOSTS[i];
    vehicles.push(new MazeVehicle(buildCabinetGhost(config), config.travelerId,
      map.ghostStarts[i % map.ghostStarts.length], map, graph, network));
  }
  return vehicles;
}

const DIRECTION_ANGLE: Record<Dir, number> = { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 };

/** Blue safety spot on the floor = travel; amber outer chevron = buffered turn. */
export class MazeDirectionIndicator {
  readonly root = new Group();
  private readonly desired = new Group();
  constructor() {
    this.root.name = 'player-direction';
    const shape = new Shape();
    shape.moveTo(-0.22, 0); shape.lineTo(0, 0.32); shape.lineTo(0.22, 0);
    shape.lineTo(0.12, 0); shape.lineTo(0, 0.17); shape.lineTo(-0.12, 0); shape.closePath();
    const geometry = new ShapeGeometry(shape); geometry.rotateX(Math.PI / 2);
    const spotGeometry = new CircleGeometry(0.15, 32); spotGeometry.rotateX(-Math.PI / 2);
    const forward = new Mesh(spotGeometry, new MeshStandardMaterial({ ...MAZE_PALETTE['lamp-blue'], depthWrite: false }));
    forward.name = 'blue-floor-spot'; forward.position.set(0, 0.027, 0.72); forward.scale.z = 1.4; this.root.add(forward);
    const halo = new Mesh(spotGeometry, new MeshStandardMaterial({ ...MAZE_PALETTE['lamp-blue'],
      transparent: true, opacity: 0.18, depthWrite: false }));
    halo.position.set(0, 0.025, 0.72); halo.scale.set(1.35, 1, 1.9); this.root.add(halo);
    const queued = new Mesh(geometry, new MeshBasicMaterial({ color: 0xffbe54, side: DoubleSide }));
    queued.position.set(0, 0.82, 0.65); this.desired.add(queued); this.root.add(this.desired);
    this.desired.visible = false;
  }
  update(direction: Dir, desired: Dir | null): void {
    this.desired.visible = desired !== null && desired !== direction;
    if (desired) this.desired.rotation.y = DIRECTION_ANGLE[desired] - DIRECTION_ANGLE[direction];
  }
}
