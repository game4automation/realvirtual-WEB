// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetCard — the one library card (plan-372 Phase 6).
 *
 * Generalised out of the planner's `ThumbnailCard`. The Projects dashboard and
 * the planner panel show the same assets and must look like the same product;
 * two card implementations would drift within a release.
 *
 * ## Presentational only — on purpose
 *
 * Everything behavioural stays with the caller: drag payload, hover-intent
 * prefetch, the context menu, and the picture it shows. The card takes
 * DOM handlers as props and spreads them onto its root. That is what let the
 * planner's drag behaviour move here *unchanged* rather than be reimplemented
 * — the handlers are the same functions, just passed in.
 *
 * ## Variants
 *
 * `compact` reproduces the planner's narrow left panel pixel for pixel (72px
 * columns, 9px label). `comfortable` is the dashboard's wider grid. Both share
 * this component so a change to the visual language lands in both at once.
 */

import { forwardRef, useState, type ReactNode } from 'react';
import { Box, CircularProgress, IconButton, Typography, Tooltip } from '@mui/material';
import {
  TimerOutlined, Landscape, MenuBookOutlined, PrecisionManufacturingOutlined,
  SettingsEthernet, PictureAsPdfOutlined, SlideshowOutlined, MovieOutlined,
  ImageOutlined, TableChartOutlined, DescriptionOutlined, InsertDriveFileOutlined,
  ArchiveOutlined, CategoryOutlined, ZoomIn, ViewInArOutlined,
} from '@mui/icons-material';
import type { LibraryCatalogEntry } from './library-types';
import { LABEL_CHIP_SX, LABEL_CHIP_ON_PREVIEW_SX } from '../hmi/shared-sx';

/** Matches `CatalogBrowserVariant`; kept structural to avoid a circular import. */
export type AssetCardVariant = 'compact' | 'comfortable';

/** The stated tiles — see {@link AssetCardProps.glyph}. */
export type AssetCardGlyph = 'connect' | 'knowledge' | `file:${string}`;

/** The `file:<ext>` glyph of a path, from its extension — `file:` when it has none. */
export function fileGlyphOf(path: string): AssetCardGlyph {
  const leaf = String(path ?? '').split('/').pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  return `file:${dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ''}`;
}

/**
 * The CAD exchange and native formats the dashboard tells apart from other
 * files: they are geometry, the raw material an asset is made from, so their
 * tile gets its own colour and the primitive-shapes glyph rather than the
 * document look (user decision 2026-09-10). Lower-case, dot-less.
 */
const CAD_EXTENSIONS = new Set([
  'step', 'stp', 'iges', 'igs', 'jt', 'stl', 'obj', 'fbx', '3ds', 'dae',
  'dxf', 'dwg', 'sat', 'x_t', 'x_b', 'ipt', 'iam', 'sldprt', 'sldasm',
  'prt', 'asm', 'catpart', 'catproduct', '3dxml', 'vrml', 'wrl', 'ply',
]);

/** Is this extension one of the CAD formats? */
export function isCadExtension(ext: string): boolean {
  return CAD_EXTENSIONS.has(ext.toLowerCase());
}

/** The icon a `file:<ext>` tile shows above its label — by family, generic otherwise. */
function fileGlyphIcon(ext: string, sx: object): ReactNode {
  if (isCadExtension(ext)) return <CategoryOutlined sx={sx} />;
  switch (ext) {
    case 'pdf': return <PictureAsPdfOutlined sx={sx} />;
    case 'ppt': case 'pptx': case 'key': case 'odp': return <SlideshowOutlined sx={sx} />;
    case 'mp4': case 'webm': case 'mov': case 'avi': case 'mkv': return <MovieOutlined sx={sx} />;
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'bmp':
      return <ImageOutlined sx={sx} />;
    case 'xls': case 'xlsx': case 'csv': case 'ods': return <TableChartOutlined sx={sx} />;
    case 'doc': case 'docx': case 'odt': case 'rtf': case 'txt': return <DescriptionOutlined sx={sx} />;
    case 'zip': case '7z': case 'rar': case 'gz': case 'tar': return <ArchiveOutlined sx={sx} />;
    default: return <InsertDriveFileOutlined sx={sx} />;
  }
}

