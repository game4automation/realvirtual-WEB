// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Chip, Link } from '@mui/material';
import { MyLocation } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';

export interface PartLinkProps {
  /** Full scene hierarchy path of the referenced part. */
  path: string;
  /** Visible text. Defaults to the final segment of {@link path}. */
  label?: string;
  /** Compact context/affected-parts chip or an answer-text inline link. */
  variant: 'chip' | 'inline';
  /** Optional navigation override. The default selects and frames the part. */
  onNavigate?: (path: string) => void;
  /** Optional delete action used by removable context chips. */
  onDelete?: () => void;
}

function pathLeaf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Canonical scene-part link: target icon first, then the part name. */
export function PartLink({ path, label, variant, onNavigate, onDelete }: PartLinkProps) {
  const viewer = useViewer();
  const text = label ?? pathLeaf(path);

  const navigate = () => {
    if (onNavigate) {
      onNavigate(path);
      return;
    }
    viewer.selectionManager.select(path);
    const node = viewer.registry?.getNode(path);
    if (node) viewer.fitToNodes([node]);
  };

  if (variant === 'chip') {
    return (
      <Chip
        icon={<MyLocation sx={{ fontSize: 16 }} />}
        label={text}
        title={path}
        variant="outlined"
        size="small"
        clickable
        onClick={navigate}
        onDelete={onDelete}
        sx={{
          color: '#4fc3f7',
          borderColor: 'rgba(79,195,247,0.5)',
          '& .MuiChip-icon': { color: '#4fc3f7' },
          '& .MuiChip-deleteIcon': { color: 'rgba(79,195,247,0.7)' },
        }}
      />
    );
  }

  return (
    <Link
      component="button"
      type="button"
      title={path}
      underline="none"
      onClick={navigate}
      sx={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 0.25,
        p: 0,
        border: 0,
        color: '#4fc3f7',
        font: 'inherit',
        lineHeight: 'inherit',
        verticalAlign: 'baseline',
        cursor: 'pointer',
        '&:hover': { textDecoration: 'underline' },
      }}
    >
      <MyLocation sx={{ alignSelf: 'center', fontSize: 14 }} />
      {text}
    </Link>
  );
}
