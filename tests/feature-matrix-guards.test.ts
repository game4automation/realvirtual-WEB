// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  isProtected,
  PROTECTED_PLUGIN_IDS,
} from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-guards';

describe('feature matrix toggle guards', () => {
  it('protects the matrix and asset editor lifecycle', () => {
    expect(PROTECTED_PLUGIN_IDS).toEqual(new Set(['feature-matrix', 'asset-editor']));
    expect(isProtected('feature-matrix')).toBe(true);
    expect(isProtected('asset-editor')).toBe(true);
  });

  it('leaves other and unknown plugins toggleable', () => {
    expect(isProtected('des-plugin')).toBe(false);
    expect(isProtected('unknown')).toBe(false);
  });
});
