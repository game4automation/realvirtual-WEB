// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-manager.ts — viewer-owned per-frame registry for the 3D
 * scene-button family (plan-417), built on the LampManager pattern documented
 * in doc-extending-webviewer.md § "Per-frame components".
 *
 * Two jobs, one tick:
 *  - `SceneButtonMoveable` caps approach their press / turn offset target,
 *  - `SceneButtonBase` momentary clicks count down their release timer.
 *
 * Members register on `init()` and unregister in `dispose()`. Only members that
 * currently have work to do sit in the ACTIVE set, so an idle button costs
 * nothing per frame. `clear()` disposes every member BEFORE the viewer's
 * material/geometry teardown, so the cap materials are restored while their
 * originals still exist.
 */

const DEV_WARNING_THRESHOLD = 200;

/** One tickable/disposable member of the scene-button family. */
export interface SceneButtonMember {
  /** Advance by `dt` seconds; true when something visible changed. */
  updateButton?(dt: number): boolean;
  dispose?(): void;
}

export class SceneButtonManager {
  private readonly _members = new Set<SceneButtonMember>();
  private readonly _active = new Set<SceneButtonMember>();
  private _warnedAboutCount = false;

  /** Number of registered members (buttons, caps and wrappers). */
  get size(): number {
    return this._members.size;
  }

  /** Number of members currently animating or counting down. */
  get activeSize(): number {
    return this._active.size;
  }

  register(member: SceneButtonMember): void {
    this._members.add(member);
    if (
      import.meta.env.DEV
      && !this._warnedAboutCount
      && this._members.size > DEV_WARNING_THRESHOLD
    ) {
      this._warnedAboutCount = true;
      console.warn(
        `[SceneButtonManager] ${this._members.size} scene-button members are registered; `
        + 'consider limiting interactive buttons for best performance',
      );
    }
  }

  unregister(member: SceneButtonMember): void {
    this._members.delete(member);
    this._active.delete(member);
  }

  /** Put a member into (or take it out of) the per-frame tick set. */
  setActive(member: SceneButtonMember, active: boolean): void {
    if (active) {
      this._members.add(member);
      this._active.add(member);
      return;
    }
    this._active.delete(member);
  }

  /** Advances every active member and reports whether anything visible changed. */
  update(dt: number): boolean {
    let changed = false;
    for (const member of this._active) {
      if (member.updateButton?.(dt)) changed = true;
    }
    return changed;
  }

  /** Disposes all registered members before their model materials are destroyed. */
  clear(): void {
    while (this._members.size > 0) {
      const member = this._members.values().next().value as SceneButtonMember | undefined;
      if (!member) break;
      // dispose() unregisters itself; the explicit delete guards a member whose
      // dispose() does not (or throws before it gets there).
      member.dispose?.();
      this._members.delete(member);
    }
    this._active.clear();
    this._warnedAboutCount = false;
  }
}
