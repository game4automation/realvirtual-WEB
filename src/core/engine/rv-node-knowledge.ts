// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-knowledge — one overwritable Markdown note per scene node, stored as
 * the `NodeKnowledge` rv_extras entry (plan-394).
 *
 * ## What this is for
 *
 * An agent that kinematizes, analyses or debugs a machine works out things the
 * CAD never said: which axis carries which role, where the real limits are,
 * which node is not the thing its name claims. That knowledge used to die with
 * the session. Here it hangs on the node and travels inside the GLB — the same
 * "GLB is the single source of truth" rule every other component obeys.
 *
 * The note is written and read exclusively through the `web_knowledge_*` MCP
 * tools (`src/plugins/mcp-bridge/rv-mcp-knowledge-tools.ts`) and is fed into the
 * "Ask AI" prompt by `search-ai-context.ts`. There is no HMI panel for it.
 *
 * ## Deliberately registered WITHOUT a create-factory
 *
 * `registerComponentSchema` registers the schema and the capabilities but no
 * `create` — `AASLink` and `Group` are the precedents. Three consequences, all
 * intended:
 *
 *  1. **No live instance exists.** `constructComponentOnNode` returns `null` for
 *     a type with no factory (`rv-scene-loader.ts`), so nothing is added to the
 *     NodeRegistry and the note contributes nothing to the 60 Hz tick.
 *  2. **The note never shows up in `web_component_get` / `_get_all`**, because
 *     those serialize registry instances. Reads therefore go through raw
 *     `userData.realvirtual` — that is what {@link readNodeKnowledge} is for.
 *  3. **`applySchema` never runs at load time.** The schema still earns its keep
 *     (field descriptors for the inspector, `getSchemaDefaults` for the asset
 *     editor's "Add Component", consumed-field derivation for the extras
 *     validator) but it does NOT default the loaded values. The read path
 *     defaults for itself; see {@link readNodeKnowledge}.
 *
 * ## Why a new type instead of `RuntimeMetadata`
 *
 * `RuntimeMetadata` is Unity-mirrored (`loadSchemaFromSpec('RuntimeMetadata')`)
 * and `hoverable: true, tooltipType: 'metadata'` — an agent note in its
 * `content` would have become a visible hover tooltip and would have collided
 * with real authored metadata on the same node.
 *
 * ## Known limitation: this type is WEB-only
 *
 * Unity has no `WebKnowledge` component, by decision. A Unity re-export of the
 * model therefore drops the notes, and a Unity re-import logs one console error
 * per annotated node (`GLBComponentDeserializer` cannot resolve the type). Both
 * are documented in `doc-ai-integration.md`.
 */

import type { Object3D } from 'three';
import {
  registerComponentSchema,
  type ComponentSchema,
} from './rv-component-registry';

/** rv_extras key of the entry. Never spelled out at a call site — a typo would
 *  land in the GLB permanently and wordlessly (there is no schema gate). */
export const NODE_KNOWLEDGE_TYPE = 'NodeKnowledge';

/** Field holding the note body. */
export const NODE_KNOWLEDGE_FIELD = 'Note';

/**
 * Maximum note size, counted in **UTF-16 code units** (`String.length`) — the
 * documented convention (plan-394 F6). It is deliberately NOT a byte count and
 * NOT a visible-character count: an emoji outside the BMP costs 2, and a
 * combining sequence costs one per code unit. The glTF spec sets no size limit
 * on `extras`; 4000 is a project decision that keeps the JSON chunk sane.
 */
export const MAX_NOTE_CHARS = 4000;

/**
 * Every field the entry can carry, in write order.
 *
 * The delete path (F7) needs this list: the SceneStore has no `removeComponent`
 * op, and `deleteUserDataField` only drops the type hull once the LAST field is
 * gone — so clearing a note means unsetting each of these in one transaction.
 */
export const NODE_KNOWLEDGE_FIELDS = [
  'Note', 'UpdatedAt', 'Author', 'Confidence', 'NodeIdAtWrite',
] as const;

/** Who wrote the note. Provenance, not access control. */
export type NodeKnowledgeAuthor = 'agent' | 'user';

/** How the knowledge was obtained — makes guessing visible instead of implicit. */
export type NodeKnowledgeConfidence = 'observed' | 'inferred' | 'unverified';

