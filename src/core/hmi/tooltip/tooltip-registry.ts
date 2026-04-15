// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TooltipContentRegistry — Maps content types to React content provider components.
 *
 * Plugins register their tooltip content providers here. When the TooltipLayer
 * needs to render a tooltip, it looks up the appropriate provider by content type.
 *
 * Follows the same register/lookup pattern as UIPluginRegistry.
 */

import type { ComponentType } from 'react';
import type { Object3D } from 'three';
import type { RVViewer } from '../../rv-viewer';
import type { TooltipData } from './tooltip-store';

/**
 * Data resolver function for a tooltip content type.
 * Called by GenericTooltipController when an rv_extras key matches a registered tooltipType.
 * Returns the data object for tooltipStore.show(), or null to skip this section.
 */
export type TooltipDataResolver = (
  node: Object3D,
  viewer: RVViewer,
) => Record<string, unknown> | null;

/**
 * Search resolver function for a component type.
 * Called by the hierarchy browser search to extract searchable text from a node.
 * Each component type decides what fields are searchable (e.g., AAS: values only, not field names).
 * Returns an array of searchable strings, or empty array if nothing to search.
 */
export type SearchResolver = (
  node: Object3D,
) => string[];

/** Props passed to tooltip content provider components. */
export interface TooltipContentProps<T extends TooltipData = TooltipData> {
  /** The typed data from TooltipEntry.data. */
  data: T;
  /** Viewer instance for accessing scene/drives/events. */
  viewer: RVViewer;
  /** True when this content is inside a pinned (selected) tooltip, false for hover. */
  isPinned?: boolean;
}

/** Registration entry for a tooltip content provider. */
export interface TooltipProviderEntry {
  /** Content type to match (e.g. 'drive', 'sensor', 'mu'). */
  contentType: string;
  /** React component that renders the tooltip content. */
  component: ComponentType<TooltipContentProps>;
  /** Lower number = higher priority when multiple providers for same type. Default: 100. */
  priority?: number;
}

/** Entry for a tooltip controller (headless React component). */
export interface TooltipControllerEntry {
  /** Component types this controller handles (e.g. ['Drive'], ['Pipe','Tank','Pump','ProcessingUnit']). */
  types: string[];
  /** Headless React component that bridges hover/selection to tooltip store. */
  component: ComponentType;
}

/**
 * TooltipContentRegistry — Singleton registry for tooltip content providers
 * and tooltip controllers.
 *
 * Content providers self-register at module load time:
 * ```ts
 * tooltipRegistry.register({ contentType: 'drive', component: DriveTooltipContent });
 * ```
 *
 * Controllers self-register to be rendered dynamically by App.tsx:
 * ```ts
 * tooltipRegistry.registerController({ types: ['Drive'], component: DriveTooltipController });
 * ```
 */
export class TooltipContentRegistry {
  private providers = new Map<string, TooltipProviderEntry[]>();
  private controllers: TooltipControllerEntry[] = [];
  private dataResolvers = new Map<string, TooltipDataResolver>();
  private searchResolvers = new Map<string, SearchResolver>();

  /** Register a content provider for a content type. */
  register(entry: TooltipProviderEntry): void {
    const existing = this.providers.get(entry.contentType) ?? [];
    existing.push(entry);
    // Sort by priority (lower = higher priority)
    existing.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.providers.set(entry.contentType, existing);
  }

  /** Get the highest-priority content provider for a content type, or null. */
  getProvider(contentType: string): ComponentType<TooltipContentProps> | null {
    const entries = this.providers.get(contentType);
    if (!entries || entries.length === 0) return null;
    return entries[0].component;
  }

  /** Register a tooltip controller (headless React component). */
  registerController(entry: TooltipControllerEntry): void {
    // Avoid duplicate registration (same component reference)
    if (!this.controllers.some(c => c.component === entry.component)) {
      this.controllers.push(entry);
    }
  }

  /** Get all registered tooltip controllers. */
  getControllers(): readonly TooltipControllerEntry[] {
    return this.controllers;
  }

  /** Register a data resolver for a tooltip content type. */
  registerDataResolver(contentType: string, resolver: TooltipDataResolver): void {
    this.dataResolvers.set(contentType, resolver);
  }

  /** Get the data resolver for a tooltip content type, or null. */
  getDataResolver(contentType: string): TooltipDataResolver | null {
    return this.dataResolvers.get(contentType) ?? null;
  }

  /** Register a search resolver for a component type (rv_extras key). */
  registerSearchResolver(componentType: string, resolver: SearchResolver): void {
    this.searchResolvers.set(componentType, resolver);
  }

  /**
   * Get all searchable text for a node by running all matching search resolvers.
   * Checks the node's rv_extras keys against registered resolvers.
   */
  getSearchableText(node: Object3D): string[] {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return [];
    const result: string[] = [];
    for (const key of Object.keys(rv)) {
      const resolver = this.searchResolvers.get(key);
      if (resolver) {
        result.push(...resolver(node));
      }
    }
    return result;
  }

  /**
   * Find which component type's search resolver matched a search term on this node.
   * Returns the rv_extras key (e.g. 'AASLink', 'RuntimeMetadata') or null if only name matched.
   */
  findMatchingComponent(node: Object3D, term: string): string | null {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return null;
    const lower = term.toLowerCase();
    for (const key of Object.keys(rv)) {
      const resolver = this.searchResolvers.get(key);
      if (resolver) {
        const texts = resolver(node);
        if (texts.some(t => t.toLowerCase().includes(lower))) return key;
      }
    }
    return null;
  }
}

/** Singleton tooltip content registry instance. */
export const tooltipRegistry = new TooltipContentRegistry();
