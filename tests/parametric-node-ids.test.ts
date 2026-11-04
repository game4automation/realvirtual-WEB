// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assemble, parametricGeneratedNodeId } from '../src/core/engine/rv-parametric-assembly';
import type { BuildPlan } from '../src/core/engine/rv-parametric-generator';
import { resolveParametricVariant, applyParametricVariant, PARAMETRIC_CACHE_QUALITY } from '../src/core/engine/rv-parametric-variant';
import { clearCadGlbCache, putCadGlb } from '../src/core/import/rv-cad-glb-cache';
import { buildVariant } from '../src/core/engine/rv-parametric-family';
import { computeCodeHash } from '../src/core/engine/rv-parametric-hash';
import { setNodeId, getNodeId } from '../src/core/engine/rv-node-id';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';
import { getRawOdtDef } from '../src/core/engine/rv-component-registry';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { setAssetOverrides } from '../src/core/engine/rv-asset-reference';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { referenceNode } from './helpers/nested-placement-fixture';

let h: TestViewerHandle | null = null;
afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });
const names = ['Gripper', 'GripSensor', 'AxisX'];
const id = (name: string) => parametricGeneratedNodeId('fam-grip', name);
const rules = `function generate(v, parts) {
 return {
  instances: [{part:'Plate',name:'Gripper',positionMm:[v.L,0,1000]}, {part:'Plate',positionMm:[0,0,0]}],
  nodes: [{name:'GripSensor',positionMm:[v.L,0,975]}, {name:'AxisX',positionMm:[v.L,0,0]}],
  components: [
   {node:'GripSensor',type:'Sensor',fields:{UseRaycast:true,AutoRay:false,RayCastDirection:{x:0,y:0,z:-1},RayCastLength:30}},
   {node:'Gripper',type:'Grip',fields:{PlaceMode:'Auto',OneBitControl:true,GripRange:50,PartToGrip:'GripSensor'}},
   {node:'AxisX',type:'Drive',fields:{Direction:'LinearX',TargetSpeed:100}}
  ]
 };
}`;
async function familyAsset(identity = true) {
 const asset = new Group(); asset.name = 'Gantry';
 const fam = new Group(); fam.name = 'Fam';
 const parts = new Group(); parts.name = '_Parts'; parts.rotation.x = -Math.PI / 2; parts.scale.setScalar(0.001);
 const plate = new Group(); plate.name = 'Plate';
 const mesh = new Mesh(new BoxGeometry(200,200,40), new MeshStandardMaterial()); mesh.name = 'PlateMesh';
 plate.add(mesh); parts.add(plate); fam.add(parts); asset.add(fam);
 fam.userData.realvirtual = {ParametricComponent:{ApiVersion:1,Params:[{Name:'L',Type:'number',Min:0,Max:1000,Default:0}],Values:{L:0},Code:rules,CodeHash:await computeCodeHash(rules)}};
 if (identity) setNodeId(fam, 'fam-grip');
 return {asset,fam,parts};
}
async function exported() {
 const {asset,fam} = await familyAsset();
 const v = await buildVariant(fam);
 if (!v.ok) throw new Error(JSON.stringify(v.error));
 fam.add(v.root);
 return objectToGlb(asset);
}
function emptyPlan(): BuildPlan { return {instances:[],nodes:[],components:[],messages:[]}; }
function placementOf(node: Object3D) {
 let current: Object3D | null = node;
 while (current && !/^Gantry_[12]$/.test(current.name)) current = current.parent;
 return current;
}

