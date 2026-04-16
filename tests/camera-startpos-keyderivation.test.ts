// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { deriveModelKey } from '../src/plugins/camera-startpos-plugin';

describe('deriveModelKey', () => {
  it('strips path and .glb extension', () => {
    expect(deriveModelKey('/models/MyModel.glb')).toBe('MyModel');
    expect(deriveModelKey('MyModel.glb')).toBe('MyModel');
  });
  it('handles full URLs with query string', () => {
    expect(deriveModelKey('https://cdn.example.com/a/b/Factory.glb?v=2')).toBe('Factory');
  });
  it('returns null for null/undefined/empty', () => {
    expect(deriveModelKey(null)).toBeNull();
    expect(deriveModelKey(undefined)).toBeNull();
    expect(deriveModelKey('')).toBeNull();
  });
  it('returns last path segment for blob URLs', () => {
    expect(deriveModelKey('blob:http://localhost:3000/abc-123')).toBe('abc-123');
  });
  it('is case-insensitive for .glb extension', () => {
    expect(deriveModelKey('/models/X.GLB')).toBe('X');
    expect(deriveModelKey('/models/Y.Glb')).toBe('Y');
  });
  it('handles filename without extension', () => {
    expect(deriveModelKey('/models/NoExt')).toBe('NoExt');
  });
});
