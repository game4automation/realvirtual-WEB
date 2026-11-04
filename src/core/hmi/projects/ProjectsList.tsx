// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsList — the first of the dashboard's two screens (plan-372 §3.2,
 * rebuilt by plan-743).
 *
 * Replaces the persistent rail. The rail asked the user to understand five
 * groups, two library kinds and a project switcher before they had opened
 * anything at all; this screen asks one question — *which project* — and gets
 * out of the way once it is answered.
 *
 * ## Two verbs, not four
 *
 * There used to be "Select workspace", "Switch workspace", "Open a single
 * project" and "New project" — four buttons for two intentions, and the user
 * had to know which of OUR concepts their folder was before they could pick the
 * right one. There are now **Add** (a folder you already have) and **New** (a
 * folder you do not). Which of the three shapes an added folder turns out to be
 * is the classifier's problem, not the user's.
 *
 * ## Every row is always listed, even when it cannot be opened right now
 *
 * A grant lapses on every browser restart, and a listing that quietly hid those
 * projects would look like data loss. So the list NEVER asks for permission —
 * `queryPermission` only, after the first paint, and a lock icon appears late
 * if it appears at all. A row whose folder is gone keeps its place and grows
 * two verbs (Locate…, Remove) instead of vanishing.
 *
 * ## Rows, not cards
 *
 * A project has no thumbnail worth showing and no shape worth comparing — it
 * has a name. Full-width rows put those names in one scannable column and give
 * the touch target the whole width, where a card grid would have spread five
 * projects across a screen of mostly empty tiles.
 */

import { useState } from 'react';
import { Box, ButtonBase, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import { ChevronRight, CreateNewFolderOutlined, FolderOpen, LockOutlined, MoreVert } from '@mui/icons-material';
import { CHIP_RADIUS, RV_SCROLL_CLASS } from '../shared-sx';
import { isSupported as isFolderPickerSupported } from '../../engine/rv-local-filesystem';
import { AddProjectProgress } from './AddProjectProgress';

/**
 * Whether a linked row can be opened right now.
 *
 * Collected AFTER the first paint (see the file header) and deliberately
 * four-valued: "no handle at all" and "grant refused" produce different
 * sentences and different verbs, and collapsing them is how a user ends up
 * clicking Locate… on a project whose folder never moved.
 */
export type LinkedRowState = 'ready' | 'needs-grant' | 'denied' | 'missing';

export interface ProjectListRow {
  id: string;
  name: string;
  /** Secondary line: the folder name as the OS spells it. */
  caption?: string | null;
  /**
   * Where the project's bytes live — the list groups its rows by this.
   *
   * The caption alone could not say it: a bundled project has no folder, so it
   * captions with a description while every local one captions with a folder
   * name — two different KINDS of sentence in the same slot, which is exactly
   * what made "which of these ships with the app?" unanswerable at a glance.
   */
  hint?: 'bundled' | 'local' | 'browser';
  /** Openability. Absent means "not probed yet", which renders as `ready`. */
  state?: LinkedRowState;
  /** True for a linked folder project: rename writes its manifest. */
  canManage?: boolean;
  /** False for bundled and browser rows: there is no link to remove. */
  canUnlink?: boolean;
}

export interface ProjectsListProps {
  rows: ProjectListRow[];
  /** Rendered with the accent border so "where am I" needs no second look. */
  activeProjectId: string | null;
  /** Kiosk mode (§2.13): browsing is fine, switching projects is not. */
  modeLocked: boolean;
  onOpenProject: (id: string) => void;
  /** Link an existing folder — project, parent of projects, or plain. */
  onAdd: () => void;
  /** Name a project and a location, then create and open it. */
  onNew: () => void;
  /** Re-point a `missing` row at the folder's new place. */
  onLocate: (id: string) => void;
  /** Forget the row and its handle. Touches no file. */
  onRemove: (id: string) => void;
  onRenameProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  /**
   * "Regenerate thumbnails" (plan-776 #20) — dispatches the registry command
   * `project.regenerateThumbnails`. Absent: the menu item is not offered.
   */
  onRegenerateThumbnails?: (id: string) => void;
  /**
   * The command's availability for a row, asked when the menu opens: `true`,
   * or the ONE reason the item is disabled (its tooltip, e.g. a read-only
   * project). Absent means enabled.
   */
  regenerateThumbnailsState?: (id: string) => true | { reason: string };
}

/**
 * Shared with the recent-documents section above this list (plan-478): the two
 * are one column on the screen, so they must be one number in the code.
 */
export const ROW_MAX_WIDTH = 760;

/**
 * Height of every section header row, in px.
 *
 * Pinned rather than derived: the headers are hairlines, and the moment one of
 * them grows to fit a taller control its rule stops sharing a rhythm with the
 * others. Every action in a header is built to fit INSIDE this.
 */
export const SECTION_HEADER_HEIGHT = 22;

/**
 * Width of the trailing slot on every row, in px.
 *
 * Always reserved, even on a row with no menu. Rendering the kebab only where
 * one exists is what made the list ragged: the bundled row ran full width
 * while every managed row stopped short of it, so one list showed two card
 * widths and four different right edges. The slot lives INSIDE the card, so
 * the card edge is the screen's single right edge — the rules, the actions and
 * every row now terminate on it.
 *
 * One control wide, because the row carries exactly one: the kebab. Remove got
 * its own ✕ beside it for a while, which cost a second icon column, put two
 * different-looking controls next to each other and still left the pair
 * overflowing this slot. The verb now lives in the menu, where Rename and
 * Delete already were, and the trailing edge is a single glyph again.
 */
const ROW_ACTION_SLOT = 40;

/**
 * A verb in a section header — the screen's one action vocabulary.
 *
 * A filled button here was the mistake this replaces. On a screen whose content
 * IS the list, a saturated slab in the meta row outranked every project row and
 * pulled the eye off the thing the user came to pick. Emphasis is carried by
 * accent and by icon; fill is reserved for state, which is how the rest of this
 * HMI already spends it.
 *
 * At rest the control is text on nothing. The hairline and ground arrive on
 * hover, so a header at rest stays a hairline and the actions still announce
 * themselves as pressable the instant the pointer is near.
 */
export function SectionAction({
  icon,
  label,
  title,
  accent = false,
  testId,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  /** Tooltip — the place the two-word verbs explain themselves. */
  title?: string;
  /** The constructive verb — accented text, never a filled ground. */
  accent?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  const button = (
    <ButtonBase
      onClick={onClick}
      data-testid={testId}
      sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        height: SECTION_HEADER_HEIGHT,
        px: 0.75,
        borderRadius: CHIP_RADIUS,
        border: '1px solid transparent',
        color: accent ? 'primary.main' : 'text.secondary',
        fontSize: 11,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        transition: 'background-color 120ms, border-color 120ms, color 120ms',
        '&:hover': accent
          ? { bgcolor: 'rgba(79,195,247,0.10)', borderColor: 'rgba(79,195,247,0.35)' }
          : { bgcolor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.14)', color: 'text.primary' },
        // The browser's own ring belongs to no design system: keyboard focus
        // gets the accent, on the same 2px corner as the control.
        '&.Mui-focusVisible': {
          borderColor: 'rgba(79,195,247,0.55)',
          bgcolor: accent ? 'rgba(79,195,247,0.10)' : 'rgba(255,255,255,0.06)',
        },
      }}
    >
      {icon}
      {label}
    </ButtonBase>
  );
  return title ? <Tooltip title={title}>{button}</Tooltip> : button;
}

