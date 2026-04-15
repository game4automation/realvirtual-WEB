// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-renderer-registry.ts — Plugin registry for custom field renderers
 * in the Property Inspector.
 *
 * Component types can register custom renderers for specific fields.
 * When the inspector encounters a matching (componentType, fieldName) pair,
 * it renders the custom component instead of the default FieldRow.
 *
 * Follows the same self-registration pattern as TooltipContentRegistry.
 *
 * Usage:
 * ```ts
 * fieldRendererRegistry.register({
 *   componentType: 'RuntimeMetadata',
 *   fieldName: 'content',
 *   component: MetadataContentRenderer,
 * });
 * ```
 */

import type { ComponentType } from 'react';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';

/** Props passed to custom field renderer components. */
export interface FieldRendererProps {
  /** The field value from rv_extras. */
  value: unknown;
  /** The field name. */
  fieldName: string;
  /** The component type (e.g. 'RuntimeMetadata'). */
  componentType: string;
  /** Full node path in the scene hierarchy. */
  nodePath: string;
  /** Viewer instance for accessing scene/signals. */
  viewer: RVViewer | null;
  /** Signal store for live signal values. */
  signalStore: SignalStore | null;
}

/** Registration entry for a custom field renderer. */
export interface FieldRendererEntry {
  /** Component type to match (e.g. 'RuntimeMetadata'). */
  componentType: string;
  /** Field name to match (e.g. 'content'). */
  fieldName: string;
  /** React component that renders the field. */
  component: ComponentType<FieldRendererProps>;
}

/**
 * FieldRendererRegistry — Singleton registry for custom field renderers.
 *
 * Renderers self-register at module load time:
 * ```ts
 * fieldRendererRegistry.register({
 *   componentType: 'RuntimeMetadata',
 *   fieldName: 'content',
 *   component: MetadataContentRenderer,
 * });
 * ```
 */
class FieldRendererRegistry {
  private renderers = new Map<string, ComponentType<FieldRendererProps>>();

  private key(componentType: string, fieldName: string): string {
    return `${componentType}::${fieldName}`;
  }

  /** Register a custom renderer for a component type + field name pair. */
  register(entry: FieldRendererEntry): void {
    this.renderers.set(this.key(entry.componentType, entry.fieldName), entry.component);
  }

  /** Get a custom renderer, or null if none registered. */
  getRenderer(componentType: string, fieldName: string): ComponentType<FieldRendererProps> | null {
    return this.renderers.get(this.key(componentType, fieldName)) ?? null;
  }
}

/** Singleton field renderer registry instance. */
export const fieldRendererRegistry = new FieldRendererRegistry();
