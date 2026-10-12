import { describe, expect, it, vi } from 'vitest';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';
import { harnessWithDocument, harnessWithPreview, ribbonHarness, type RollerSpec } from './ribbon-fixture';

export function lineWithDancer(): RollerSpec[] {
  return [
    { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
    { name: 'Nip', xMm: 1500, yMm: 400, radiusMm: 80, driven: true },
    { name: 'Dancer', xMm: 2400, yMm: 200, radiusMm: 50, dancer: true,
      extras: { TravelAxis: 'Y', TravelMinMm: -150, TravelMaxMm: 150, Strands: 2 } },
  { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true, driven: true, extras: { CoreRadiusMm: 100 } },
  ];
}

describe('ribbon editor preview', () => {
  it('writes no signal', () => {
    const h = ribbonHarness(lineWithDancer()); h.buildPath();
    const write = vi.fn(); h.ribbonManager.setSignalWriter(write);
    h.ribbonManager.solvePreview(); expect(write).not.toHaveBeenCalled();
  });
  it('sets no drive setpoint', () => {
    const h = ribbonHarness(lineWithDancer()); h.buildPath();
    const w = h.roller('Rewinder') as unknown as RVRibbonWinder;
    const spy = vi.spyOn(w, 'controlDriveSpeed'); h.ribbonManager.solvePreview();
    expect(spy).not.toHaveBeenCalled();
  });
  it('restores the real writer, even when the solve throws', () => {
    const h = ribbonHarness(lineWithDancer()); const path = h.buildPath();
    const write = vi.fn(); h.ribbonManager.setSignalWriter(write);
    vi.spyOn(path, 'updatePose').mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => h.ribbonManager.solvePreview()).toThrow();
    expect((h.ribbonManager as unknown as { _write: unknown })._write).toBe(write);
  });
  it('is idempotent: the carriage and the wound length stay put', () => {
    const h = ribbonHarness(lineWithDancer()); h.buildPath();
    const dancer = h.dancer('Dancer'); const w = h.roller('Rewinder') as unknown as RVRibbonWinder;
    const pos = dancer.positionMm; const wound = w.woundLengthMm;
    h.ribbonManager.solvePreview(); h.ribbonManager.solvePreview();
    expect(dancer.positionMm).toBeCloseTo(pos, 6); expect(w.woundLengthMm).toBeCloseTo(wound, 6);
  });
  it('leaves document.dirty false', () => {
    const { h, doc } = harnessWithDocument(lineWithDancer()); h.buildPath();
    h.ribbonManager.solvePreview(); expect(doc.dirty).toBe(false);
  });
  it('re-routes the band after a roller moved, with no tick at all', () => {
    const h = ribbonHarness(lineWithDancer()); const path = h.buildPath(); h.ribbonManager.solvePreview();
    const before = path.lengthMm; h.nodes.get('Nip')!.position.y += 0.25; h.ribbonManager.solvePreview();
    expect(path.lengthMm).not.toBeCloseTo(before, 3);
  });
  it('solves once for a burst, and not at all for an unchanged signature', () => {
    vi.useFakeTimers(); const { h, preview } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath();
    const solve = vi.spyOn(h.ribbonManager, 'solvePreview'); h.dancer('Dancer').TravelMaxMm = 200;
    preview.notifyDefinitionChanged(); preview.notifyDefinitionChanged(); preview.notifyDefinitionChanged();
    vi.advanceTimersByTime(500); expect(solve).toHaveBeenCalledTimes(1);
    preview.notifyDefinitionChanged(); vi.advanceTimersByTime(500); expect(solve).toHaveBeenCalledTimes(1); vi.useRealTimers();
  });
  it('solves on a silent roller move, with no event fired at all', () => {
    const { h, preview } = harnessWithPreview(lineWithDancer(), { mode: 'editor' }); h.buildPath();
    const solve = vi.spyOn(h.ribbonManager, 'solvePreview'); h.nodes.get('Nip')!.position.y += 0.1;
    preview.onRender(1 / 60); expect(solve).toHaveBeenCalledTimes(1);
  });
});
