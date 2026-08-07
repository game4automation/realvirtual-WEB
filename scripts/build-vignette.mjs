// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Build a self-contained rv-embed vignette from selected subtrees of a GLB.
 *
 * Usage:
 *   node scripts/build-vignette.mjs --config scripts/vignettes/conveyor-sensor.json
 *
 * Optional overrides:
 *   --source <file> --output <file> --select <path>[,<path>...]
 *
 * Configs may add exact component names or "*" globs through
 * "stripComponents". The built-in policy removes industrial interfaces and
 * test/debug components from every vignette.
 *
 * The crop keeps selected descendants, their ancestors, and only referenced
 * meshes/materials/textures/accessors/buffer views. Geometry is then compressed
 * with a pinned glTF Transform CLI. A new vignette therefore needs only another
 * JSON config, not changes to this script.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLTF_TRANSFORM_VERSION = '4.1.3';
const DEFAULT_BUDGET_BYTES = 3 * 1024 * 1024;
const DEFAULT_COMPONENT_STRIP_LIST = Object.freeze([
  '*Interface',
  '*Interfaces',
  '*Test*',
  '*Debug*',
  '*Diagnostic*',
]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const args = parseArgs(process.argv.slice(2));
const configPath = resolveFromRepo(args.config ?? 'scripts/vignettes/conveyor-sensor.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const sourcePath = resolveFromRepo(args.source ?? config.source);
const outputPath = resolveFromRepo(args.output ?? config.output);
const selections = args.select.length > 0 ? args.select : config.selection;
const budgetBytes = Number(config.budgetBytes ?? DEFAULT_BUDGET_BYTES);
const componentStripMatchers = createComponentStripMatchers(config.stripComponents);

if (!Array.isArray(selections) || selections.length === 0) {
  throw new Error('Vignette config must contain a non-empty "selection" array');
}
if (!existsSync(sourcePath) || statSync(sourcePath).size === 0) {
  throw new Error(`Vignette source is missing or empty: ${sourcePath}`);
}
if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
  throw new Error(`Invalid vignette budget: ${config.budgetBytes}`);
}

const tempDir = mkdtempSync(join(tmpdir(), 'rv-vignette-'));
const croppedPath = join(tempDir, 'cropped.glb');

try {
  const source = readGlb(sourcePath);
  const crop = cropGlb(source, selections, config);
  writeGlb(croppedPath, crop.json, crop.binary);

  mkdirSync(dirname(outputPath), { recursive: true });
  const compression = config.compression?.geometry ?? 'draco';
  if (compression === 'none') {
    copyFileSync(croppedPath, outputPath);
  } else if (compression === 'draco') {
    runGltfTransform([
      'draco',
      croppedPath,
      outputPath,
      '--encode-speed',
      String(config.compression?.encodeSpeed ?? 5),
      '--decode-speed',
      String(config.compression?.decodeSpeed ?? 5),
      '--quantize-position',
      String(config.compression?.quantizePosition ?? 14),
    ]);
  } else {
    throw new Error(`Unsupported geometry compression "${compression}" (use "draco" or "none")`);
  }

  const outputSize = statSync(outputPath).size;
  if (outputSize > budgetBytes) {
    throw new Error(
      `Vignette exceeds budget: ${formatBytes(outputSize)} > ${formatBytes(budgetBytes)}`,
    );
  }

  const built = readGlb(outputPath);
  const extensions = built.json.extensionsUsed ?? [];
  console.log(
    [
      `[vignette] ${basename(outputPath)}`,
      `${crop.keptNodeCount}/${source.json.nodes?.length ?? 0} nodes`,
      `${crop.keptMeshCount}/${source.json.meshes?.length ?? 0} meshes`,
      `${crop.strippedComponentCount} stripped (${crop.strippedComponentTypes.join(',') || 'none'})`,
      `${formatBytes(outputSize)} / ${formatBytes(budgetBytes)}`,
      `extensions=${extensions.join(',') || 'none'}`,
    ].join(' | '),
  );
} finally {
  const resolvedTemp = resolve(tempDir);
  const resolvedTmpRoot = resolve(tmpdir());
  if (
    resolvedTemp.startsWith(`${resolvedTmpRoot}\\`)
    && basename(resolvedTemp).startsWith('rv-vignette-')
  ) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

function parseArgs(values) {
  const parsed = { config: null, source: null, output: null, select: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--config') parsed.config = requiredArg(values, ++index, value);
    else if (value === '--source') parsed.source = requiredArg(values, ++index, value);
    else if (value === '--output') parsed.output = requiredArg(values, ++index, value);
    else if (value === '--select') {
      parsed.select.push(
        ...requiredArg(values, ++index, value).split(',').map((entry) => entry.trim()).filter(Boolean),
      );
    } else if (value === '--help' || value === '-h') {
      console.log(
        'Usage: node scripts/build-vignette.mjs --config <config.json> '
        + '[--source <source.glb>] [--output <vignette.glb>] [--select <path,...>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function requiredArg(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function resolveFromRepo(path) {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('Expected a file path');
  return isAbsolute(path) ? resolve(path) : resolve(REPO_ROOT, path);
}

function readGlb(path) {
  const data = readFileSync(path);
  if (data.length < 20 || data.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`Not a binary glTF file: ${path}`);
  }
  if (data.readUInt32LE(4) !== 2) throw new Error(`Only glTF 2.0 is supported: ${path}`);

  let offset = 12;
  let json = null;
  let binary = Buffer.alloc(0);
  while (offset + 8 <= data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      json = JSON.parse(chunk.toString('utf8').replace(/[\s\u0000]+$/u, ''));
    } else if (type === BIN_CHUNK) {
      binary = Buffer.from(chunk);
    }
    offset += 8 + length;
  }
  if (!json) throw new Error(`GLB has no JSON chunk: ${path}`);
  return { json, binary };
}

function writeGlb(path, json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const binPadding = (4 - (binary.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + paddedJson.length + (paddedBinary.length > 0 ? 8 + paddedBinary.length : 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const chunks = [header, jsonHeader, paddedJson];
  if (paddedBinary.length > 0) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(paddedBinary.length, 0);
    binHeader.writeUInt32LE(BIN_CHUNK, 4);
    chunks.push(binHeader, paddedBinary);
  }
  writeFileSync(path, Buffer.concat(chunks));
}

function cropGlb(source, selections, config) {
  const json = structuredClone(source.json);
  const nodes = json.nodes ?? [];
  const parents = new Array(nodes.length).fill(-1);
  for (let index = 0; index < nodes.length; index++) {
    for (const child of nodes[index].children ?? []) parents[child] = index;
  }
  const paths = nodes.map((_, index) => nodePath(nodes, parents, index));
  const pathToIndex = new Map(paths.map((path, index) => [path, index]));
  const keptNodes = new Set();

  for (const selection of selections) {
    const selectedIndex = pathToIndex.get(selection);
    if (selectedIndex === undefined) {
      throw new Error(`Vignette selection not found: ${selection}`);
    }
    addDescendants(nodes, selectedIndex, keptNodes);
    let ancestor = selectedIndex;
    while (ancestor >= 0) {
      keptNodes.add(ancestor);
      ancestor = parents[ancestor];
    }
  }

  applyComponentOverrides(nodes, pathToIndex, config.componentOverrides ?? {});
  applyVignetteExtras(nodes, pathToIndex, config.metadataNode, config.rvExtras);

  const meshes = collectNumbers(keptNodes, (index) => nodes[index].mesh);
  const cameras = collectNumbers(keptNodes, (index) => nodes[index].camera);
  const skins = collectNumbers(keptNodes, (index) => nodes[index].skin);
  for (const skinIndex of skins) {
    const skin = json.skins?.[skinIndex];
    for (const joint of skin?.joints ?? []) keptNodes.add(joint);
    if (skin?.skeleton !== undefined) keptNodes.add(skin.skeleton);
  }
  const strippedComponents = stripRvComponents(nodes, keptNodes, componentStripMatchers);

  const materials = new Set();
  const accessors = new Set();
  const bufferViews = new Set();
  for (const meshIndex of meshes) {
    const mesh = json.meshes[meshIndex];
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.material !== undefined) materials.add(primitive.material);
      if (primitive.indices !== undefined) accessors.add(primitive.indices);
      for (const accessor of Object.values(primitive.attributes ?? {})) accessors.add(accessor);
      for (const target of primitive.targets ?? []) {
        for (const accessor of Object.values(target)) accessors.add(accessor);
      }
      const dracoView = primitive.extensions?.KHR_draco_mesh_compression?.bufferView;
      if (dracoView !== undefined) bufferViews.add(dracoView);
    }
  }
  for (const skinIndex of skins) {
    const accessor = json.skins?.[skinIndex]?.inverseBindMatrices;
    if (accessor !== undefined) accessors.add(accessor);
  }

  const textures = new Set();
  for (const materialIndex of materials) {
    collectTextureIndices(json.materials[materialIndex], textures);
  }
  const images = new Set();
  const samplers = new Set();
  for (const textureIndex of textures) {
    const texture = json.textures[textureIndex];
    if (texture.source !== undefined) images.add(texture.source);
    if (texture.sampler !== undefined) samplers.add(texture.sampler);
    const basisSource = texture.extensions?.KHR_texture_basisu?.source;
    if (basisSource !== undefined) images.add(basisSource);
  }
  for (const imageIndex of images) {
    const view = json.images[imageIndex].bufferView;
    if (view !== undefined) bufferViews.add(view);
    const uri = json.images[imageIndex].uri;
    if (uri && !uri.startsWith('data:')) {
      throw new Error(`External image URI is not supported for a self-contained vignette: ${uri}`);
    }
  }
  for (const accessorIndex of accessors) {
    const accessor = json.accessors[accessorIndex];
    if (accessor.bufferView !== undefined) bufferViews.add(accessor.bufferView);
    if (accessor.sparse?.indices?.bufferView !== undefined) {
      bufferViews.add(accessor.sparse.indices.bufferView);
    }
    if (accessor.sparse?.values?.bufferView !== undefined) {
      bufferViews.add(accessor.sparse.values.bufferView);
    }
  }

  const nodeMap = createIndexMap(keptNodes);
  const meshMap = createIndexMap(meshes);
  const materialMap = createIndexMap(materials);
  const accessorMap = createIndexMap(accessors);
  const bufferViewMap = createIndexMap(bufferViews);
  const textureMap = createIndexMap(textures);
  const imageMap = createIndexMap(images);
  const samplerMap = createIndexMap(samplers);
  const cameraMap = createIndexMap(cameras);
  const skinMap = createIndexMap(skins);

  const output = {
    asset: {
      ...json.asset,
      generator: `${json.asset?.generator ?? 'glTF'} | realvirtual build-vignette`,
    },
    scene: 0,
    scenes: [{
      name: config.name ?? 'realvirtual vignette',
      nodes: sceneRoots(json, parents, keptNodes).map((index) => requiredMap(nodeMap, index, 'node')),
    }],
    nodes: compact(json.nodes, nodeMap, (node) => {
      if (node.children) {
        node.children = node.children
          .filter((index) => nodeMap.has(index))
          .map((index) => requiredMap(nodeMap, index, 'node'));
      }
      remapOptional(node, 'mesh', meshMap);
      remapOptional(node, 'camera', cameraMap);
      remapOptional(node, 'skin', skinMap);
    }),
  };

  output.meshes = compact(json.meshes, meshMap, (mesh) => {
    for (const primitive of mesh.primitives ?? []) {
      remapOptional(primitive, 'indices', accessorMap);
      remapOptional(primitive, 'material', materialMap);
      remapRecord(primitive.attributes, accessorMap, 'accessor');
      for (const target of primitive.targets ?? []) remapRecord(target, accessorMap, 'accessor');
      const draco = primitive.extensions?.KHR_draco_mesh_compression;
      if (draco) draco.bufferView = requiredMap(bufferViewMap, draco.bufferView, 'bufferView');
    }
  });
  output.materials = compact(json.materials, materialMap, (material) => {
    remapTextureIndices(material, textureMap);
  });
  output.textures = compact(json.textures, textureMap, (texture) => {
    remapOptional(texture, 'source', imageMap);
    remapOptional(texture, 'sampler', samplerMap);
    const basis = texture.extensions?.KHR_texture_basisu;
    if (basis) basis.source = requiredMap(imageMap, basis.source, 'image');
  });
  output.images = compact(json.images, imageMap, (image) => {
    remapOptional(image, 'bufferView', bufferViewMap);
  });
  output.samplers = compact(json.samplers, samplerMap);
  output.accessors = compact(json.accessors, accessorMap, (accessor) => {
    remapOptional(accessor, 'bufferView', bufferViewMap);
    if (accessor.sparse?.indices) {
      accessor.sparse.indices.bufferView = requiredMap(
        bufferViewMap,
        accessor.sparse.indices.bufferView,
        'bufferView',
      );
    }
    if (accessor.sparse?.values) {
      accessor.sparse.values.bufferView = requiredMap(
        bufferViewMap,
        accessor.sparse.values.bufferView,
        'bufferView',
      );
    }
  });
  output.cameras = compact(json.cameras, cameraMap);
  output.skins = compact(json.skins, skinMap, (skin) => {
    skin.joints = skin.joints.map((index) => requiredMap(nodeMap, index, 'node'));
    remapOptional(skin, 'skeleton', nodeMap);
    remapOptional(skin, 'inverseBindMatrices', accessorMap);
  });

  const repacked = repackBufferViews(json.bufferViews ?? [], bufferViewMap, source.binary);
  output.bufferViews = repacked.bufferViews;
  output.buffers = [{ byteLength: repacked.binary.length }];
  copyIfPresent(json, output, 'extensionsUsed');
  copyIfPresent(json, output, 'extensionsRequired');
  copyIfPresent(json, output, 'extensions');
  copyIfPresent(json, output, 'extras');

  return {
    json: output,
    binary: repacked.binary,
    keptNodeCount: nodeMap.size,
    keptMeshCount: meshMap.size,
    strippedComponentCount: strippedComponents.count,
    strippedComponentTypes: [...strippedComponents.types].sort(),
  };
}

function nodePath(nodes, parents, index) {
  const parts = [];
  let current = index;
  while (current >= 0) {
    parts.push(nodes[current].name || `<node-${current}>`);
    current = parents[current];
  }
  return parts.reverse().join('/');
}

function addDescendants(nodes, index, result) {
  if (result.has(index)) return;
  result.add(index);
  for (const child of nodes[index].children ?? []) addDescendants(nodes, child, result);
}

function applyComponentOverrides(nodes, pathToIndex, overrides) {
  for (const [path, components] of Object.entries(overrides)) {
    const index = pathToIndex.get(path);
    if (index === undefined) throw new Error(`Component override node not found: ${path}`);
    const rv = nodes[index].extras?.realvirtual;
    if (!rv) throw new Error(`Component override node has no rv_extras: ${path}`);
    for (const [component, patch] of Object.entries(components)) {
      if (!rv[component]) throw new Error(`Component "${component}" not found at ${path}`);
      rv[component] = deepMerge(rv[component], patch);
    }
  }
}

function applyVignetteExtras(nodes, pathToIndex, metadataPath, extras) {
  if (!metadataPath || !extras) return;
  const index = pathToIndex.get(metadataPath);
  if (index === undefined) throw new Error(`Metadata node not found: ${metadataPath}`);
  nodes[index].extras ??= {};
  nodes[index].extras.realvirtual ??= {};
  nodes[index].extras.realvirtual = deepMerge(nodes[index].extras.realvirtual, extras);
}

function createComponentStripMatchers(configuredPatterns) {
  if (configuredPatterns !== undefined && !Array.isArray(configuredPatterns)) {
    throw new Error('Vignette config "stripComponents" must be an array of names or "*" globs');
  }
  const patterns = [...DEFAULT_COMPONENT_STRIP_LIST, ...(configuredPatterns ?? [])];
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('Vignette config "stripComponents" entries must be non-empty strings');
    }
    const expression = pattern
      .trim()
      .replace(/[\\^$+?.()|[\]{}]/gu, '\\$&')
      .replace(/\*/gu, '.*');
    return { pattern, expression: new RegExp(`^${expression}$`, 'u') };
  });
}

