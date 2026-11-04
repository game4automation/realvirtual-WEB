// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { TweenRegistry } from '../../src/core/material-flow/tween-registry';

it('9.10 issues a positive first handle and ignores stale handles after reuse', () => {
  const registry = new TweenRegistry(1); // the first rented slot is index 0
  const target = { setPosition: vi.fn() };
  const old = registry.addDrive(target, 0, 10, 0, 10);
  expect.soft(old).toBe(1); // index 0, generation 1; currently 0
  registry.cancel(old);
  const next = registry.addDrive(target, 0, 20, 0, 10);
  registry.cancel(old);
  registry.onRender(5, 'animated');
  expect(target.setPosition).toHaveBeenLastCalledWith(10);
  expect(next).not.toBe(old);
  expect(registry.activeCount).toBe(1);
});

it('9.10 retires a slot at the generation limit without repeating a handle', () => {
  const registry = new TweenRegistry(1);
  const target = { setPosition: vi.fn() };
  const first = registry.addDrive(target, 0, 10, 0, 10);
  registry.cancel(first);
  registry.__setGenerationForTest(0, 2 ** 32 - 2);
  const terminal = registry.addDrive(target, 0, 10, 0, 10);
  expect(terminal).toBe(2 ** 32 - 2);
  registry.cancel(terminal);
  const next = registry.addDrive(target, 0, 20, 0, 10);
  expect(next).toBe(2 ** 32 + 1);
  expect(registry.poolSize).toBe(2);
  registry.cancel(first);
  registry.cancel(terminal);
  registry.onRender(5, 'animated');
  expect(target.setPosition).toHaveBeenLastCalledWith(10);
  expect(registry.activeCount).toBe(1);
});

it('9.10 keeps 5000 simultaneous handles unique and cancels pool index 4097 only', () => {
  const registry = new TweenRegistry(5000);
  const targets = Array.from({ length: 5000 }, () => ({ setPosition: vi.fn() }));
  const handles = targets.map(target => registry.addDrive(target, 0, 10, 0, 10));
  expect.soft(new Set(handles).size).toBe(5000);
  expect.soft(handles.every(handle => handle > 0)).toBe(true);
  // Pool rents from its free-list tail: allocation 902 rents index 4097.
  const selected = 5000 - 1 - 4097;
  registry.cancel(handles[selected]);
  registry.onRender(5, 'animated');
  expect.soft(targets[selected].setPosition).not.toHaveBeenCalled();
  expect.soft(registry.activeCount).toBe(4999);
  expect(targets.filter(target => target.setPosition.mock.calls.length === 1)).toHaveLength(4999);
});
