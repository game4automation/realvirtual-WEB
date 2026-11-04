// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-shape-descriptor — PCA-based shape analysis for the MCP observation
 * layer (web_node_shape).
 *
 * plan-675: the implementation moved to `core/editor/rv-shape-analysis.ts` so
 * the editor's UV generator can use it without importing from a plugin. This
 * module stays the MCP layer's entry point and re-exports it unchanged.
 */

export {
  analyzeShapePoints,
  eigenSymmetric3,
  gatherSubtreePoints,
  SHAPE_SAMPLE_CAP,
  type ShapeClass,
  type ShapeDescriptor,
} from '../../core/editor/rv-shape-analysis';
