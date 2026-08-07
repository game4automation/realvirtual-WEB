// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsList — the first of the dashboard's two screens (plan-372 §3.2).
 *
 * Replaces the persistent rail. The rail asked the user to understand five
 * groups, two library kinds and a project switcher before they had opened
 * anything at all; this screen asks one question — *which project* — and gets
 * out of the way once it is answered.
 *
 * ## The empty state is the important half
 *
 * Without a workspace there is nothing to list, and the old rail rendered that
 * as an empty column with a small link at the bottom: a screen that looks
 * broken rather than one that is waiting. Here the "no workspace" case IS the
 * screen — one sentence saying what a workspace is, and the button that picks
 * one. Discovery only ever reads direct subfolders, so the sentence can promise
 * exactly what the scan will do.
 *
 * ## Rows, not cards
 *
 * A project has no thumbnail worth showing and no shape worth comparing — it
 * has a name. Full-width rows put those names in one scannable column and give
 * the touch target the whole width, where a card grid would have spread five
 * projects across a screen of mostly empty tiles.
 */

import { Box, Button, ButtonBase, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { ChevronRight, Close, FolderOpen } from '@mui/icons-material';
import { RV_SCROLL_CLASS } from '../shared-sx';

/** Where a row came from — recents are forgettable, workspace entries are not. */
export type ProjectOrigin = 'workspace' | 'recent';

export interface ProjectListRow {
  id: string;
  name: string;
  /** Secondary line: folder name, or the path a recent was opened from. */
  caption?: string | null;
  origin: ProjectOrigin;
}

export interface ProjectsListProps {
  /** False renders the empty state instead of the list. */
  hasWorkspace: boolean;
  /** Folder name of the picked workspace, shown as the list's caption. */
  workspaceName: string | null;
  rows: ProjectListRow[];
  /** Rendered with the accent border so "where am I" needs no second look. */
  activeProjectId: string | null;
  /** Kiosk mode (§2.13): browsing is fine, switching projects is not. */
  modeLocked: boolean;
  onOpenProject: (id: string) => void;
  onOpenWorkspace: () => void;
  onOpenFolder: () => void;
  onForgetProject: (id: string) => void;
}

const ROW_MAX_WIDTH = 760;

export function ProjectsList({
  hasWorkspace,
  workspaceName,
  rows,
  activeProjectId,
  modeLocked,
  onOpenProject,
  onOpenWorkspace,
  onOpenFolder,
  onForgetProject,
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

  // The empty state is for "nothing to show", not merely "no workspace": a
  // deploy's bundled project is a real row that arrives without one, and
  // hiding it behind the picker would strand a user who already has a project
  // open with no way into it.
  if (!hasWorkspace && rows.length === 0) {
    return (
      <Centered>
        <Box
          sx={{
            width: '100%',
            maxWidth: 460,
            textAlign: 'center',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 1,
            bgcolor: 'rgba(255,255,255,0.03)',
            px: 3,
            py: 4,
          }}
        >
          <FolderOpen sx={{ fontSize: 28, color: 'text.disabled', mb: 1 }} />
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
            No workspace selected
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.75, lineHeight: 1.5 }}>
            A workspace is one folder that holds your projects. Every direct
            subfolder with a <code>project.json</code> shows up here.
          </Typography>
          <Button
            variant="contained"
            size="small"
            onClick={onOpenWorkspace}
            sx={{ mt: 2, fontSize: 12, textTransform: 'none' }}
          >
            Open workspace…
          </Button>
        </Box>

        {/* A project outside any workspace stays legal — it just arrives
            through its own picker and lives in Recent afterwards. */}
        <Button
          size="small"
          onClick={onOpenFolder}
          sx={{ mt: 1.5, fontSize: 11, textTransform: 'none', color: 'text.secondary' }}
        >
          or open a single project folder…
        </Button>
      </Centered>
    );
  }

  return (
    <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', minWidth: 0, p: 2 }}>
      <Box sx={{ maxWidth: ROW_MAX_WIDTH, mx: 'auto' }}>
        {workspaceName ? (
          <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 1 }}>
            Workspace: {workspaceName}
          </Typography>
        ) : (
          // Rows without a workspace: say so, and keep the picker one click
          // away rather than making the user find it in the header.
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
              No workspace selected.
            </Typography>
            <Button
              size="small"
              onClick={onOpenWorkspace}
              sx={{ fontSize: 11, textTransform: 'none', minWidth: 0, p: 0 }}
            >
              Open workspace…
            </Button>
          </Box>
        )}

        {rows.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: 'text.disabled', py: 4, textAlign: 'center' }}>
            This workspace has no projects yet.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {rows.map(row => (
              <ProjectRow
                key={row.id}
                row={row}
                active={row.id === activeProjectId}
                onOpen={() => onOpenProject(row.id)}
                onForget={() => onForgetProject(row.id)}
              />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

function ProjectRow({
  row,
  active,
  onOpen,
  onForget,
}: {
  row: ProjectListRow;
  active: boolean;
  onOpen: () => void;
  onForget: () => void;
}) {
  return (
    <Box sx={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
      <ButtonBase
        onClick={onOpen}
        sx={{
          flex: 1,
          justifyContent: 'flex-start',
          textAlign: 'left',
          px: 2,
          py: 1.5,
          borderRadius: 1,
          border: '1px solid',
          borderColor: active ? 'primary.main' : 'rgba(255,255,255,0.08)',
          bgcolor: active ? 'rgba(79,195,247,0.08)' : 'rgba(255,255,255,0.03)',
          transition: 'background-color 120ms, border-color 120ms',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.07)' },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
            {row.name}
          </Typography>
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
        </Box>
        {active && (
          <Typography sx={{ fontSize: 10, color: 'primary.main', mr: 1, letterSpacing: 0.5 }}>
            OPEN
          </Typography>
        )}
        <ChevronRight sx={{ fontSize: 20, color: 'text.disabled', flexShrink: 0 }} />
      </ButtonBase>

      {/* Only a recent can be forgotten: a workspace subfolder would simply be
          rediscovered by the next scan, so the button would do nothing. */}
      {row.origin === 'recent' && (
        <Tooltip title="Remove from Recent">
          <IconButton
            size="small"
            aria-label={`Remove ${row.name} from Recent`}
            onClick={onForget}
            sx={{ alignSelf: 'center', ml: 0.5 }}
          >
            <Close sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

/** Vertically and horizontally centred column — used by both empty states. */
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
