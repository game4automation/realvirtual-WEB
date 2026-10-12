// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `web_editor_open(source=library, relPath)` resolves onto a document ROW of
 * the open project — the same identity the dashboard opens — instead of
 * guessing `library/<relPath>`.
 *
 * Regression (2026-09-22): `sidecutter.glb` at the project root was addressed
 * as `library/sidecutter.glb`, the editor's load failed silently and the tool
 * polled until its 120 s timeout while the UI opened the file instantly.
 */

import { describe, it, expect } from 'vitest';
import { resolveEditorOpenDocument, normalisePath } from '../src/plugins/mcp-bridge/rv-mcp-editor-open-resolve';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

const rows: RvDocumentEntry[] = [
  { id: 'doc_untitled_gnqvqp', path: 'sidecutter.glb', name: 'sidecutter' },
  { id: 'doc_line_1', path: 'SidecutterLine.glb', name: 'SidecutterLine' },
  { id: 'doc_gripper_lib', path: 'library/Custom/Gripper.glb', name: 'Gripper' },
  { id: 'doc_gripper_root', path: 'Gripper.glb', name: 'Gripper root' },
  { id: 'doc_model_a', path: 'models/Machine A.glb', name: 'Machine A' },
];

describe('web_editor_open — relPath resolves onto a project document row', () => {
  it('a root-level document is found by its bare file name (the regression)', () => {
    expect(resolveEditorOpenDocument('sidecutter.glb', rows)?.id).toBe('doc_untitled_gnqvqp');
  });

  it('the documented library-relative form still wins over a root twin', () => {
    // `Custom/Gripper.glb` has meant library/Custom/Gripper.glb since the tool exists.
    expect(resolveEditorOpenDocument('Custom/Gripper.glb', rows)?.id).toBe('doc_gripper_lib');
    // A full library path spelled out is the same row.
    expect(resolveEditorOpenDocument('library/Custom/Gripper.glb', rows)?.id).toBe('doc_gripper_lib');
    // The root file is reachable by its own project path.
    expect(resolveEditorOpenDocument('Gripper.glb', rows)?.id).toBe('doc_gripper_root');
  });

  it('accepts the project: address form web_layout_place already takes', () => {
    expect(resolveEditorOpenDocument('project:sidecutter.glb', rows)?.id).toBe('doc_untitled_gnqvqp');
    expect(resolveEditorOpenDocument('project:models/Machine A.glb', rows)?.id).toBe('doc_model_a');
    // `project:` is explicit — it never gets the library/ prefix guessed onto it.
    expect(resolveEditorOpenDocument('project:Custom/Gripper.glb', rows)).toBeNull();
  });

  it('accepts a document id and a name as web_document_list prints them', () => {
    expect(resolveEditorOpenDocument('doc_line_1', rows)?.path).toBe('SidecutterLine.glb');
    expect(resolveEditorOpenDocument('SidecutterLine', rows)?.id).toBe('doc_line_1');
    expect(resolveEditorOpenDocument('sidecutter line', rows)?.id).toBe('doc_line_1');
    expect(resolveEditorOpenDocument('machine-a', rows)?.id).toBe('doc_model_a');
  });

  it('paths compare case- and separator-insensitively', () => {
    expect(resolveEditorOpenDocument('/SIDECUTTER.GLB', rows)?.id).toBe('doc_untitled_gnqvqp');
    expect(resolveEditorOpenDocument('Custom\\Gripper.glb', rows)?.id).toBe('doc_gripper_lib');
    expect(normalisePath('\\Library/Custom\\A.glb')).toBe('library/custom/a.glb');
  });

  it('answers null for a miss, an empty input and an empty listing', () => {
    expect(resolveEditorOpenDocument('nothere.glb', rows)).toBeNull();
    // A slash means "path" — a name match is not attempted for it.
    expect(resolveEditorOpenDocument('models/sidecutter', rows)).toBeNull();
    expect(resolveEditorOpenDocument('', rows)).toBeNull();
    expect(resolveEditorOpenDocument('sidecutter.glb', [])).toBeNull();
  });
});
