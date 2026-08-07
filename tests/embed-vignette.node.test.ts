// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const VIGNETTE = resolve(ROOT, 'public/embed/vignettes/conveyor-sensor.glb');
const DIST = resolve(ROOT, 'dist-embed');
const MAX_VIGNETTE_BYTES = 3 * 1024 * 1024;
const REQUIRED_COMPONENTS = [
  'ConveyorBelt',
  'TransportSurface',
  'Drive',
  'Source',
  'Sensor',
  'Sink',
  'MU',
];
const FORBIDDEN_COMPONENT_PATTERNS = [
  { category: 'industrial interface', expression: /Interfaces?$/iu },
  { category: 'test/debug', expression: /(?:Test|Debug|Diagnostic)/iu },
];
const DRACO_FILES = [
  'draco_decoder.js',
  'draco_decoder.wasm',
  'draco_wasm_wrapper.js',
];

describe('rv-embed AP3 vignette pipeline', () => {
  it('ships a compressed self-contained conveyor vignette with runtime rv_extras', () => {
    expect(existsSync(VIGNETTE)).toBe(true);
    expect(statSync(VIGNETTE).size).toBeLessThanOrEqual(MAX_VIGNETTE_BYTES);

    const json = readGlbJson(VIGNETTE);
    const componentNames = new Set<string>();
    let startCamera: unknown;
    let standalone: unknown;
    let director: unknown;
    for (const node of json.nodes ?? []) {
      const rv = node.extras?.realvirtual;
      if (!rv) continue;
      for (const key of Object.keys(rv)) componentNames.add(key);
      startCamera ??= rv.StartCameraPosition;
      standalone ??= rv.StandaloneBehavior;
      director ??= rv.Director;
    }

    for (const component of REQUIRED_COMPONENTS) {
      expect(componentNames.has(component), `missing ${component}`).toBe(true);
    }
    const forbiddenComponents = [...componentNames].flatMap((component) => (
      FORBIDDEN_COMPONENT_PATTERNS
        .filter(({ expression }) => expression.test(component))
        .map(({ category }) => `${category}: ${component}`)
    ));
    expect(
      forbiddenComponents,
      `vignette contains forbidden rv_extras components: ${forbiddenComponents.join(', ')}`,
    ).toEqual([]);
    expect(startCamera).toMatchObject({
      Name: 'conveyor-overview',
      Position: [6.5, 3.45, 1.8],
      Target: [2.2, 0.35, 0.1],
    });
    expect(standalone).toMatchObject({
      Mode: 'Autonomous',
      Source: 'DemoCell/Turbine',
    });
    expect(director).toMatchObject({
      Scripts: {
        'conveyor-loop': {
          loop: true,
          steps: expect.arrayContaining([{
            camera: {
              focus: 'DemoCell',
              padding: 1.08,
            },
            duration: 1400,
          }]),
        },
      },
    });
    expect(json.extensionsRequired).toContain('KHR_draco_mesh_compression');
  });

  it('emits the Draco decoder beside the CDN-relative embed entry', () => {
    const npxCli = process.platform === 'win32'
      ? resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js')
      : null;
    execFileSync(npxCli ? process.execPath : 'npx', [
      ...(npxCli ? [npxCli] : []),
      'vite',
      'build',
      '--config',
      'vite.embed.config.ts',
    ], {
      cwd: ROOT,
      stdio: 'pipe',
    });

    for (const file of DRACO_FILES) {
      const path = resolve(DIST, 'draco', file);
      expect(existsSync(path), `missing dist decoder ${file}`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    const chunkDir = resolve(DIST, 'chunks');
    const decoderOwner = readdirSync(chunkDir)
      .filter((file) => file.endsWith('.js'))
      .map((file) => resolve(chunkDir, file))
      .find((file) => (
        /new URL\(["']\.\.\/draco\/["'],\s*import\.meta\.url\)/u
          .test(readFileSync(file, 'utf8'))
      ));
    expect(decoderOwner, 'missing module-relative Draco URL').toBeTruthy();
    expect(resolve(dirname(decoderOwner!), '../draco')).toBe(resolve(DIST, 'draco'));
  }, 120_000);
});

interface GlbNode {
  extras?: {
    realvirtual?: Record<string, unknown>;
  };
}

interface GlbJson {
  nodes?: GlbNode[];
  extensionsRequired?: string[];
}

function readGlbJson(path: string): GlbJson {
  const bytes = readFileSync(path);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
  return JSON.parse(
    bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\s\u0000]+$/u, ''),
  ) as GlbJson;
}
