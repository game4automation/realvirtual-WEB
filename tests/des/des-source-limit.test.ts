// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { sourceFixture } from './phase4-source-fixture';

it.each(['fastforward', 'animated'] as const)('9.12 %s generates exactly five logical MUs', mode => {
  const f = sourceFixture(mode, 0, true);
  f.connect('Source', 'Storage'); f.connect('Storage', 'Sink');
  f.start(); f.advance(30);
  expect(f.created).toHaveBeenCalledTimes(5);
  expect(f.part('Storage').currentLoad).toBe(5);
});

it('9.12 restores the DES generation count independently of engine visual clones', () => {
  const f = sourceFixture('fastforward', 0, true);
  f.connect('Source', 'Sink');
  f.start(); f.advance(2);
  const snapshot = f.runner.fullSnapshot();
  expect(f.created).toHaveBeenCalledTimes(3);
  f.advance(30);
  expect(f.created).toHaveBeenCalledTimes(5);
  f.runner.restoreFull(snapshot);
  f.created.mockClear();
  f.advance(30);
  expect(f.created).toHaveBeenCalledTimes(2);
});
