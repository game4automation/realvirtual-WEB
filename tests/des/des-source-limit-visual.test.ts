// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { sourceFixture } from './phase4-source-fixture';

it('9.12b Animated limited source gives every generated MU a visual', () => {
  const f = sourceFixture('animated', 0, true);
  f.connect('Source', 'Storage'); f.connect('Storage', 'Sink');
  f.start(); f.advance(30);
  const mus = f.part('Storage').heldMUs;
  // Check visuals first: this diagnoses the invisible sixth-and-later MUs separately.
  expect(mus.filter(mu => !mu.visual), 'generated MUs without a visual').toHaveLength(0);
  expect(mus).toHaveLength(5);
  expect(f.created).toHaveBeenCalledTimes(5);
});
