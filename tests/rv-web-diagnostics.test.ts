// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-diagnostics.test.ts — Signal→event trigger of the WebDiagnostics
 * engine marker (plan-253, F6/F10/F11). Template: rv-web-sensor.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import { RVWebDiagnostics, __resetWebDiagnosticsWarnings } from '../src/core/engine/rv-web-diagnostics';
import { SignalStore } from '../src/core/engine/rv-signal-store';

type DiagnoseEvent = ViewerEvents['diagnose-request'];

function setup(bind: 'bool' | 'int' | 'none' | 'both', fields: Partial<RVWebDiagnostics> = {}) {
  const store = new SignalStore();
  const events = new EventEmitter<ViewerEvents>();
  const received: DiagnoseEvent[] = [];
  events.on('diagnose-request', (e) => received.push(e));
  if (bind === 'bool' || bind === 'both') store.register('Err', 'Err', false);
  if (bind === 'int' || bind === 'both') store.register('ErrCode', 'ErrCode', 0);
  const node = new Mesh(new BoxGeometry());
  new Scene().add(node);
  node.name = 'Station1';
  const inst = new RVWebDiagnostics(node);
  if (bind === 'bool' || bind === 'both') inst.SignalBool = 'Err';
  if (bind === 'int' || bind === 'both') inst.SignalInt = 'ErrCode';
  Object.assign(inst, fields);
  inst.init({ signalStore: store, events } as never);
  return { inst, store, events, received };
}

describe('RVWebDiagnostics', () => {
  beforeEach(() => {
    __resetWebDiagnosticsWarnings();
  });

  it('rising edge (bool) emits exactly one diagnose-request', () => {
    const { store, received } = setup('bool', { Label: 'Axis 2', ErrorId: 'SYST-320' });
    expect(received).toHaveLength(0);
    store.set('Err', true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      nodePath: 'Station1',
      errorActive: true,
      errorId: 'SYST-320',
      label: 'Axis 2',
      autoOpen: true,
    });
  });

  it('identical value does not re-fire (no double call)', () => {
    const { store, received } = setup('bool');
    store.set('Err', true);
    store.set('Err', true);
    expect(received.filter((e) => e.errorActive !== false)).toHaveLength(1);
  });

  it('errorId falls back to the node path when ErrorId is empty', () => {
    const { store, received } = setup('bool');
    store.set('Err', true);
    expect(received[0].errorId).toBe('Station1');
  });

  it('int mode: change to non-zero fires with errorCode', () => {
    const { store, received } = setup('int', { DocFilter: 'crx-manual' });
    store.set('ErrCode', 320);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ errorCode: 320, errorActive: true, docFilter: 'crx-manual' });
  });

  it('int mode: return to 0 emits falling edge (F11)', () => {
    const { store, received } = setup('int');
    store.set('ErrCode', 7);
    store.set('ErrCode', 0);
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ nodePath: 'Station1', errorActive: false });
  });

  it('bool falling edge emits errorActive:false (never debounced)', () => {
    const { store, received } = setup('bool');
    store.set('Err', true);
    store.set('Err', false);
    expect(received).toHaveLength(2);
    expect(received[1].errorActive).toBe(false);
  });

  it('initial high value at init fires once (no race)', () => {
    const store = new SignalStore();
    const events = new EventEmitter<ViewerEvents>();
    const received: DiagnoseEvent[] = [];
    events.on('diagnose-request', (e) => received.push(e));
    store.register('Err', 'Err', true); // already true BEFORE init
    const node = new Mesh(new BoxGeometry());
  new Scene().add(node);
    node.name = 'N';
    const inst = new RVWebDiagnostics(node);
    inst.SignalBool = 'Err';
    inst.init({ signalStore: store, events } as never);
    expect(received).toHaveLength(1);
  });

  it('onSceneReady re-subscribes without double-fire (path timing)', () => {
    const { inst, store, events, received } = setup('bool');
    inst.onSceneReady({ signalStore: store, events } as never);
    expect(received).toHaveLength(0);          // unchanged value → no event
    store.set('Err', true);
    expect(received).toHaveLength(1);          // old subscription gone → exactly one
  });

  it('no signal bound → inactive, warn-once, NO random-demo fallback', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received } = setup('none');
    setup('none'); // same path → warn-once suppresses the second warning
    expect(received).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('int beats bool when both bound (warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, received } = setup('both');
    store.set('Err', true);              // bool ignored
    expect(received).toHaveLength(0);
    store.set('ErrCode', 3);
    expect(received).toHaveLength(1);
    expect(received[0].errorCode).toBe(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('AutoOpen=false is forwarded in the payload', () => {
    const { store, received } = setup('bool', { AutoOpen: false });
    store.set('Err', true);
    expect(received[0].autoOpen).toBe(false);
  });
});
