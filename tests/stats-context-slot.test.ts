// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';

it('every loader context reads the active statistics slot', async () => {
  const source = await fetch('/src/core/engine/rv-scene-loader.ts').then(r => r.text());
  const managers = source.match(/kinematicManager:\s*getKinematicManager\(\)/g) ?? [];
  expect(managers).toHaveLength(3);
  expect(source.match(/statsRegistry:\s*getActiveStatsRegistry\(\)/g)).toHaveLength(managers.length);
  const signals = await fetch('/src/core/engine/rv-signal-construction.ts').then(r => r.text());
  expect(signals.match(/statsRegistry:\s*getActiveStatsRegistry\(\)/g)).toHaveLength(1);
});
