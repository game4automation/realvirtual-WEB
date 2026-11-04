// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { runnerFixture } from './runner-fixture';

afterEach(() => { vi.restoreAllMocks(); clearAllProblems(); });

it('9.22 rejects zero capacity before adding a live instance and reports a Problem', () => {
  clearAllProblems();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const scene = new Scene();
  const node = new Object3D(); node.name = 'InvalidStorage';
  node.userData.realvirtual = { Storage: { MaxCapacity: 0 } };
  scene.add(node);
  const f = runnerFixture(scene);
  expect.soft(getProblems().some(p => p.code === 'des-invalid-capacity')).toBe(true);
  expect.soft(f.runner.liveInstances.some(i => i.adapter.node === node)).toBe(false);
  expect(error).not.toHaveBeenCalled();
});