/** rv_extras payload of the NodeKnowledge entry. */
export interface NodeKnowledgeExtras {
  /** The note itself — Markdown body, no frontmatter. Max {@link MAX_NOTE_CHARS}. */
  Note: string;
  /** ISO-8601 timestamp, rewritten by the tool on every set. */
  UpdatedAt: string;
  /** Who wrote it. Default `'agent'`. */
  Author: NodeKnowledgeAuthor;
  /** Default `'observed'`: a hallucinated guess becomes a fact by being written down. */
  Confidence: NodeKnowledgeConfidence;
  /**
   * The node's NodeId at write time (`rv-node-id.ts`). A weak self-check, and
   * knowingly so.
   *
   * KNOWN LIMITATION: a NodeId is unique within a FILE, not globally — ten
   * references to the same asset all carry the same NodeId. The complete address
   * would be `occurrence#nodeId`, but `rv-node-id.ts` states the occurrence
   * chain "is computed while composing and is never written into a file".
   * Storing it would break that rule, so the check stays weak on purpose: it
   * catches a re-import that renumbered nodes, and it CANNOT tell two
   * placements of the same asset apart.
   */
  NodeIdAtWrite: string;
}

/** Defaults applied by the read path — see the module note on `applySchema`. */
const DEFAULTS: Readonly<NodeKnowledgeExtras> = Object.freeze({
  Note: '',
  UpdatedAt: '',
  Author: 'agent',
  Confidence: 'observed',
  NodeIdAtWrite: '',
});

const AUTHORS: readonly NodeKnowledgeAuthor[] = ['agent', 'user'];
const CONFIDENCES: readonly NodeKnowledgeConfidence[] = ['observed', 'inferred', 'unverified'];

/** Narrow an untrusted `Author` value, falling back to the default. */
export function asAuthor(value: unknown): NodeKnowledgeAuthor {
  return AUTHORS.includes(value as NodeKnowledgeAuthor)
    ? value as NodeKnowledgeAuthor
    : DEFAULTS.Author;
}

/** Narrow an untrusted `Confidence` value, falling back to the default. */
export function asConfidence(value: unknown): NodeKnowledgeConfidence {
  return CONFIDENCES.includes(value as NodeKnowledgeConfidence)
    ? value as NodeKnowledgeConfidence
    : DEFAULTS.Confidence;
}

/**
 * Inline schema, not `loadSchemaFromSpec` — the shared rv-ODT specification
 * (`schema/v1/rv-odt.json`) describes types that exist on BOTH sides, and this
 * one is WEB-only. `doc-extending-webviewer.md` allows inline schemas for
 * exactly that case.
 */
export const NODE_KNOWLEDGE_SCHEMA: ComponentSchema = {
  Note: { type: 'string', default: DEFAULTS.Note },
  UpdatedAt: { type: 'string', default: DEFAULTS.UpdatedAt },
  Author: {
    type: 'enum',
    enumMap: { agent: 'agent', user: 'user' },
    default: DEFAULTS.Author,
  },
  Confidence: {
    type: 'enum',
    enumMap: { observed: 'observed', inferred: 'inferred', unverified: 'unverified' },
    default: DEFAULTS.Confidence,
  },
  NodeIdAtWrite: { type: 'string', default: DEFAULTS.NodeIdAtWrite },
};

/** Slate badge — metadata, deliberately quieter than a functional component. */
const NODE_KNOWLEDGE_BADGE_COLOR = '#8d6e63';

// Schema + capabilities, NO create-factory. See the module note.
registerComponentSchema(NODE_KNOWLEDGE_TYPE, NODE_KNOWLEDGE_SCHEMA, {
  authorable: true,
  hoverable: false,      // unlike RuntimeMetadata: no tooltip, no HMI surface
  selectable: false,
  tooltipType: null,
  inspectorVisible: true,
  hierarchyVisible: true,
  badgeColor: NODE_KNOWLEDGE_BADGE_COLOR,
  filterLabel: null,
});

/**
 * Read the note off a node's raw `userData.realvirtual`, applying defaults.
 *
 * Raw rather than via the NodeRegistry, and that is the point: there is no live
 * instance to read (no factory), and a note just written in this session exists
 * in `userData` long before any reload. A registry-based read would report "no
 * note" immediately after a successful write.
 *
 * Returns `null` when the node carries no entry at all — the caller needs that
 * distinct from "an entry with an empty note".
 */
export function readNodeKnowledge(
  node: Object3D | null | undefined,
): NodeKnowledgeExtras | null {
  const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
  const raw = rv?.[NODE_KNOWLEDGE_TYPE];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  return {
    Note: typeof fields.Note === 'string' ? fields.Note : DEFAULTS.Note,
    UpdatedAt: typeof fields.UpdatedAt === 'string' ? fields.UpdatedAt : DEFAULTS.UpdatedAt,
    Author: asAuthor(fields.Author),
    Confidence: asConfidence(fields.Confidence),
    NodeIdAtWrite: typeof fields.NodeIdAtWrite === 'string'
      ? fields.NodeIdAtWrite
      : DEFAULTS.NodeIdAtWrite,
  };
}

/** True for a note that carries no content — whitespace only counts as empty (F7). */
export function isEmptyNote(markdown: unknown): boolean {
  return String(markdown ?? '').trim().length === 0;
}