function stripRvComponents(nodes, keptNodes, matchers) {
  const stripped = { count: 0, types: new Set() };
  for (const index of keptNodes) {
    const node = nodes[index];
    const rv = node.extras?.realvirtual;
    if (!isRecord(rv)) continue;
    for (const componentType of Object.keys(rv)) {
      if (!matchers.some((matcher) => matcher.expression.test(componentType))) continue;
      delete rv[componentType];
      stripped.count++;
      stripped.types.add(componentType);
    }
    if (Object.keys(rv).length === 0) {
      delete node.extras.realvirtual;
      if (Object.keys(node.extras).length === 0) delete node.extras;
    }
  }
  return stripped;
}

function deepMerge(base, patch) {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectNumbers(source, selector) {
  const result = new Set();
  for (const value of source) {
    const selected = selector(value);
    if (selected !== undefined) result.add(selected);
  }
  return result;
}

function collectTextureIndices(value, result) {
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (isRecord(value) && Number.isInteger(value.index)) result.add(value.index);
  for (const child of Object.values(value)) collectTextureIndices(child, result);
}

function createIndexMap(values) {
  return new Map([...values].sort((a, b) => a - b).map((value, index) => [value, index]));
}

function compact(values, map, rewrite = null) {
  if (!values || map.size === 0) return undefined;
  return [...map.keys()].map((oldIndex) => {
    const value = structuredClone(values[oldIndex]);
    rewrite?.(value, oldIndex);
    return value;
  });
}

function requiredMap(map, oldIndex, type) {
  const next = map.get(oldIndex);
  if (next === undefined) throw new Error(`Referenced ${type} ${oldIndex} was not retained`);
  return next;
}

function remapOptional(value, key, map) {
  if (value[key] !== undefined) value[key] = requiredMap(map, value[key], key);
}

function remapRecord(record, map, type) {
  if (!record) return;
  for (const key of Object.keys(record)) record[key] = requiredMap(map, record[key], type);
}

function remapTextureIndices(value, textureMap) {
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (isRecord(value) && Number.isInteger(value.index)) {
    value.index = requiredMap(textureMap, value.index, 'texture');
  }
  for (const child of Object.values(value)) remapTextureIndices(child, textureMap);
}

function sceneRoots(json, parents, keptNodes) {
  const configuredScene = json.scenes?.[json.scene ?? 0];
  const roots = (configuredScene?.nodes ?? []).filter((index) => keptNodes.has(index));
  if (roots.length > 0) return roots;
  return [...keptNodes].filter((index) => parents[index] < 0 || !keptNodes.has(parents[index]));
}

function repackBufferViews(values, map, binary) {
  const chunks = [];
  const bufferViews = [];
  let byteOffset = 0;
  for (const oldIndex of map.keys()) {
    const sourceView = values[oldIndex];
    if (sourceView.buffer !== 0) throw new Error('Only single-buffer GLBs are supported');
    if (sourceView.extensions?.EXT_meshopt_compression) {
      throw new Error('Crop compressed source GLBs only after decompression (EXT_meshopt_compression found)');
    }
    const start = sourceView.byteOffset ?? 0;
    const end = start + sourceView.byteLength;
    const chunk = binary.subarray(start, end);
    const padding = (4 - (chunk.length % 4)) % 4;
    chunks.push(chunk, Buffer.alloc(padding));
    const nextView = structuredClone(sourceView);
    nextView.buffer = 0;
    nextView.byteOffset = byteOffset;
    bufferViews.push(nextView);
    byteOffset += chunk.length + padding;
  }
  return { bufferViews, binary: Buffer.concat(chunks) };
}

function copyIfPresent(source, target, key) {
  if (source[key] !== undefined) target[key] = structuredClone(source[key]);
}

function runGltfTransform(commandArgs) {
  const npxCli = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js')
    : null;
  const command = npxCli ? process.execPath : 'npx';
  const prefix = npxCli ? [npxCli] : [];
  const result = spawnSync(
    command,
    [...prefix, '--yes', `@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}`, ...commandArgs],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const reason = result.error ? `: ${result.error.message}` : '';
    throw new Error(`glTF Transform failed with exit code ${result.status ?? 'unknown'}${reason}`);
  }
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes} bytes)`;
}
