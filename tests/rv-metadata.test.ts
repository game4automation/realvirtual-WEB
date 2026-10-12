// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the RVMetadata factory component (rv-metadata.ts).
 *
 * RuntimeMetadata used to be special-cased in the scene loader; it is now a
 * first-class factory component (like TransportSurface) so it flows through the
 * standard hover/highlight + tooltip pipeline. These tests lock in the factory
 * registration, the userData contract other code depends on, and capabilities.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
// Value import (not type-only) so the module's side-effect registration runs.
import { RVMetadata } from '../src/core/engine/rv-metadata';
import {
  getRegisteredFactories,
  getCapabilities,
  applySchema,
} from '../src/core/engine/rv-component-registry';

/** Run the loader's per-node construction sequence for a registered factory. */
function constructViaFactory(node: Object3D, extras: Record<string, unknown>): RVMetadata {
  const factory = getRegisteredFactories().get('RuntimeMetadata')!;
  const instance = factory.create(node, null) as RVMetadata;
  applySchema(instance as unknown as Record<string, unknown>, factory.schema, extras);
  factory.afterCreate?.(instance, node);
  return instance;
}

describe('RVMetadata factory component', () => {
  it('is registered as a factory with needsAABB', () => {
    // Reference the class as a value so esbuild keeps the side-effect import.
    expect(RVMetadata.type).toBe('RuntimeMetadata');
    const factory = getRegisteredFactories().get('RuntimeMetadata');
    expect(factory).toBeDefined();
    expect(factory!.needsAABB).toBe(true);
    expect(factory!.displayName).toBe('Metadata');
  });

  it('maps the content field and stamps the _rvMetadata userData contract', () => {
    const node = new Object3D();
    const inst = constructViaFactory(node, { content: '<name>Pump A</name>' });

    expect(inst.content).toBe('<name>Pump A</name>');
    // Tooltip/search/order-manager all read _rvMetadata, regardless of which
    // component owns _rvComponentInstance.
    expect(node.userData._rvMetadata).toEqual({ content: '<name>Pump A</name>' });
    // Standalone metadata node claims the display type.
    expect(node.userData._rvType).toBe('Metadata');
    // Instance is attached for the standard component lifecycle.
    expect(node.userData._rvComponentInstance).toBe(inst);
  });

  it('does not clobber an existing _rvType (coexistence with Drive/Pipe/etc.)', () => {
    const node = new Object3D();
    node.userData._rvType = 'Drive';
    constructViaFactory(node, { content: '<name>Annotated Drive</name>' });

    expect(node.userData._rvType).toBe('Drive');
    expect(node.userData._rvMetadata).toEqual({ content: '<name>Annotated Drive</name>' });
  });

  it('getTooltipData returns the metadata content', () => {
    const node = new Object3D();
    node.name = 'PartRoot';
    const inst = constructViaFactory(node, { content: '<name>X</name>' });

    expect(inst.getTooltipData()).toMatchObject({ type: 'metadata', content: '<name>X</name>' });
  });

  it('registers hoverable tooltip capabilities under both RuntimeMetadata and Metadata', () => {
    for (const key of ['RuntimeMetadata', 'Metadata']) {
      const caps = getCapabilities(key);
      expect(caps.pick, key).toBe('select');
      expect(caps.ui.tooltip, key).toBe('metadata');
      expect(caps.ui.filter, key).toBe('Metadata');
    }
  });
});