/**
 * Which layer of the two-level model an entry came from (§2.3).
 *
 * `bundled` entries ship with a delivered build and cannot be edited in place;
 * the badge is what tells a user why an action is unavailable before they try
 * it. `user` entries are the normal, writable case and carry no badge.
 */
export type AssetTier = 'bundled' | 'user';

export interface AssetCardProps {
  entry: LibraryCatalogEntry;
  variant?: AssetCardVariant;
  /** Shows a small badge when `'bundled'`. Omit or `'user'` for no badge. */
  tier?: AssetTier;
  /**
   * A caller-owned label for the preview's top-left corner (the dashboard puts
   * the document's open mode there). The Bundled chip sits on the opposite
   * edge, bottom-left, in the same chip look (`LABEL_CHIP_SX`) — the two never
   * paint over each other.
   */
  cornerBadge?: ReactNode;
  /** Highlights the card as the active placement target. */
  selected?: boolean;
  /** Cursor hint only — the caller owns the actual drag payload. */
  draggable?: boolean;
  /**
   * Explicit cursor override. The planner needs `crosshair` while a placement
   * is armed, which is a planner concept this component should not know about.
   */
  cursor?: string;
  /** Rendered inside the preview square when the entry has no thumbnail. */
  placeholderAction?: ReactNode;
  /**
   * The asset decoded but holds nothing renderable (a freshly created "New
   * asset"). Renders a stated "Empty" tile instead of a blank preview square —
   * an empty file is a fact, a blank square is a bug report.
   */
  empty?: boolean;
  /**
   * A stated glyph tile for an entry that has no picture BY NATURE — a CONNECT
   * configuration or knowledge file, for instance — rather than one whose
   * picture merely has not arrived. Takes precedence over the thumbnail slot.
   *
   * `file:<ext>` is the tile of any other project file — PDF, slides, video,
   * whatever the folder holds: the extension in capitals is the whole label.
   * Only two families carry a colour on the icon and label — Markdown in
   * magenta, CAD geometry in amber; every other media file is neutral grey,
   * as is the tile itself (user decision 2026-09-10). The knowledge tile says
   * `MD`.
   */
  glyph?: AssetCardGlyph;
  /** Tooltip body (usually the component's behaviour description). */
  tooltip?: ReactNode;
  /** Controlled tooltip visibility — suppressed while dragging. */
  tooltipOpen?: boolean;
  /**
   * Opens the larger view of the picture. When given and the card shows a
   * thumbnail, a magnifier button sits on the picture (visible on hover and
   * keyboard focus); clicking the picture itself keeps the card's own click.
   */
  onPreview?: () => void;
  /**
   * The asset is being prepared (decoded + baked) for placement. Shows a
   * spinner over the card so a slow first drag is not a silent wait. The
   * overlay ignores the pointer — the card stays draggable and clickable.
   */
  busy?: boolean;
  /** Text under the spinner while {@link busy}. Defaults to "Preparing…". */
  busyLabel?: string;

  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}

/** Per-variant type scale. The compact column matches the pre-372 planner. */
const SCALE = {
  compact: { label: 9, tag: 7, badge: 7, glyph: 28, glyphLabel: 8 },
  comfortable: { label: 12, tag: 9, badge: 9, glyph: 40, glyphLabel: 10 },
} as const;

const ACCENT = 'rgba(79, 195, 247';   // Instrument Blue (DESIGN.md), alpha appended
const SPLAT = 'rgba(139, 195, 74';
const NEUTRAL = 'rgba(255, 255, 255';
// The reference-file type colors (user decision 2026-08-19): CONNECT is green,
// knowledge is realvirtual Magenta — same hues as the hero card's slot wells.
const CONNECT = 'rgba(102, 187, 106';
const KNOWLEDGE = 'rgba(233, 64, 120';
// CAD geometry is amber: distinct from the blue asset accent, the green CONNECT
// and the magenta document family it would otherwise disappear into.
const CAD = 'rgba(255, 167, 38';

