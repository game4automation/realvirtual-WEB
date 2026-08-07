// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * help-topics — the single place where documentation slugs live (plan-370).
 *
 * A "topic" is a page of the product documentation under the configured docs
 * base URL, optionally plus an anchor. Every core mapping (panel id → topic,
 * workspace mode → topic) is an exported table so the tests can walk it
 * data-driven instead of restating it.
 *
 * Slugs are checked OFFLINE against {@link KNOWN_DOC_SLUGS}, a snapshot of the
 * published sitemap. That catches a typo or a removed page; it deliberately
 * does NOT catch semantic drift (page still exists but no longer fits) — a
 * network-free test run was the explicit decision.
 *
 * NOT to be confused with `DOC_BASE_URL` in tooltip/MetadataTooltipContent.tsx:
 * that constant resolves relative links out of Unity `RuntimeMetadata`
 * (customer content on doc.realvirtual.io) and is a different domain entirely.
 */

/**
 * Snapshot of the documentation pages, 2026-08-02, taken from the built
 * documentation source (`Documentation/web`), not from the live site.
 * `''` is the documentation root (the fallback target).
 *
 * The distinction matters: the site was restructured on this date — `planning/`
 * was split into `planner/` and `des/`, and AI diagnosis moved under `hmi/`.
 * The published site still served the old paths at the time of writing, so this
 * list is correct for the documentation that ships next, not for what is live
 * at this second. Code and documentation are delivered together, which is why
 * the upcoming structure is the right one to encode here.
 *
 * Re-pull this list when the documentation site is restructured again — an
 * outdated snapshot never misbehaves at runtime, it only lets a stale mapping
 * slip past the test.
 */
export const KNOWN_DOC_SLUGS = [
  '',
  'connect/development/ai-clients',
  'connect/development/rest-and-websocket-api',
  'connect/getting-started/first-connection',
  'connect/getting-started/installation',
  'connect/getting-started/licensing',
  'connect/getting-started/viewer-delivery',
  'connect/interfaces/configuration',
  'connect/interfaces/protocols',
  'connect/operations/configuration-file',
  'connect/operations/remote-access',
  'connect/operations/troubleshooting',
  'connect/operations/updates',
  'connect/overview',
  'connect/services/ai-diagnosis',
  'connect/services/cad-conversion',
  'connect/services/data-recording',
  'des/overview',
  'development/overview',
  'editor/overview',
  'getting-started/navigation',
  'getting-started/opening-a-twin',
  'hmi/ai-diagnosis',
  'hmi/overview',
  'hmi/signals-and-alarms',
  'hosting/deployment-options',
  'hosting/licensing',
  'odt',
  'planner/overview',
  'viewer/interface',
  'viewer/scenes-and-models',
] as const;

export type KnownDocSlug = typeof KNOWN_DOC_SLUGS[number];

/** A documentation target: one page, optionally one anchor inside it. */
export interface HelpTopic {
  /** Path below the docs base, without a leading and without a trailing slash. */
  readonly slug: string;
  /** Optional anchor, without the leading '#'. */
  readonly anchor?: string;
}

/** Target when no context can be derived (decision F4: the documentation root). */
export const HELP_FALLBACK: HelpTopic = { slug: '' };

/**
 * Panel id → topic. The 11 ids that really reach
 * `leftPanelManager.open()/toggle()` today. Ids can also appear dynamically at
 * runtime; an unmapped id is not an error — the derivation falls through to the
 * workspace mode and then to {@link HELP_FALLBACK}.
 *
 * (`'other'` is a reserved placeholder that appears only in a comment in the
 * layout planner, never as a call — it is intentionally NOT listed here.)
 */
export const PANEL_TOPICS: Readonly<Record<string, HelpTopic>> = {
  'annotations': { slug: 'hmi/signals-and-alarms' },
  'connect': { slug: 'connect/overview' },
  'hierarchy': { slug: 'viewer/interface', anchor: 'hierarchy' },
  'kinematics': { slug: 'viewer/scenes-and-models' },
  'layout-planner': { slug: 'planner/overview' },
  'machine-control': { slug: 'hmi/signals-and-alarms' },
  'materials': { slug: 'viewer/scenes-and-models' },
  'measurements': { slug: 'viewer/interface', anchor: 'the-tool-strip' },
  'order-manager': { slug: 'hmi/signals-and-alarms' },
  'scene': { slug: 'getting-started/opening-a-twin' },
  'settings': { slug: 'viewer/interface', anchor: 'settings' },
};

/**
 * Workspace mode → topic. The four modes registered in `main.ts`.
 *
 * `editor` points at its own page since the 2026-08-02 restructure; before that
 * there was none and it borrowed the scenes-and-models page.
 */
export const MODE_TOPICS: Readonly<Record<string, HelpTopic>> = {
  'des': { slug: 'des/overview' },
  'editor': { slug: 'editor/overview' },
  'hmi': { slug: 'hmi/signals-and-alarms' },
  'planner': { slug: 'planner/overview' },
};

/**
 * Human-readable page names — used for the tooltip and the accessible name
 * ("Open help for Layout Planner (new tab)"). English throughout, matching the
 * rest of the activity bar (Models, Hierarchy, Settings, AI Bridge).
 */
export const DOC_SLUG_LABELS: Readonly<Record<string, string>> = {
  '': 'realvirtual WEB',
  'connect/development/ai-clients': 'AI Clients',
  'connect/development/rest-and-websocket-api': 'REST and WebSocket API',
  'connect/getting-started/first-connection': 'First Connection',
  'connect/getting-started/installation': 'CONNECT Installation',
  'connect/getting-started/licensing': 'CONNECT Licensing',
  'connect/getting-started/viewer-delivery': 'Viewer Delivery',
  'connect/interfaces/configuration': 'Interfaces and Signals',
  'connect/interfaces/protocols': 'Protocols',
  'connect/operations/configuration-file': 'CONNECT Configuration',
  'connect/operations/remote-access': 'Remote Access',
  'connect/operations/troubleshooting': 'Troubleshooting',
  'connect/operations/updates': 'CONNECT Updates',
  'connect/overview': 'CONNECT',
  'connect/services/ai-diagnosis': 'CONNECT AI Diagnosis',
  'connect/services/cad-conversion': 'CAD Conversion',
  'connect/services/data-recording': 'Data Recording',
  'des/overview': 'DES',
  'development/overview': 'Development',
  'editor/overview': 'Editor',
  'getting-started/navigation': 'Navigation',
  'getting-started/opening-a-twin': 'Opening a Twin',
  'hmi/ai-diagnosis': 'AI Diagnosis',
  'hmi/overview': 'Machine Information System',
  'hmi/signals-and-alarms': 'Signals and Alarms',
  'hosting/deployment-options': 'Deployment Options',
  'hosting/licensing': 'Licensing',
  'odt': 'ODT',
  'planner/overview': 'Layout Planner',
  'viewer/interface': 'The Interface',
  'viewer/scenes-and-models': 'Scenes and Models',
};

/**
 * Label for a topic. Falls back to the raw slug for plugin-contributed topics
 * that point into a documentation set we know nothing about.
 */
export function helpTopicLabel(topic: HelpTopic): string {
  return DOC_SLUG_LABELS[topic.slug] ?? (topic.slug || DOC_SLUG_LABELS['']);
}