/**
 * The list's groups, in render order — the shipped demo first (user decision
 * 2026-09-03), then the user's own work.
 *
 * Membership is exclusive by construction: `hint` separates the storage kinds,
 * so no row can appear twice. `bundled` is always on screen (user decision
 * 2026-09-07): it is the one project every deployment has, and a viewer whose
 * list is otherwise empty must still see the way in. `projects` is always on
 * screen too, because its header carries Add and New — the only two ways to
 * put anything in it.
 *
 * The browser project rides in `projects` as its last row rather than in a
 * section of its own: it is a project like the others, and the only thing that
 * distinguishes it is where its bytes live, which its hint already says.
 */
const SECTIONS: {
  key: string;
  label: string;
  member: (row: ProjectListRow) => boolean;
}[] = [
  { key: 'bundled', label: 'Bundled', member: row => row.hint === 'bundled' },
  { key: 'projects', label: 'Projects', member: row => row.hint !== 'bundled' },
];

export function ProjectsList({
  rows,
  activeProjectId,
  modeLocked,
  onOpenProject,
  onAdd,
  onNew,
  onLocate,
  onRemove,
  onRenameProject,
  onDeleteProject,
  onRegenerateThumbnails,
  regenerateThumbnailsState,
}: ProjectsListProps) {
  // Kiosk builds get neither the picker nor the rows — the project they were
  // given is already open, and this screen would only offer ways to leave it.
  if (modeLocked) {
    return (
      <Centered>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          This deployment opens a single fixed project.
        </Typography>
      </Centered>
    );
  }

  // Said before the click, not after it: without the File System Access API the
  // picker cannot open at all, and a dead button reads as a fault in
  // realvirtual rather than a limit of the browser. So the verbs are HIDDEN and
  // the reason is written where they would have been.
  const canPickFolders = isFolderPickerSupported();

  return (
    <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', minWidth: 0, p: 2 }}>
      <Box sx={{ maxWidth: ROW_MAX_WIDTH, mx: 'auto' }}>
        <Stack spacing={2.5}>
          {SECTIONS.map(section => {
            const members = rows.filter(section.member);
            const isProjects = section.key === 'projects';
            return (
              <Box key={section.key}>
                {/* A labeled hairline, not a heading: the label says where
                    these projects live, the line carries the separation.
                    Fixed height so every section header sits on one rule
                    line — the actions ride IN the row, they do not inflate
                    it, which is what a filled button did to this row. */}
                <Box
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    height: SECTION_HEADER_HEIGHT, mb: 1,
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase',
                      color: 'text.disabled', flexShrink: 0,
                    }}
                  >
                    {section.label}
                  </Typography>
                  <Box sx={{ flex: 1, borderTop: '1px solid rgba(255,255,255,0.08)' }} />
                  {isProjects && canPickFolders && (
                    <>
                      {/* Add leads: it is the verb that answers "I already have
                          projects", which is every user after the first day. */}
                      <SectionAction
                        icon={<FolderOpen sx={{ fontSize: 14 }} />}
                        label="Add"
                        title="Add an existing project folder"
                        testId="projects-add"
                        onClick={onAdd}
                      />
                      <SectionAction
                        icon={<CreateNewFolderOutlined sx={{ fontSize: 14 }} />}
                        label="New"
                        accent
                        testId="projects-new"
                        onClick={onNew}
                      />
                    </>
                  )}
                </Box>

                {isProjects && <AddProjectProgress />}

                {members.length === 0 ? (
                  isProjects
                    ? <EmptyProjectsBody canPickFolders={canPickFolders} onAdd={onAdd} onNew={onNew} />
                    : null
                ) : (
                  <Stack spacing={1}>
                    {members.map(row => (
                      <ProjectRow
                        key={row.id}
                        row={row}
                        active={row.id === activeProjectId}
                        onOpen={() => onOpenProject(row.id)}
                        onLocate={() => onLocate(row.id)}
                        onRemove={() => onRemove(row.id)}
                        onRename={() => onRenameProject(row.id)}
                        onDelete={() => onDeleteProject(row.id)}
                        onRegenerateThumbnails={onRegenerateThumbnails
                          ? () => onRegenerateThumbnails(row.id)
                          : undefined}
                        regenerateThumbnailsState={() => regenerateThumbnailsState?.(row.id) ?? true}
                      />
                    ))}
                  </Stack>
                )}
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}


/**
 * Where a project's bytes live, as one short word (plan-482 F5, §3.2).
 *
 * English like the rest of this surface — the section heading directly above a
 * bundled row already reads "Bundled", and the sibling marker on the same line
 * reads "OPEN". One content type per badge, and a fixed set of values, so the
 * zone's width barely moves between rows.
 */
const BACKEND_BADGE: Record<NonNullable<ProjectListRow['hint']>, string> = {
  local: 'FOLDER',
  browser: 'BROWSER',
  bundled: 'BUNDLED',
};

function ProjectRow({
  row,
  active,
  onOpen,
  onLocate,
  onRemove,
  onRename,
  onDelete,
  onRegenerateThumbnails,
  regenerateThumbnailsState,
}: {
  row: ProjectListRow;
  active: boolean;
  onOpen: () => void;
  onLocate: () => void;
  onRemove: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRegenerateThumbnails?: () => void;
  regenerateThumbnailsState: () => true | { reason: string };
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Remove has no button of its own any more, so the kebab has to exist
  // wherever it is offered. Keyed on `canManage` alone the menu would vanish
  // from a row that may only be unlinked, taking the verb with it.
  const canRemove = !!row.canUnlink;
  // Regenerate thumbnails is offered on EVERY row (plan-776 #20) — on a
  // read-only one disabled, with the reason as its tooltip, so the bundled
  // demo says why it cannot instead of hiding the verb.
  const hasMenu = !!row.canManage || canRemove || !!onRegenerateThumbnails;
  // Asked when the menu is open, so the answer is the one of this moment.
  const regenerateState = menuAnchor && onRegenerateThumbnails ? regenerateThumbnailsState() : true;
  const regenerateReason = regenerateState === true ? null : regenerateState.reason;
  const state = row.state ?? 'ready';
  const missing = state === 'missing';
  const backendBadge = row.hint ? BACKEND_BADGE[row.hint] : undefined;
  return (
    // The CARD is this container, not the button inside it. The row's trailing
    // controls used to sit outside the bordered surface, which pushed them past
    // every other right edge on the screen and shortened the card they belonged
    // to. Inside, they share the card's ground and its edge.
    <Box
      data-testid={`project-row-${row.id}`}
      data-state={state}
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 1,
        border: '1px solid',
        borderColor: active ? 'primary.main' : 'rgba(255,255,255,0.08)',
        bgcolor: active ? 'rgba(79,195,247,0.08)' : 'rgba(255,255,255,0.03)',
        transition: 'background-color 120ms, border-color 120ms',
        '&:hover': {
          bgcolor: active ? 'rgba(79,195,247,0.12)' : 'rgba(255,255,255,0.07)',
          borderColor: active ? 'primary.main' : 'rgba(255,255,255,0.14)',
        },
      }}
    >
      <ButtonBase
        onClick={onOpen}
        onContextMenu={hasMenu
          ? (e) => { e.preventDefault(); setMenuAnchor(e.currentTarget); }
          : undefined}
        sx={{
          flex: 1,
          minWidth: 0,
          justifyContent: 'flex-start',
          textAlign: 'left',
          // Asymmetric on purpose: the trailing slot supplies the right margin,
          // so a full `px` here would pad the gap twice and strand the chevron
          // in the middle of the empty space instead of beside the kebab.
          pl: 2,
          pr: 1,
          py: 1.5,
          borderRadius: 'inherit',
          '&.Mui-focusVisible': { bgcolor: 'rgba(255,255,255,0.07)' },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Typography
              sx={{
                fontSize: 14, fontWeight: 600, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {row.name}
            </Typography>
            {/* Silent by design: a lapsed grant is the NORMAL state after a
                browser restart, so it gets an icon and no words. The prompt
                arrives when the user clicks, which is the gesture that can pay
                for it. */}
            {state === 'needs-grant' && (
              <Tooltip title="Opening this project will ask for folder access again">
                <LockOutlined
                  data-testid={`project-lock-${row.id}`}
                  sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }}
                />
              </Tooltip>
            )}
          </Box>
          {row.caption && (
            <Typography
              sx={{
                fontSize: 11,
                color: 'text.disabled',
                fontFamily: 'monospace',
                mt: 0.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.caption}
            </Typography>
          )}
          {/* The two states that need a sentence. Both are on the row rather
              than in a toast: the toast is gone by the time the user has
              worked out which of five projects it meant. */}
          {state === 'denied' && (
            <Typography sx={{ fontSize: 11, color: 'warning.main', mt: 0.5 }}>
              Access to this folder was not granted
            </Typography>
          )}
          {missing && (
            <Typography sx={{ fontSize: 11, color: 'error.main', mt: 0.5 }}>
              Folder not found
            </Typography>
          )}
        </Box>
        {/* Where the project's bytes live (plan-482 F5). It is the answer to
            the question the lock icon raises — why THIS row can ask for
            permission and that one cannot — and it comes from `hint`, which
            the list already computes to group the sections.

            In the RIGHT zone, deliberately: `caption` carries two different
            meanings depending on the project type (see its comment above) and
            is overloaded already, and the state sentences below it must keep
            the full width they need. A fixed zone also stops the rows from
            jostling as the badge text changes length. */}
        {backendBadge && (
          <Box
            data-testid={`project-backend-${row.id}`}
            sx={{
              flexShrink: 0, mr: 1, px: 0.75, py: 0.25,
              borderRadius: CHIP_RADIUS,
              border: '1px solid rgba(255,255,255,0.14)',
              fontSize: 10, letterSpacing: 0.4, color: 'text.secondary',
              whiteSpace: 'nowrap',
            }}
          >
            {backendBadge}
          </Box>
        )}
        {active && (
          <Typography sx={{ fontSize: 10, color: 'primary.main', mr: 1, letterSpacing: 0.5 }}>
            OPEN
          </Typography>
        )}
        <ChevronRight sx={{ fontSize: 20, color: 'text.disabled', flexShrink: 0 }} />
      </ButtonBase>

      {/* Reserved on every row, filled on some. An empty slot costs one column
          of ground and buys a single chevron column and a single card edge. */}
      <Box
        onClick={(e) => e.stopPropagation()}
        sx={{
          width: missing ? 'auto' : ROW_ACTION_SLOT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          // Right-aligned rather than centred: a row carrying one control then
          // lands it on the same x as the last control of a row carrying two,
          // so the icons hold a column instead of drifting with their count.
          justifyContent: 'flex-end',
          gap: 0.5,
          pr: 1,
        }}
      >
        {missing && (
          <ButtonBase
            onClick={onLocate}
            data-testid={`project-locate-${row.id}`}
            sx={{
              fontSize: 11, px: 0.75, py: 0.25, borderRadius: CHIP_RADIUS,
              color: 'primary.main', whiteSpace: 'nowrap',
              '&:hover': { bgcolor: 'rgba(79,195,247,0.10)' },
            }}
          >
            Locate…
          </ButtonBase>
        )}
        {hasMenu && (
          <IconButton
            size="small"
            aria-label={`Project actions for ${row.name}`}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreVert sx={{ fontSize: 15 }} />
          </IconButton>
        )}
      </Box>

      {hasMenu && (
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
          {row.canManage && (
            <MenuItem
              onClick={() => { setMenuAnchor(null); onRename(); }}
              sx={{ fontSize: 13 }}
            >
              Rename…
            </MenuItem>
          )}
          {/* Re-renders every document's picture (plan-776 #20). A refusing
              item keeps its hover — NOT MUI's `disabled`, which sets
              `pointer-events: none` and would swallow the tooltip that says
              why (the same rule as `ActionMenuRow`). */}
          {onRegenerateThumbnails && (
            <Tooltip title={regenerateReason ?? ''} placement="left" disableInteractive>
              <MenuItem
                aria-disabled={regenerateReason ? 'true' : undefined}
                onClick={() => {
                  if (regenerateReason) return;
                  setMenuAnchor(null);
                  onRegenerateThumbnails();
                }}
                data-testid={`project-regenerate-thumbnails-${row.id}`}
                sx={{
                  fontSize: 13,
                  ...(regenerateReason ? { color: 'text.disabled', cursor: 'default' } : {}),
                }}
              >
                Regenerate thumbnails
              </MenuItem>
            </Tooltip>
          )}
          {/* Forgets the link and nothing else. It sits ABOVE Delete and
              without its colour because the two read alike and are not:
              this one leaves every file on disk untouched. */}
          {canRemove && (
            <MenuItem
              onClick={() => { setMenuAnchor(null); onRemove(); }}
              data-testid={`project-remove-${row.id}`}
              sx={{ fontSize: 13 }}
            >
              Remove from list
            </MenuItem>
          )}
          {row.canManage && (
            <MenuItem
              onClick={() => { setMenuAnchor(null); onDelete(); }}
              sx={{ fontSize: 13, color: 'error.main' }}
            >
              Delete…
            </MenuItem>
          )}
        </Menu>
      )}
    </Box>
  );
}

/**
 * The Projects section with nothing in it yet.
 *
 * One sentence and the two verbs — deliberately the SAME two the header
 * carries, so the screen has one action vocabulary whether it is empty or full.
 * Without the File System Access API neither verb can work, so neither is
 * shown and the browser is named instead.
 */
function EmptyProjectsBody({
  canPickFolders,
  onAdd,
  onNew,
}: {
  canPickFolders: boolean;
  onAdd: () => void;
  onNew: () => void;
}) {
  return (
    <Box
      data-testid="projects-empty"
      sx={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 1,
        // Recessed, not dashed: a dashed outline in this HMI means a drop
        // target. This is a slot waiting to be filled, so it reads as the same
        // surface as a project row, one step darker.
        bgcolor: 'rgba(255,255,255,0.015)',
        px: 2.5,
        py: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <FolderOpen sx={{ fontSize: 22, color: 'rgba(255,255,255,0.18)' }} />
      {canPickFolders ? (
        <>
          <Typography sx={{ fontSize: 13, color: 'text.secondary', mt: 1.25 }}>
            Add a project folder or create a new one
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
            <SectionAction
              icon={<FolderOpen sx={{ fontSize: 14 }} />}
              label="Add"
              title="Add an existing project folder"
              testId="projects-add-empty"
              onClick={onAdd}
            />
            <SectionAction
              icon={<CreateNewFolderOutlined sx={{ fontSize: 14 }} />}
              label="New"
              accent
              testId="projects-new-empty"
              onClick={onNew}
            />
          </Box>
        </>
      ) : (
        <Typography
          data-testid="projects-no-fsa"
          sx={{ fontSize: 12, color: 'warning.main', mt: 1.25, lineHeight: 1.6, maxWidth: 340 }}
        >
          Folder projects need Chrome or Edge
        </Typography>
      )}
    </Box>
  );
}

/** Vertically and horizontally centred column — used by the kiosk notice. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
      }}
    >
      {children}
    </Box>
  );
}