export const AssetCard = forwardRef<HTMLDivElement, AssetCardProps>(function AssetCard(
  {
    entry,
    variant = 'compact',
    tier,
    cornerBadge,
    selected = false,
    draggable = false,
    cursor,
    placeholderAction,
    empty = false,
    glyph,
    tooltip,
    tooltipOpen,
    onPreview,
    busy = false,
    busyLabel = 'Preparing…',
    ...handlers
  },
  ref,
) {
  const s = SCALE[variant];
  // A picture that fails to load (a remote catalog without a preview for this
  // asset, plan-660) falls back to the placeholder instead of an empty frame.
  const [failedThumb, setFailedThumb] = useState<string | null>(null);
  const thumbnailUrl = entry.thumbnailUrl && entry.thumbnailUrl !== failedThumb ? entry.thumbnailUrl : undefined;

  const preview = glyph === 'connect' ? (
    <GlyphTile
      accent={CONNECT}
      icon={<SettingsEthernet sx={{ fontSize: s.glyph, color: `${CONNECT}, 0.6)` }} />}
      label="Connect"
      labelSize={s.glyphLabel}
    />
  ) : glyph === 'knowledge' ? (
    <GlyphTile
      accent={KNOWLEDGE}
      icon={<MenuBookOutlined sx={{ fontSize: s.glyph, color: `${KNOWLEDGE}, 0.6)` }} />}
      label="MD"
      labelSize={s.glyphLabel}
    />
  ) : glyph?.startsWith('file:') ? (
    (() => {
      const ext = glyph.slice(5);
      // CAD keeps its amber; every other media file (PDF, slides, video, …)
      // is neutral grey like the empty tile — only MD and CAD are coloured
      // (user decision 2026-09-10).
      const accent = isCadExtension(ext) ? CAD : NEUTRAL;
      const alpha = accent === NEUTRAL ? 0.45 : 0.6;
      return (
        <GlyphTile
          accent={accent}
          icon={fileGlyphIcon(ext, { fontSize: s.glyph, color: `${accent}, ${alpha})` })}
          label={ext || 'File'}
          labelSize={s.glyphLabel}
        />
      );
    })()
  ) : thumbnailUrl ? (
    <Box sx={{ position: 'relative', width: '100%' }}>
      <Box
        component="img"
        src={thumbnailUrl}
        onError={() => setFailedThumb(thumbnailUrl)}
        alt={entry.name}
        // Large remote catalogs (thousands of cards, plan-660) must only fetch
        // the pictures that scroll into view. Fixed intrinsic size: the saved
        // thumbnails are 512 px squares (plan-776), so the tile never shifts.
        loading="lazy"
        decoding="async"
        width={512}
        height={512}
        sx={{
          display: 'block',
          width: '100%',
          // `height: auto` is load-bearing: the height={512} attribute above would
          // otherwise become the CSS height and stretch the card.
          height: 'auto',
          aspectRatio: '1',
          objectFit: 'contain',
          borderRadius: 0.5,
          bgcolor: 'rgba(255,255,255,0.05)',
        }}
        draggable={false}
      />
      {onPreview && (
        <IconButton
          className="rv-asset-zoom"
          size="small"
          aria-label={`Show larger preview of ${entry.name}`}
          title="Larger preview"
          data-testid="asset-card-preview"
          draggable={false}
          onClick={(e) => { e.stopPropagation(); onPreview(); }}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            top: 2,
            right: 2,
            p: 0.25,
            opacity: 0,
            bgcolor: 'rgba(0,0,0,0.55)',
            color: 'rgba(255,255,255,0.85)',
            transition: 'opacity 0.15s',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.75)', color: `${ACCENT}, 1)` },
            '&:focus-visible': { opacity: 1 },
            // Touch has no hover: keep the button reachable there.
            '@media (hover: none)': { opacity: 0.85 },
          }}
        >
          <ZoomIn sx={{ fontSize: variant === 'comfortable' ? 18 : 14 }} />
        </IconButton>
      )}
    </Box>
  ) : entry.virtual ? (
    <GlyphTile
      accent={ACCENT}
      icon={<TimerOutlined sx={{ fontSize: s.glyph, color: `${ACCENT}, 0.6)` }} />}
      label={entry.desType?.replace('DES', '') ?? 'Virtual'}
      labelSize={s.glyphLabel}
    />
  ) : entry.splatUrl ? (
    <GlyphTile
      accent={SPLAT}
      icon={<Landscape sx={{ fontSize: s.glyph, color: `${SPLAT}, 0.6)` }} />}
      label="Splat"
      labelSize={s.glyphLabel}
    />
  ) : empty ? (
    // Neutral, not accented: an empty asset is a normal state on the way to
    // authored content, not something to advertise.
    <GlyphTile
      accent={NEUTRAL}
      icon={<PrecisionManufacturingOutlined sx={{ fontSize: s.glyph, color: `${NEUTRAL}, 0.45)` }} />}
      label="Empty"
      labelSize={s.glyphLabel}
    />
  ) : !placeholderAction ? (
    // No saved picture, or the named one does not load (plan-776 F9): the type
    // tile — a missing file looks exactly like "no thumbnail yet", because to
    // the user it is the same thing. Nothing is rendered to fill the gap.
    <GlyphTile
      accent={NEUTRAL}
      icon={<ViewInArOutlined sx={{ fontSize: s.glyph, color: `${NEUTRAL}, 0.45)` }} />}
      label="No preview"
      labelSize={s.glyphLabel}
    />
  ) : (
    <Box
      sx={{
        width: '100%',
        aspectRatio: '1',
        borderRadius: 0.5,
        bgcolor: 'rgba(255,255,255,0.05)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      {placeholderAction}
    </Box>
  );

  // A clickable card is a real control: focusable, activatable with Enter or
  // Space. Selection gates the detail pane — "the accessible route" — so a
  // pointer-only card would lock keyboard users out of every asset verb.
  const clickable = typeof handlers.onClick === 'function';

  const card = (
    <Box
      ref={ref}
      draggable={draggable}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable
        ? (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handlers.onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
            }
          }
        : undefined}
      {...handlers}
      aria-busy={busy || undefined}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        p: 0.5,
        borderRadius: 1,
        cursor: cursor ?? (draggable ? 'grab' : 'pointer'),
        bgcolor: selected ? `${ACCENT}, 0.15)` : 'rgba(255,255,255,0.03)',
        border: selected ? `1px solid ${ACCENT}, 0.5)` : '1px solid rgba(255,255,255,0.06)',
        '&:hover': { bgcolor: `${ACCENT}, 0.08)`, borderColor: `${ACCENT}, 0.2)` },
        '&:hover .rv-asset-zoom, &:focus-within .rv-asset-zoom': { opacity: 1 },
        // DESIGN.md: a visible focus ring, never removed. Inset so the grid's
        // scroll container cannot clip it.
        '&:focus-visible': {
          outline: `1px solid ${ACCENT}, 1)`,
          outlineOffset: '-1px',
        },
        transition: 'all 0.15s',
        userSelect: 'none',
        // Skip layout/paint for cards outside the viewport (plan-372 §2.8).
        // The intrinsic size must be a real estimate per variant: too small and
        // the scrollbar jumps as cards render in, which is worse than not
        // containing at all.
        contentVisibility: 'auto',
        containIntrinsicSize: variant === 'comfortable' ? '180px 200px' : '92px 108px',
      }}
    >
      {(tier === 'bundled' || cornerBadge) ? (
        // The preview carries the card's labels on its own corners, inert to
        // the pointer so the card's clicks pass through: the caller's label
        // (the dashboard's open mode) top-left, Bundled bottom-left. Opposite
        // edges of the square, so the two never meet — whatever the card width
        // (plan-776 follow-up, 2026-11-02). The wrapper is as wide as the
        // preview and adds no height: the card keeps its size.
        <Box data-testid="asset-card-preview-frame" sx={{ position: 'relative', width: '100%' }}>
          {preview}
          {cornerBadge && (
            <Box
              data-testid="asset-card-corner"
              sx={{
                position: 'absolute',
                top: 4,
                left: 4,
                right: 4,
                display: 'flex',
                alignItems: 'flex-start',
                pointerEvents: 'none',
                // On the smallest cards the label ellipsizes inside the preview
                // instead of running past its edge — like Bundled below.
                '&& > *': { flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
              }}
            >
              {cornerBadge}
            </Box>
          )}
          {tier === 'bundled' && (
            // Same chip as the mode label — font, size, case, padding, border,
            // backdrop — from the one shared definition.
            <Box
              component="span"
              data-testid="asset-card-bundled"
              title="Ships with this build — edits are saved as your own copy"
              sx={{
                ...LABEL_CHIP_SX,
                ...LABEL_CHIP_ON_PREVIEW_SX,
                position: 'absolute',
                left: 4,
                bottom: 4,
                maxWidth: 'calc(100% - 8px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                pointerEvents: 'none',
              }}
            >
              Bundled
            </Box>
          )}
        </Box>
      ) : preview}

      {busy && (
        // Over the whole card, pointer-transparent: the user may keep dragging
        // the very card that is preparing. `role="status"` is the announcement —
        // the 3D placeholder is invisible to a screen reader.
        <Box
          role="status"
          data-testid="asset-card-busy"
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            borderRadius: 1,
            bgcolor: 'rgba(0,0,0,0.5)',
            border: `1px solid ${ACCENT}, 0.5)`,
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={variant === 'comfortable' ? 24 : 16} thickness={5} sx={{ color: `${ACCENT}, 1)` }} />
          <Typography sx={{ fontSize: s.label, color: 'rgba(255,255,255,0.85)', lineHeight: 1.2 }}>
            {busyLabel}
          </Typography>
        </Box>
      )}

      <Typography
        sx={{
          fontSize: s.label,
          color: 'text.secondary',
          textAlign: 'center',
          lineHeight: 1.2,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.name}
      </Typography>

      {entry.tags && entry.tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25, justifyContent: 'center', mt: 0.125 }}>
          {entry.tags.map(tag => (
            <Typography
              key={tag}
              component="span"
              sx={{
                fontSize: s.tag,
                lineHeight: 1.2,
                px: 0.5,
                py: 0.125,
                borderRadius: 0.5,
                bgcolor: `${ACCENT}, 0.1)`,
                color: `${ACCENT}, 0.7)`,
                whiteSpace: 'nowrap',
              }}
            >
              {tag}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );

  if (!tooltip) return card;
  return (
    <Tooltip title={tooltip} open={tooltipOpen} placement="right" arrow disableInteractive>
      {card}
    </Tooltip>
  );
});

/**
 * Placeholder tile for entries that have no GLB to render.
 *
 * The tile itself is the same neutral grey as the empty preview square; only
 * the icon and the label carry the type colour (user decision 2026-09-10). A
 * grid of tinted squares read as a colour chart, and the accent was doing its
 * job twice — once on the glyph, once again behind it.
 */
function GlyphTile({ accent, icon, label, labelSize }: {
  accent: string; icon: ReactNode; label: string; labelSize: number;
}) {
  return (
    <Box
      data-testid="glyph-tile"
      sx={{
        width: '100%',
        aspectRatio: '1',
        borderRadius: 0.5,
        bgcolor: `${NEUTRAL}, 0.05)`,
        border: `1px dashed ${NEUTRAL}, 0.12)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
      }}
    >
      {icon}
      <Typography sx={{ fontSize: labelSize, color: `${accent}, 0.7)`, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
    </Box>
  );
}
