import { describe, expect, it } from 'vitest';
import { harnessWithPreview, type RollerSpec } from './ribbon-fixture';

const lineWithDancer = (): RollerSpec[] => [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
  { name: 'Nip', xMm: 1500, yMm: 400, radiusMm: 80, driven: true },
  { name: 'Dancer', xMm: 2400, yMm: 200, radiusMm: 50, dancer: true, extras: { TravelMinMm: -150, TravelMaxMm: 150, Strands: 2 } },
  { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true, extras: { CoreRadiusMm: 100 } },
];

describe('ribbon editor overlays', () => {
  it('numbers the stations in run order and marks every tangent point', () => {
    const { h, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    expect(gizmos.textsOf('routing')).toEqual(['1', '2', '3', '4']); expect(gizmos.countOf('tangent')).toBe(8);
  });
  it('moves the tangent point when the roller moves', () => {
    const { h, preview, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    const before = gizmos.of('tangent', 'Nip').position as { distanceTo(v: unknown): number };
    h.nodes.get('Nip')!.position.y += 0.25; h.ribbonManager.solvePreview(); preview.onRender(0); h.ribbonManager.paths[0].setEditorPreview(true);
    const after = gizmos.of('tangent', 'Nip').position;
    expect(before.distanceTo(after)).toBeGreaterThan(1e-6);
  });
  it('places the track from the authored limits and shows the strand count', () => {
    const { h, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    const track = gizmos.of('dancer-track'); expect(track.minMm).toBeCloseTo(-150);
    expect(track.maxMm).toBeCloseTo(150); expect(track.homeMm).toBeCloseTo(0);
    expect(gizmos.textsOf('dancer-strands')).toEqual(['2']);
  });
  it('draws core and max diameter, and labels the speed source', () => {
    const { h, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    const env = gizmos.of('winder-envelope', 'Rewinder'); expect(env.coreRadiusMm).toBeCloseTo(100);
    expect(env.maxRadiusMm).toBeGreaterThan(env.coreRadiusMm as number);
    expect(gizmos.textsOf('winder-speed-source')).toContain('None');
  });
  it('tears every preview gizmo down when the editor mode is left', () => {
    const { h, preview, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    preview.onModeChanged({ from: 'editor', to: 'hmi' }); expect(gizmos.live).toHaveLength(0);
  });
  it('tears them down on a model swap inside the editor mode', () => {
    const { h, preview, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    preview.onModelCleared(); expect(gizmos.live).toHaveLength(0);
  });
  it('never writes ShowTravel, whatever the mode did', () => {
    const { h, preview } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath().setEditorPreview(true);
    const dancer = h.dancer('Dancer'); expect(dancer.ShowTravel).toBe(false);
    preview.onModeChanged({ from: 'editor', to: 'hmi' }); expect(dancer.ShowTravel).toBe(false);
  });
  it('does not restore diagnostic gizmos after an export pass', () => {
    const { h, preview, gizmos } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath();
    preview.beginExportPass(); preview.endExportPass();
    expect(gizmos.visible).toHaveLength(0);
  });
});
