// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Eager loader of variants (plan-2013 §2.7, Concept D). The switch is the inspector's ⋮
 * menu entry "Variant management", remembered per user and per DOCUMENT
 * (`rv-variant-ui-mode.ts`): a document WITH variants opens with it on, a document without
 * looks exactly like today, and a user decision survives a reload. With the mode off
 * nothing is loaded, shown or written — also not for a document WITH a block (U1): it opens
 * in Base and a save copies the block untouched. Tiny on purpose (9.3 budget); the runtime,
 * its UI and the command bodies come with `import()`.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import { setVariantInScene } from '../../core/hmi/rv-run-lease';
import {
  rememberVariantMode,
  setVariantModeContext,
  variantModeOf,
} from '../../core/hmi/rv-variant-ui-mode';
import { ensureVariantCommandsRegistered } from './variant-command-descriptors';
import type { VariantsRuntime } from './variants-runtime';

type Root = { userData?: Record<string, unknown> } | null;

export class VariantsPlugin implements RVViewerPlugin {
  readonly id = 'variants';
  readonly core = true;
  readonly order = 61;
  private _viewer: RVViewer | null = null;
  private _root: Root = null;
  private _load = 0;
  private _rt: Promise<VariantsRuntime> | null = null;
  /** The load the runtime is bound to (re-enabling keeps unsaved edits). */
  private _boundLoad = -1;

  /** Variant management is on for the open document. */
  get enabled(): boolean { return variantModeOf(this._docKey, this.documentHasVariants); }
  /** The document carries a `Variants` or `PlanningScenarios` block. */
  get documentHasVariants(): boolean {
    const rv = this._root?.userData?.realvirtual as Record<string, unknown> | undefined;
    return !!rv && (rv.Variants !== undefined || rv.PlanningScenarios !== undefined);
  }
  /** Identity of the open document — the mode is remembered per document. */
  private get _docKey(): string { return this._viewer?.currentModelUrl ?? '(no document)'; }
  /** Identity changes even when the same document is loaded again. */
  get documentLoadId(): string { return `variants-doc-${this._load}`; }
  get runtimeLoaded(): boolean { return this._rt !== null; }

  init(viewer: RVViewer): void { ensureVariantCommandsRegistered(); this._viewer = viewer; }

  onModelLoaded(result: unknown, viewer: RVViewer): void {
    this._viewer = viewer;
    const load = ++this._load;
    setVariantInScene(false);
    this._root = (result as { root?: Root } | null)?.root ?? null;
    this._publishContext();
    if (!this.enabled) {
      this._boundLoad = -1;
      void this._rt?.then((rt) => rt.unbindDocument());
      return;
    }
    void this.runtime().then((rt) => {
      if (load !== this._load) return null;
      return rt.bindDocument(this._root, { applyActive: true }).then((result) => {
        if (load === this._load) this._boundLoad = load;
        return result;
      });
    }).catch((err) => console.error('[variants]', err));
  }

  onModelCleared(): void {
    this._load++;
    this._boundLoad = -1;
    setVariantInScene(false);
    this._root = null;
    setVariantModeContext(null);
    void this._rt?.then((rt) => rt.unbindDocument());
  }

  /** Publishes what the inspector's ⋮ menu needs (document identity + the switch). */
  private _publishContext(): void {
    setVariantModeContext({
      docKey: this._docKey,
      hasVariants: this.documentHasVariants,
      setMode: (on) => this.setEnabled(on),
    });
  }

  /** On: mode + runtime (a saved `active` applies at the next load). Off: Base first, data stays. */
  async setEnabled(on: boolean): Promise<void> {
    if (!on && this._rt) {
      const rt = await this._rt;
      if (rt.store.dirty) throw new Error('Save or discard variant changes first');
      const r = await rt.store.activate(null);
      if (!r.ok) throw new Error(`variants stay on: going back to Base failed (${r.error})`);
      rt.unbindDocument();
      this._boundLoad = -1;
    }
    rememberVariantMode(this._docKey, on, this.documentHasVariants);
    this._publishContext();
    if (!on) return;
    const load = this._load;
    const rt = await this.runtime();
    if (this._boundLoad === load && rt.bound) { rt.setUiEnabled(true); return; }
    await rt.bindDocument(this._root, { applyActive: false });
    if (load === this._load) this._boundLoad = load;
  }

  /** Command access binds the current document without applying its saved active variant or showing UI. */
  async commandRuntime(): Promise<VariantsRuntime> {
    const rt = await this.runtime();
    if (!rt.bound && this._root) {
      const load = this._load;
      await rt.bindDocument(this._root, { applyActive: false });
      if (load === this._load) this._boundLoad = load;
    }
    return rt;
  }

  runtime(): Promise<VariantsRuntime> {
    return (this._rt ??= import('./variants-runtime').then((m) => m.createVariantsRuntime({
      viewer: () => this._viewer,
      documentLoadId: () => `variants-doc-${this._load}`,
      enablePreference: () => { rememberVariantMode(this._docKey, true, this.documentHasVariants); this._publishContext(); },
    })));
  }

  dispose(): void {
    void this._rt?.then((rt) => rt.dispose());
    this._viewer = null;
  }
}
