// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Drag-and-drop contract of the Unity-style CONNECT reference (plan-718 §3).
 *
 * Dragging a config card carries the config's PROJECT-RELATIVE path under this
 * type; dropping it on the document hero card assigns `documents[].connectRef`.
 * A custom type rather than `text/plain` so an ordinary text drop — and the
 * tree's own move drag — can never be mistaken for an assignment: the hero
 * accepts a drag only when this exact type is present.
 */
export const CONNECT_CONFIG_DRAG_TYPE = 'application/x-rv-connect-config';

/**
 * The knowledge twin: dragging a `*.knowledge.md` card carries its
 * project-relative path under this type; dropping it on the document hero
 * assigns `documents[].knowledgeRef`.
 */
export const KNOWLEDGE_FILE_DRAG_TYPE = 'application/x-rv-knowledge-file';
