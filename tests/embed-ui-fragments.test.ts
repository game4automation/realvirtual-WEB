// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineRVEmbedElement,
  RVEmbedElement,
  type RVEmbedReadyDetail,
} from '../src/embed/rv-embed-element';
import type { RVEmbedDirectorActionDetail } from '../src/embed/rv-embed-director';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';
import {
  installEmbedBrowserMocks,
  type EmbedBrowserMocks,
} from './embed-test-kit';

const MODEL_URL = '/models/physics-zone-test.glb';
const NODE_PATH = 'Path/Point_3';
const elements: RVEmbedElement[] = [];
let mocks: EmbedBrowserMocks;

beforeEach(() => {
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
  vi.restoreAllMocks();
  mocks.restore();
});

describe('rv-embed product UI fragments', () => {
  it('opens the director context menu in the owning shadow root and closes it again', async () => {
    const { element, engine } = await bootElement();
    addNode(engine);

    openContextMenu(element, engine, ['Jump to Signal', 'Isolate']);

    const menu = contextMenu(element);
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('aria-hidden')).toBe('false');
    expect(menuItems(element).map((item) => item.textContent?.trim())).toEqual([
      'Jump to Signal',
      'Isolate',
    ]);

    element.viewer.director.run([{ contextMenu: { open: false } }]);
    engine.step(1 / 60);
    expect(menu.hidden).toBe(true);

    openContextMenu(element, engine, ['Dismiss me']);
    closeButton(element).click();
    expect(menu.hidden).toBe(true);
  }, 30_000);

  it('keeps context-menu state isolated across two rv-embed instances', async () => {
    const first = await bootElement();
    const second = await bootElement();
    addNode(first.engine);
    addNode(second.engine);

    openContextMenu(first.element, first.engine, ['First action']);
    expect(contextMenu(first.element).hidden).toBe(false);
    expect(contextMenu(second.element).hidden).toBe(true);
    expect(menuItems(second.element)).toHaveLength(0);

    openContextMenu(second.element, second.engine, ['Second action']);
    expect(contextMenu(first.element).hidden).toBe(false);
    expect(menuItems(first.element)[0]?.textContent).toContain('First action');
    expect(contextMenu(second.element).hidden).toBe(false);
    expect(menuItems(second.element)[0]?.textContent).toContain('Second action');

    closeButton(second.element).click();
    expect(contextMenu(second.element).hidden).toBe(true);
    expect(contextMenu(first.element).hidden).toBe(false);
  }, 30_000);

  it('renders live values from the real SignalStore subscription', async () => {
    const { element, engine } = await bootElement();
    addNode(engine);
    const signalName = 'PathPoint.SelectedPosition';

    openContextMenu(element, engine, [signalName]);
    const value = signalValue(element, signalName);
    expect(value.hidden).toBe(true);

    engine.signalStore!.set(signalName, 12.375);
    expect(value.hidden).toBe(false);
    expect(value.textContent).toBe('12.375');

    engine.signalStore!.set(signalName, 18);
    expect(value.textContent).toBe('18');
  }, 30_000);

  it('writes the real path-point transform when the full-mode gizmo is dragged', async () => {
    const { element, engine } = await bootElement();
    const node = addNode(engine);
    element.viewer.director.run([{
      drag: { node: NODE_PATH, to: [0, 0, 0], duration: 0 },
    }]);
    engine.step(1 / 60);

    const gizmo = pathGizmo(element);
    expect(gizmo.hidden).toBe(false);
    expect(gizmo.dataset.interactive).toBe('false');
    expect(gizmo.textContent).toContain('X 0.000 m');
    const before = node.position.clone();

    gizmo.dispatchEvent(pointerEvent('pointerdown', 10, 20));
    gizmo.dispatchEvent(pointerEvent('pointermove', 54, 2));
    gizmo.dispatchEvent(pointerEvent('pointerup', 54, 2));
    expect(node.position.equals(before)).toBe(true);

    element.setAttribute('interactive', 'full');
    expect(gizmo.dataset.interactive).toBe('true');
    gizmo.dispatchEvent(pointerEvent('pointerdown', 10, 20));
    gizmo.dispatchEvent(pointerEvent('pointermove', 54, 2));
    gizmo.dispatchEvent(pointerEvent('pointerup', 54, 2));

    expect(node.position.equals(before)).toBe(false);
    expect(node.matrixWorldNeedsUpdate).toBe(false);
    expect(gizmo.textContent).not.toContain('X 0.000 m  Y 0.000 m  Z 0.000 m');
  }, 30_000);

  it('scopes every fragment listener to the element lifecycle signal and removes it on dispose', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const element = document.createElement('rv-embed') as RVEmbedElement;
    elements.push(element);
    element.setAttribute('src', MODEL_URL);
    element.setAttribute('run', 'manual');
    element.setAttribute('interactive', 'full');
    element.style.width = '320px';
    element.style.height = '200px';

    const elementAdd = vi.spyOn(element, 'addEventListener');
    const menu = contextMenu(element);
    const menuAdd = vi.spyOn(menu, 'addEventListener');
    const close = closeButton(element);
    const closeAdd = vi.spyOn(close, 'addEventListener');
    const gizmo = pathGizmo(element);
    const gizmoAdd = vi.spyOn(gizmo, 'addEventListener');

    const ready = readyViewer(element);
    document.body.append(element);
    await element.viewer.play();
    const engine = await ready;
    engine.loop.stop();
    engine.setPaused('document-hidden', false);
    engine.setPaused('offscreen', false);
    addNode(engine);
    openContextMenu(element, engine, ['Lifecycle.Signal']);
    element.viewer.director.run([{ drag: { node: NODE_PATH, to: [0, 0, 0], duration: 0 } }]);
    engine.step(1 / 60);

    const lifecycleSignal = eventSignal(documentAdd.mock.calls, 'visibilitychange');
    expect(lifecycleSignal).toBeInstanceOf(AbortSignal);
    expect(eventSignal(elementAdd.mock.calls, 'rv-director-context-menu')).toBe(lifecycleSignal);
    expect(eventSignal(elementAdd.mock.calls, 'rv-director-drag')).toBe(lifecycleSignal);
    expect(eventSignal(menuAdd.mock.calls, 'pointerdown')).toBe(lifecycleSignal);
    expect(eventSignal(closeAdd.mock.calls, 'click')).toBe(lifecycleSignal);
    expect(eventSignal(gizmoAdd.mock.calls, 'pointerdown')).toBe(lifecycleSignal);

    element.viewer.dispose();
    expect(lifecycleSignal!.aborted).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(gizmo.hidden).toBe(true);

    element.dispatchEvent(new CustomEvent<RVEmbedDirectorActionDetail>(
      'rv-director-context-menu',
      {
        detail: {
          type: 'contextMenu',
          open: true,
          nodePath: NODE_PATH,
          items: ['Must stay closed'],
          position: [20, 20],
        },
      },
    ));
    expect(menu.hidden).toBe(true);
    expect(menuItems(element)).toHaveLength(0);
  }, 30_000);
});

