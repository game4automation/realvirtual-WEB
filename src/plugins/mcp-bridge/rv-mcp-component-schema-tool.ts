// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-component-schema-tool — `web_component_schema(type?)` (plan-517).
 *
 * Lets an agent without repository access learn what it may author: without an
 * argument the list of component types (authorable ones plus the special types
 * created by other tools), with `type` every field and the usage rules.
 *
 * Fields come from rv-odt.json (bundled anyway); rules come from the annotation
 * blocks in `schema/v1/specification.md`, which is ~180 kB and therefore loaded
 * through a dynamic `import()` on the first DETAIL call only — a list call never
 * touches it. No viewer dependency (the `McpHelpTool` pattern).
 */

import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import {
  describeComponentType,
  listComponentTypes,
} from '../../core/engine/rv-component-schema-info';

/** Loads the specification text (lazy chunk). Injectable for tests. */
export type SpecTextLoader = () => Promise<string>;

/** Production loader: Vite emits the spec as its own dynamic chunk. */
export const loadSpecificationText: SpecTextLoader = () =>
  import('../../../schema/v1/specification.md?raw').then((m) => m.default);

export class McpComponentSchemaTool {
  private _spec: Promise<string> | null = null;
  private readonly loadSpec: SpecTextLoader;

  constructor(loadSpec: SpecTextLoader = loadSpecificationText) {
    this.loadSpec = loadSpec;
  }

  private specText(): Promise<string> {
    if (!this._spec) {
      this._spec = this.loadSpec().catch((err: unknown) => {
        this._spec = null; // a failed chunk load may succeed on the next call
        throw err;
      });
    }
    return this._spec;
  }

  @McpTool('List authorable component types, or with type get its fields (type, default, unit, enum, refType) and authoring rules. Read before web_editor_add_component.', { readOnly: true })
  async webComponentSchema(
    @McpParam('type', 'Component type, e.g. Drive_Cylinder (omit to list all types).', 'string', false) type: string,
  ): Promise<string> {
    const key = (type ?? '').trim();
    if (!key) return JSON.stringify({ types: listComponentTypes() });
    let spec: string | null = null;
    try {
      spec = await this.specText();
    } catch {
      spec = null; // fields still answer; rules need the spec chunk
    }
    const info = describeComponentType(key, spec);
    if (!info) {
      return JSON.stringify({
        error: `Unknown component type "${key}"`,
        availableTypes: listComponentTypes().map((t) => t.type),
      });
    }
    return JSON.stringify(spec === null ? { ...info, warning: 'rules unavailable: specification could not be loaded' } : info);
  }
}
