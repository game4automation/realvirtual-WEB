// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/editor-dialog-store.ts — community stub for the COMMERCIAL asset editor (plan-434).
 *
 * The GLB authoring UI lives in the private sibling. Without it `@rv-private/*`
 * resolves here, so the core still type-checks, builds and runs — the editor is
 * simply absent. Every export is an inert no-op; nothing in this file is reached
 * unless the caller is an editor-only code path, which a community build never
 * enters (no AssetEditorPlugin, no Editor mode).
 */

export type EditorDialogRequest = any;
export type DialogAutoResponder = ((request: any) => any) | null;

export const DIALOG_AUTO_DISMISS: unique symbol = Symbol('rv-dialog-auto-dismiss') as any;

//! No editor dialogs exist, so the MCP dialog policy has nothing to intercept.
export function setDialogAutoResponder(_responder: DialogAutoResponder): DialogAutoResponder { return null; }
export function takeDialogAutoLog(): any[] { return []; }
export function getPendingDialog(): null { return null; }
export function subscribeEditorDialogs(_l: () => void): () => void { return () => undefined; }