async function bootElement(): Promise<{ element: RVEmbedElement; engine: RVEmbedViewer }> {
  const element = document.createElement('rv-embed') as RVEmbedElement;
  elements.push(element);
  element.setAttribute('src', MODEL_URL);
  element.setAttribute('run', 'manual');
  element.style.width = '320px';
  element.style.height = '200px';
  const ready = readyViewer(element);
  document.body.append(element);
  await element.viewer.play();
  const engine = await ready;
  engine.loop.stop();
  engine.setPaused('document-hidden', false);
  engine.setPaused('offscreen', false);
  return { element, engine };
}

function readyViewer(element: RVEmbedElement): Promise<RVEmbedViewer> {
  return new Promise((resolve) => {
    element.addEventListener('rv-ready', ((event: CustomEvent<RVEmbedReadyDetail>) => {
      resolve(event.detail.viewer);
    }) as EventListener, { once: true });
  });
}

function addNode(viewer: RVEmbedViewer): Object3D {
  const node = new Object3D();
  node.name = 'Point_3';
  viewer.loadResult!.root.add(node);
  viewer.loadResult!.registry.registerNode(NODE_PATH, node);
  return node;
}

function openContextMenu(
  element: RVEmbedElement,
  engine: RVEmbedViewer,
  items: readonly string[],
): void {
  element.viewer.director.run([{ contextMenu: { at: NODE_PATH, items } }]);
  engine.step(1 / 60);
}

function contextMenu(element: RVEmbedElement): HTMLElement {
  return required(element.shadowRoot?.querySelector<HTMLElement>('[part="context-menu"]'));
}

function closeButton(element: RVEmbedElement): HTMLButtonElement {
  return required(element.shadowRoot?.querySelector<HTMLButtonElement>('[part="context-menu-close"]'));
}

function menuItems(element: RVEmbedElement): HTMLButtonElement[] {
  return [...element.shadowRoot?.querySelectorAll<HTMLButtonElement>('[part="context-menu-item"]') ?? []];
}

function signalValue(element: RVEmbedElement, signal: string): HTMLElement {
  const values = element.shadowRoot?.querySelectorAll<HTMLElement>('[part="context-menu-value"]') ?? [];
  return required([...values].find((value) => value.dataset.signal === signal));
}

function pathGizmo(element: RVEmbedElement): HTMLButtonElement {
  return required(element.shadowRoot?.querySelector<HTMLButtonElement>('[part="path-gizmo"]'));
}

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId: 7,
  });
}

function required<T>(value: T | null | undefined): T {
  if (!value) throw new Error('Required rv-embed UI fragment was not found');
  return value;
}

function eventSignal(
  calls: Array<[type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions]>,
  type: string,
): AbortSignal | undefined {
  const call = calls.find(([eventType]) => eventType === type);
  const options = call?.[2];
  return typeof options === 'object' ? options.signal : undefined;
}
