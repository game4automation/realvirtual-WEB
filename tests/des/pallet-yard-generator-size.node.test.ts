// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'pallet-yard-size-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const baseline = join(root, 'public/demo-realvirtual/PalletYard.glb');
const baselineManifest = join(root, 'public/demo-realvirtual/project.json');
const generate = (glb: string, manifest: string, size?: string) => spawnSync(process.execPath,
  [join(root, 'tools/des-examples/pallet-yard.mjs'), ...(size === undefined ? [] : ['--size', size]), glb, manifest],
  { cwd: root, encoding: 'utf8', windowsHide: true });
const config = (file: string) => {
  const bytes = readFileSync(file);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  expect(json.asset.version).toBe('2.0');
  const cfg = json.nodes.find((node: { name: string }) => node.name === 'PalletYardRoot').extras.realvirtual.PalletYard;
  const placements = json.nodes.filter((node: { extras?: { realvirtual?: { Agv?: unknown } } }) => node.extras?.realvirtual?.Agv);
  expect(placements).toHaveLength(cfg.vehicles.length);
  return cfg;
};

describe('PalletYard generator size', () => {
  it('keeps default GLB bytes and the existing project row exactly unchanged', () => {
    const glb = join(temp, 'PalletYard.glb'), manifest = join(temp, 'project.json');
    copyFileSync(baseline, glb); copyFileSync(baselineManifest, manifest);
    const before = readFileSync(manifest);
    const result = generate(glb, manifest);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(glb).equals(readFileSync(baseline))).toBe(true);
    expect(readFileSync(manifest).equals(before)).toBe(true);
    expect(config(glb).Size).toBe(2);
  }, 120_000);
  it('also generates identical default bytes into a fresh path', () => {
    const glb = join(temp, 'fresh.glb'), manifest = join(temp, 'fresh.json');
    writeFileSync(manifest, '{"documents":[]}');
    const result = generate(glb, manifest);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(glb).equals(readFileSync(baseline))).toBe(true);
    const row = JSON.parse(readFileSync(manifest, 'utf8')).documents[0];
    const checked = JSON.parse(readFileSync(baselineManifest, 'utf8')).documents.find((r: { path: string }) => r.path === 'PalletYard.glb');
    expect(row.sha256).toBe(checked.sha256); expect(row.sizeBytes).toBe(checked.sizeBytes);
  }, 120_000);
  it.each([1, 4])('size %i scales stations and vehicles in valid GLBs', (size) => {
    const glb = join(temp, `size-${size}.glb`), manifest = join(temp, `size-${size}.json`);
    writeFileSync(manifest, '{"documents":[]}');
    const result = generate(glb, manifest, String(size));
    expect(result.status, result.stderr).toBe(0);
    const cfg = config(glb), base = config(baseline);
    expect(cfg.Size).toBe(size);
    expect(cfg.stations.length).toBe(size * 6);
    expect(cfg.vehicles.length).toBe(Math.floor(size * 1.5 + 0.5));
    expect(Math.sign(cfg.stations.length - base.stations.length)).toBe(Math.sign(size - 2));
    expect(Math.sign(cfg.vehicles.length - base.vehicles.length)).toBe(Math.sign(size - 2));
  }, 120_000);
  it.each(['0', '17', 'abc', '1.5'])('rejects size %s without writing either file', (size) => {
    const glb = join(temp, `invalid-${size}.glb`), manifest = join(temp, `invalid-${size}.json`);
    const result = generate(glb, manifest, size);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('expected integer 1..16');
    expect(existsSync(glb)).toBe(false); expect(existsSync(manifest)).toBe(false);
  });
});