describe('parametric generated node identity', () => {
 it('stamps explicit names deterministically across value changes, leaving implicit names unstamped', async () => {
  const {fam} = await familyAsset();
  for (const L of [0,300]) {
   const v = await buildVariant(fam,{L});
   if (!v.ok) throw new Error(JSON.stringify(v.error));
   for (const name of names) expect(identityIdOf(v.root.getObjectByName(name)!)).toBe(id(name));
   const unnamed = v.root.getObjectByName('Plate_1')!;
   expect(getNodeId(unnamed)).toBeNull(); expect(identityIdOf(unnamed)).toBeNull();
  }
 });
 it.each(['a/b','a#b','_Children'])('rejects invalid explicit names %s in direct assembly', (name) => {
  for (const kind of ['node','instance']) {
   const parts = new Group(); const part = new Group(); part.name = 'Plate'; parts.add(part);
   const plan = emptyPlan();
   if (kind === 'node') plan.nodes.push({name,positionMm:[0,0,0]});
   else plan.instances.push({part:'Plate',name,positionMm:[0,0,0]});
   expect(assemble(parts,plan)).toMatchObject({ok:false,error:{code:'invalid-name'}});
  }
 });
 it('requires family identity for named output', async () => {
  const {fam,parts} = await familyAsset(false);
  expect(await buildVariant(fam)).toMatchObject({ok:false,error:{stage:'assembly',code:'family-no-identity'}});
  const plan = emptyPlan(); plan.nodes.push({name:'Named',positionMm:[0,0,0]});
  expect(assemble(parts,plan,{familyId:null})).toMatchObject({ok:false,error:{code:'family-no-identity'}});
  expect(assemble(parts,emptyPlan(),{familyId:null}).ok).toBe(true);
 });
 it('rewrites generated names without mutating the plan and rejects unknown strings', async () => {
  const {fam,parts} = await familyAsset();
  const v = await buildVariant(fam);
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  expect(v.root.getObjectByName('Gripper')!.userData.realvirtual.Grip.PartToGrip).toEqual({type:'ComponentReference',address:'#'+id('GripSensor'),componentType:getRawOdtDef('Grip')!.properties!.PartToGrip.refType});
  expect(v.plan.components.find(c => c.type === 'Grip')!.fields.PartToGrip).toBe('GripSensor');
  const objectPlan = structuredClone(v.plan);
  const objectRef = {type:'ComponentReference',address:'#external-sensor',componentType:'Sensor'};
  objectPlan.components.find(c => c.type === 'Grip')!.fields.PartToGrip = objectRef;
  const passed = assemble(parts,objectPlan);
  if (!passed.ok) throw new Error(JSON.stringify(passed.error));
  expect(identityIdOf(passed.root.getObjectByName('AxisX')!)).toBe('family:_Generated:AxisX');
  expect(passed.root.getObjectByName('Gripper')!.userData.realvirtual.Grip.PartToGrip).toEqual(objectRef);
  for (const value of ['Missing', 'Gantry/Fam/GripSensor', 'Plate_1']) {
   const plan = structuredClone(v.plan);
   plan.components.find(c => c.type === 'Grip')!.fields.PartToGrip = value;
   expect(assemble(parts,plan,{familyId:'fam-grip'})).toMatchObject({ok:false,error:{code:'component-invalid'}});
  }
 });
 it('exports unique conforming ids and preserves stamps on GLTF reload', async () => {
  const bytes = await exported();
  const json = readGlbJson(bytes)!;
  const seeded = seedNodeIdsForFile(json, undefined);
  expect(seeded.duplicates).toEqual([]);
  const ids = [seeded.rootId,...seeded.ids.filter((s: unknown) => s !== undefined)];
  expect(new Set(ids).size).toBe(ids.length);
  for (const value of ids) { expect(typeof value).toBe('string'); expect(value).not.toMatch(/^_|[/#]/); }
  // idVersion is written by the identity writer in Phase 4.
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0),'');
  for (const name of names) expect(identityIdOf(gltf.scene.getObjectByName(name)!)).toBe(id(name));
 });
 it('resolves Grip to Sensor when reloaded and baked as the main model', async () => {
  h = await createTestViewer('webgl');
  await h.viewer.loadModel('gantry.glb',{data:await exported()});
  await h.viewer.whenSceneReady();
  const grips = h.viewer.transportManager!.grips;
  expect(grips).toHaveLength(1);
  for (const grip of grips) expect(grip.partToGripSensor?.node.name).toBe('GripSensor');
 });
 it('resolves each placement locally and retains generated-node overrides after regeneration', async () => {
  const bytes = await exported();
  const loader = {loadAsync:async () => new GLTFLoader().parseAsync(bytes.slice(0),'')} as unknown as GLTFLoader;
  h = await createTestViewer('webgl');
  h.viewer.placements.setModelCache(new ModelCache(loader,{
   uber:() => h!.viewer.placementUberMaterial,isWebGPU:() => h!.viewer.isWebGPU,
   pickPort:() => createPickBuildPort({createWorker:() => null}),
  }));
  const doc = new Group(); doc.name = 'Layout';
  const r1 = referenceNode('Gantry_1','nid-g1','blob:rv-test/node-ids.glb',true,[0,0,0],'node-ids-gantry');
  const r2 = referenceNode('Gantry_2','nid-g2','blob:rv-test/node-ids.glb',true,[5,0,0],'node-ids-gantry');
  setAssetOverrides(r2,{byAddress:{'#fam-grip':{ParametricComponent:{Values:{L:300}}},['#'+id('AxisX')]:{Drive:{TargetSpeed:777}}}});
  doc.add(r1,r2);
  await h.viewer.loadModel('layout.glb',{data:await objectToGlb(doc)});
  await h.viewer.whenSceneReady();
  const grips = h.viewer.transportManager!.grips;
  expect(grips).toHaveLength(2);
  for (const grip of grips) {
   expect(grip.partToGripSensor).toBeTruthy();
   const owner = placementOf(grip.node);
   expect(owner).not.toBeNull();
   expect(placementOf(grip.partToGripSensor!.node)).toBe(owner);
  }
  const axes = h.viewer.drives.filter(d => identityIdOf(d.node) === id('AxisX'));
  expect(axes).toHaveLength(2);
  expect(axes.find(d => placementOf(d.node)?.name === 'Gantry_1')!.TargetSpeed).toBe(100);
  expect(axes.find(d => placementOf(d.node)?.name === 'Gantry_2')!.TargetSpeed).toBe(777);
 });
});

describe('generated-subtree cache is keyed by family identity (plan-2216 review)', () => {
 async function famWithId(fid: string) {
  const {asset,fam} = await familyAsset(false);
  setNodeId(fam, fid);
  return {asset,fam};
 }
 async function apply(root: Object3D, fid: string) {
  const prepared = await resolveParametricVariant(root, [{familyNodeId: fid, values: {L: 100}}]);
  const stats = await applyParametricVariant(prepared);
  return {prepared, stats};
 }
 const generated = (root: Object3D) => root.getObjectByName('_Generated')!;
 const grip = (root: Object3D) => generated(root).getObjectByName('Gripper')!.userData.realvirtual.Grip;

 it('two differently identified families with identical inputs get their own ids and references from a warm cache', async () => {
  await clearCadGlbCache();
  const a = await famWithId('fam-A'); const b = await famWithId('fam-B');
  const ra = await apply(a.asset, 'fam-A');
  expect(ra.stats).toEqual({generatorRuns: 1, cacheHits: 0});
  const rb = await apply(b.asset, 'fam-B');
  expect(rb.stats).toEqual({generatorRuns: 1, cacheHits: 0}); // not served from A's entry
  expect(ra.prepared.families[0].inputs.inputHash).not.toBe(rb.prepared.families[0].inputs.inputHash);
  for (const [root, fid] of [[a.asset,'fam-A'],[b.asset,'fam-B']] as const) {
   for (const name of names) expect(identityIdOf(generated(root).getObjectByName(name)!)).toBe(parametricGeneratedNodeId(fid, name));
   expect(grip(root).PartToGrip.address).toBe('#' + parametricGeneratedNodeId(fid, 'GripSensor'));
  }
  // warm hit for the same family still works and keeps its own ids
  const a2 = await famWithId('fam-A');
  const r2 = await apply(a2.asset, 'fam-A');
  expect(r2.stats).toEqual({generatorRuns: 0, cacheHits: 1});
  expect(grip(a2.asset).PartToGrip.address).toBe('#' + parametricGeneratedNodeId('fam-A', 'GripSensor'));
 });

 it('an entry under the old cache version is not used', async () => {
  await clearCadGlbCache();
  const a = await famWithId('fam-A');
  const prepared = await resolveParametricVariant(a.asset, [{familyNodeId: 'fam-A', values: {L: 100}}]);
  const hash = prepared.families[0].inputs.inputHash;
  const built = await buildVariant(a.fam, {L: 100});
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  await putCadGlb(hash, 'param-v1', await objectToGlb(built.root), 'parametric');
  expect(PARAMETRIC_CACHE_QUALITY).not.toBe('param-v1');
  const stats = await applyParametricVariant(prepared);
  expect(stats).toEqual({generatorRuns: 1, cacheHits: 0});
 });
});
