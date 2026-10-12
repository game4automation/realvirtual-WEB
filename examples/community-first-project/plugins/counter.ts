// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { RVViewer } from '../../../src/core/rv-viewer';
import type { RVViewerPlugin } from '../../../src/core/rv-plugin';

const PLUGIN_ID = 'community-example-counter';
const SIGNAL = 'Community.Clicks';

class CounterPlugin implements RVViewerPlugin {
  readonly id = PLUGIN_ID;
  private button: HTMLButtonElement | null = null;
  private unsubscribe: (() => void) | null = null;

  onModelLoaded(_result: unknown, viewer: RVViewer): void { this.mount(viewer); }
  onActivate(viewer: RVViewer): void { this.mount(viewer); }
  onDeactivate(): void { this.teardown(); }
  onModelCleared(): void { this.teardown(); }
  dispose(): void { this.teardown(); }

  private mount(viewer: RVViewer): void {
    this.teardown();
    const store = viewer.signalStore;
    if (!store) return;
    const writer = store.createWriter(PLUGIN_ID, 'plugin');
    if (store.get(SIGNAL) === undefined) writer.set(SIGNAL, 0);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = PLUGIN_ID;
    button.style.cssText = 'position:fixed;bottom:80px;left:16px;z-index:1400;padding:12px;background:#fff;color:#111;border:2px solid #126d88;border-radius:6px';
    const update = (value: boolean | number) => { button.textContent = `Community counter: ${value}`; };
    update(store.get(SIGNAL) ?? 0);
    this.unsubscribe = store.subscribe(SIGNAL, update);
    button.onclick = () => writer.set(SIGNAL, Number(store.get(SIGNAL) ?? 0) + 1);
    document.body.append(button);
    this.button = button;
  }

  private teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.button) this.button.onclick = null;
    this.button?.remove();
    this.button = null;
  }
}

export function registerModelPlugins(viewer: RVViewer): void {
  viewer.removePlugin(PLUGIN_ID);
  viewer.use(new CounterPlugin());
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  viewer.removePlugin(PLUGIN_ID);
}
