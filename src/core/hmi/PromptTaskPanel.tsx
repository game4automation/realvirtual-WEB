// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PromptTaskPanel — the queue of orders waiting for a coding agent (plan-486 F7).
 *
 * It answers three questions the user cannot answer any other way:
 *
 *  - **what is queued** — time, node, the first words of the order, status;
 *  - **has anybody collected it** — the queue is a PULL queue, so "nothing has
 *    been claimed yet" is a normal state that must not look like a failure. If
 *    no agent ever calls `web_prompt_claim`, the tasks simply sit here, and the
 *    panel says so instead of leaving the user waiting;
 *  - **is anything wrong** — a failed write to `localStorage`, a displaced task,
 *    a refused enqueue, volatile mode. All of those are silent by nature, and a
 *    queue that silently loses work is worse than no queue.
 *
 * `↺` reopens a claimed task (an agent run that never came back), `🗑` removes
 * one. Both are the whole recovery story: v1 has no return channel.
 */

import { useSyncExternalStore } from 'react';
import { Box, IconButton, Typography, Tooltip, Alert } from '@mui/material';
import { Replay, DeleteOutline } from '@mui/icons-material';
import { FloatingPanel } from './FloatingPanel';
import { useUIVisible, type UIVisibilityRule } from './ui-context-store';
import type { PromptTaskStore, PromptTaskSnapshot } from './prompt-task-store';
import type { PromptTask } from './prompt-task-envelope';

/** The UI element id and rule — the panel is gone in viewer and kiosk modes. */
export const PROMPT_TASK_UI_ID = 'prompt-task-panel';
export const PROMPT_TASK_VISIBILITY: UIVisibilityRule = { hiddenIn: ['mode:viewer', 'kiosk'] };

export interface PromptTaskPanelProps {
  store: PromptTaskStore;
  open: boolean;
  onClose: () => void;
}

/** `14:22` — local time of day, the only part of the timestamp a user scans for. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Last path segment — the full path is in the task, the list needs the name. */
function leafOf(path: string): string {
  const leaf = path.split('/').filter(Boolean).pop();
  return leaf || '(scene)';
}

function firstLine(prompt: string, max = 60): string {
  const line = prompt.split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** "no agent has collected anything yet" — true also when the last claim is old. */
export function noRecentClaim(snapshot: PromptTaskSnapshot, nowMs: number): boolean {
  if (snapshot.open === 0) return false;
  if (!snapshot.lastClaimAt) return true;
  const at = new Date(snapshot.lastClaimAt).getTime();
  return Number.isNaN(at) || nowMs - at > 30 * 60_000;
}

function TaskRow({ task, store }: { task: PromptTask; store: PromptTaskStore }) {
  const claimed = task.status === 'claimed';
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5,
      borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: claimed ? 0.65 : 1,
    }}>
      <Typography variant="caption" sx={{ fontFamily: 'monospace', minWidth: 42 }}>
        {timeOf(task.createdAt)}
      </Typography>
      <Tooltip title={task.context.targetPath || ''}>
        <Typography variant="caption" sx={{ minWidth: 90, fontWeight: 600 }} noWrap>
          {leafOf(task.context.targetPath)}
        </Typography>
      </Tooltip>
      <Typography variant="caption" sx={{ flex: 1 }} noWrap title={task.prompt}>
        {firstLine(task.prompt)}
      </Typography>
      {claimed && (
        <Typography variant="caption" sx={{ color: 'success.light' }}>claimed</Typography>
      )}
      {claimed && (
        <Tooltip title="Put this task back into the queue">
          <IconButton size="small" aria-label={`reopen ${task.id}`} onClick={() => store.reopen(task.id)}>
            <Replay fontSize="inherit" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Delete this task">
        <IconButton size="small" aria-label={`delete ${task.id}`} onClick={() => store.remove(task.id)}>
          <DeleteOutline fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export function PromptTaskPanel({ store, open, onClose }: PromptTaskPanelProps) {
  const visible = useUIVisible(PROMPT_TASK_UI_ID, PROMPT_TASK_VISIBILITY);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!visible) return null;

  const tasks = [...snapshot.tasks].reverse(); // newest first — a queue is read from the top
  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title="Tasks for the agent"
      subtitle={`${snapshot.open} open · ${snapshot.claimed} claimed`}
      panelId={PROMPT_TASK_UI_ID}
      defaultWidth={520}
      defaultHeight={320}
      role="region"
      aria-label="Prompt tasks for the coding agent"
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
        {snapshot.persistError && (
          <Alert severity="warning" variant="outlined" sx={{ m: 1 }}>
            {snapshot.persistError} — tasks stay in this tab only until it is closed.
          </Alert>
        )}
        {snapshot.notice && (
          <Alert severity="info" variant="outlined" sx={{ m: 1 }} onClose={() => store.acknowledgeNotice()}>
            {snapshot.notice}
          </Alert>
        )}
        {snapshot.volatile && (
          <Alert severity="info" variant="outlined" sx={{ m: 1 }}>
            No browser storage available — the queue lives in this session only.
          </Alert>
        )}
        {tasks.length === 0 && (
          <Typography variant="caption" sx={{ p: 2, opacity: 0.7 }}>
            Nothing queued. Right-click a part in the scene and type an order for the agent.
          </Typography>
        )}
        {tasks.map((task) => <TaskRow key={task.id} task={task} store={store} />)}
        {noRecentClaim(snapshot, Date.now()) && (
          <Typography variant="caption" sx={{ p: 1, opacity: 0.7 }}>
            Nothing collected yet — is a session running <code>web_prompt_claim</code>?
          </Typography>
        )}
      </Box>
    </FloatingPanel>
  );
}
