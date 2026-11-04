// plan-2030 F1: the frame-paced hover ray resolves a frame AFTER the pointermove, so the
// hovered node can change while the pointer stands still. 'object-hover' must be emitted on
// a node change too, not only on a >4px move — else GenericTooltipController never sees the
// hover and no tooltip (DES, metadata, ...) appears. The render loop cannot run in a unit
// test, so this guards the emit condition in the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('object-hover emit condition', () => {
  it('emits on a changed hovered node, not only on pointer movement', () => {
    const src = readFileSync(resolve(__dirname, '../src/core/rv-viewer.ts'), 'utf8');
    expect(src).toMatch(/const nodeChanged = hoveredNode !== this\.lastEmittedHoverNode;/);
    expect(src).toMatch(/if \(driveChanged \|\| movedEnough \|\| nodeChanged\) \{\s*this\.lastEmittedHoverNode = hoveredNode;/);
  });
});
