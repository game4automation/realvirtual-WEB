import { BufferAttribute, Line, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { arcPoints, arcSpan, createArcGizmo } from '../src/core/engine/rv-arc-gizmo';
import { SIDE_COLOR } from '../src/core/engine/rv-ribbon-roller';
import { harnessWithPreview, type RollerSpec } from './ribbon-fixture';

const lineWithDancer = (): RollerSpec[] => [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
  { name: 'Nip', xMm: 1500, yMm: 400, radiusMm: 80, driven: true },
  { name: 'Dancer', xMm: 2400, yMm: 200, radiusMm: 50, dancer: true, extras: { TravelMinMm: -150, TravelMaxMm: 150, Strands: 2 } },
  { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true, extras: { CoreRadiusMm: 100 } },
];

describe('ribbon arc gizmo', () => {
  it('spans the wrap angle and survives a degenerate one', () => {
    expect(arcPoints({ startRad: 0, endRad: Math.PI / 2 })).toHaveLength(64);
    expect(arcSpan({ startRad: 1, endRad: 1 })).toBeGreaterThan(0);
    expect(arcSpan({ startRad: 0, endRad: 9 })).toBeLessThanOrEqual(2 * Math.PI);
  });
  it('is invisible to a raycast', () => {
    const arc = createArcGizmo({ startRad: 0, endRad: 1, radius: 0.2 });
    const ray = new Raycaster(); ray.set(new Vector3(0, 0, 5), new Vector3(0, 0, -1));
    expect(ray.intersectObject(arc, true)).toHaveLength(0);
  });
  it('updates its fixed buffer in place, draws a direction tip, and shares materials', () => {
    const first = createArcGizmo({ startRad: 0, endRad: 1, radius: 0.2, color: 0x123456, directionTip: true });
    const second = createArcGizmo({ startRad: 1, endRad: 2, radius: 0.3, color: 0x123456 });
    const firstLine = first.children[0] as Line;
    const secondLine = second.children[0] as Line;
    const attribute = firstLine.geometry.getAttribute('position') as BufferAttribute;
    const before = attribute.array;
    first.updateArc({ startRad: 0.5, endRad: 2, radius: 0.4, color: 0x123456, directionTip: true });
    expect((firstLine.geometry.getAttribute('position') as BufferAttribute).array).toBe(before);
    expect(first.children[1].visible).toBe(true);
    expect(firstLine.material).toBe(secondLine.material);
  });
  /**
   * Asserted one level BELOW the editor host on purpose.
   *
   * The host used to switch these arcs on in editor mode. It now calls
   * `setEditorBandPreview`, which deliberately clears the diagnostic overlays
   * (its first statement is `setEditorPreview(false)`) and shows the stopped
   * ribbon band instead — `ribbon-editor-band-preview.test.ts` covers that
   * route. Going through the host here would therefore assert a behaviour the
   * product no longer has. The path -> roller arc wiring itself is unchanged,
   * so it is driven directly.
   *
   * NOTE: nothing in the product calls `setEditorPreview(true)` any more. This
   * guard keeps the wiring honest for whoever re-attaches it (a toggle was the
   * stated intent); if it is never re-attached, this test and the overlay code
   * should go together, not separately.
   */
  it('draws one wrap arc per roller, coloured by the resolved side', () => {
    const { h, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); const path = h.buildPath();
    path.setEditorPreview(true);
    expect(gizmos.countOf('wrap-arc')).toBe(4);
    const nip = gizmos.of('wrap-arc', 'Nip'); expect(nip.spanRad).toBeGreaterThan(0);
    expect(nip.color).toBe(SIDE_COLOR[path.resolvedSideAt(1)]);
  });
});
