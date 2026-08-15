// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/select-actions.ts — community stub for the COMMERCIAL asset editor (plan-434).
 *
 * The GLB authoring UI lives in the private sibling. Without it `@rv-private/*`
 * resolves here, so the core still type-checks, builds and runs — the editor is
 * simply absent. Every export is an inert no-op; nothing in this file is reached
 * unless the caller is an editor-only code path, which a community build never
 * enters (no AssetEditorPlugin, no Editor mode).
 */


export type computeIdenticalPaths = any;
export const computeIdenticalPaths: any = () => undefined;
export type computeInvertPaths = any;
export const computeInvertPaths: any = () => undefined;
export type computeSameMaterialPaths = any;
export const computeSameMaterialPaths: any = () => undefined;
export type expandToUniverseMeshes = any;
export const expandToUniverseMeshes: any = () => undefined;
export type geometrySignature = any;
export const geometrySignature: any = () => undefined;
export type signaturesMatch = any;
export const signaturesMatch: any = () => undefined;
