// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drag-chip — the collapsed drag image of a dashboard card.
 *
 * The browser's default drag image is a ghost of the whole card (or, for a
 * glyph tile, a washed-out rectangle). What travels under the cursor should
 * say WHAT is being dragged, not how big its card was: a compact chip with the
 * type icon and the display name — the same shape the hero's CONNECT slot and
 * the tree rows already speak.
 *
 * DOM, not React: `setDragImage` needs a rendered element at call time, inside
 * the native dragstart. The element is parked off-screen (it must be in the
 * document for Chromium to rasterise it) and removed on the next tick — the
 * browser has taken its snapshot by then.
 */

/** Inline 14px icons — hand-drawn strokes, `currentColor`, no icon font. */
const ICONS: Record<DragChipKind, string> = {
  // A 3D box — the document/GLB glyph.
  document:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/>'
    + '<path d="M12 12l8.5-4.75M12 12L3.5 7.25M12 12v9.5"/></svg>',
  // Chevrons + pins — the CONNECT glyph (SettingsEthernet's silhouette).
  connect:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M7 6.5L2.5 12 7 17.5M17 6.5L21.5 12 17 17.5"/>'
    + '<path d="M9 12h.01M12 12h.01M15 12h.01" stroke-width="2.4"/></svg>',
  // An open book — the knowledge glyph.
  knowledge:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 6.5C10.5 5 8.5 4.5 6 4.5c-1.2 0-2.3.15-3.5.5v13.5c1.2-.35 2.3-.5 3.5-.5 '
    + '2.5 0 4.5.5 6 2 1.5-1.5 3.5-2 6-2 1.2 0 2.3.15 3.5.5V5c-1.2-.35-2.3-.5-3.5-.5-2.5 0-4.5.5-6 2z"/>'
    + '<path d="M12 6.5V20"/></svg>',
};

export type DragChipKind = 'document' | 'connect' | 'knowledge';

/** Per-kind accent — the same type colors the cards and hero slots carry:
 *  Instrument Blue for documents, green for CONNECT, magenta for knowledge. */
const ACCENTS: Record<DragChipKind, string> = {
  document: '#4fc3f7',
  connect: '#66bb6a',
  knowledge: '#e94078',
};

/**
 * Replace the native drag image with the collapsed chip for this card.
 * Call synchronously from a `dragstart` handler; no-ops when the environment
 * has no `setDragImage` (jsdom, some mobile browsers).
 */
export function setDragChip(
  dataTransfer: DataTransfer,
  opts: { label: string; kind: DragChipKind },
): void {
  if (typeof dataTransfer.setDragImage !== 'function') return;
  const accent = ACCENTS[opts.kind];
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:-1000px;left:-1000px;display:inline-flex;align-items:center;gap:6px;'
    + 'padding:4px 10px;border-radius:4px;max-width:260px;'
    + 'font:500 12px Inter,Roboto,Arial,sans-serif;'
    + `background:rgba(18,18,18,0.95);border:1px solid ${accent};`
    + 'color:rgba(255,255,255,0.92);pointer-events:none;';
  const icon = document.createElement('span');
  icon.style.cssText = `display:inline-flex;color:${accent};flex-shrink:0;`;
  icon.innerHTML = ICONS[opts.kind];
  const text = document.createElement('span');
  text.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  text.textContent = opts.label;
  el.append(icon, text);
  document.body.appendChild(el);
  dataTransfer.setDragImage(el, 14, 14);
  // The snapshot is taken synchronously inside dragstart; the node itself is
  // free to go on the next tick.
  setTimeout(() => el.remove(), 0);
}
