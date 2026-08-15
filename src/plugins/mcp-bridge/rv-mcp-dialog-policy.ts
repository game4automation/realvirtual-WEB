// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-dialog-policy — how an MCP call answers the editor's modal dialogs.
 *
 * ## Why
 *
 * The asset editor asks the user things: an unsaved draft conflicts with the
 * asset you requested, drafts were shelved earlier, CAD bytes could not be
 * restored. Each of those is a promise that settles on a CLICK. An MCP call
 * that raises one has nobody to click it, so it blocks until the bridge's
 * timeout and returns `outcome=unknown` — with the dialog still on screen,
 * poisoning every following call too. The editor open path alone can raise
 * five of them.
 *
 * So the bridge installs this responder for the duration of each call
 * (`setDialogAutoResponder`), and reports whatever it answered back inside the
 * tool result as `autoAnsweredDialogs`.
 *
 * ## The policy, and why each default
 *
 * The rule is **never destroy work an agent did not ask to destroy, and never
 * decide anything the agent has a parameter for.** Declining (returning
 * `undefined`) leaves the dialog to the human, which is the right answer for
 * anything genuinely ambiguous.
 *
 * | Dialog | Answer | Why |
 * |---|---|---|
 * | `draft-conflict` | `open-requested` | The dialog's own text: opening the requested asset KEEPS the draft, set aside for next time. The only branch that loses nothing. |
 * | `unsaved` | `cancel` | Refuse rather than guess. `web_editor_open` already takes `ifDirty` — a tool with an explicit parameter must not be second-guessed here. |
 * | `draft-recovery` | `restore` | Of `restore | discard`, only one is reversible. A silent discard is exactly the data loss the per-frame keyspace exists to prevent. |
 * | `shelved-drafts` | `{action:'later'}` | Touch nothing; the offer comes back. |
 * | `save-fallback` | `cancel` | Never trigger a browser download nobody asked for. The tool reports the real reason instead. |
 * | `name` | `null` | An agent that wanted a name passed one (`web_editor_save name=`). Being asked means it did not — cancel and say so. |
 * | `reimport-report`, `cad-missing`, `stack-problem`, `merge-unapplied` | dismiss | Informational. Auto-dismissed but carried back in `autoAnsweredDialogs` WITH their detail, so the diagnostic is never lost. |
 * | `separate-preview`, `merge-preview` | decline | Interactive previews driven by a human flow; an agent has no business confirming a destructive mesh operation from a dialog it cannot see. |
 */

/** Dialogs answered automatically during one MCP call. */
export interface AutoAnsweredDialogReport {
  kind: string;
  answer: string;
  detail?: string;
}

/** Release function: restores the previous responder and drains the log. */
export type DialogPolicyRelease = () => AutoAnsweredDialogReport[];

const NOOP_RELEASE: DialogPolicyRelease = () => [];

/**
 * Install the MCP dialog policy. Returns a release function to call in a
 * `finally`. Resolves to a no-op when the asset-editor chunk is not loadable
 * (community build without the editor, or a load failure) — dialog handling
 * must never be the thing that breaks a tool call.
 */
export async function installMcpDialogPolicy(): Promise<DialogPolicyRelease> {
  let mod: typeof import('@rv-private/plugins/asset-editor/editor-dialog-store');
  try {
    mod = await import('@rv-private/plugins/asset-editor/editor-dialog-store');
  } catch {
    return NOOP_RELEASE;
  }
  if (typeof mod.setDialogAutoResponder !== 'function') return NOOP_RELEASE;

  const { DIALOG_AUTO_DISMISS } = mod;

  const previous = mod.setDialogAutoResponder((d) => {
    switch (d.kind) {
      case 'draft-conflict': return 'open-requested';
      case 'unsaved': return 'cancel';
      case 'draft-recovery': return 'restore';
      case 'shelved-drafts': return { action: 'later' };
      case 'save-fallback': return 'cancel';
      case 'name': return null;
      case 'reimport-report':
      case 'cad-missing':
      case 'stack-problem':
      case 'merge-unapplied':
        return DIALOG_AUTO_DISMISS;
      default:
        // Interactive previews and anything added later: let the human decide.
        return undefined;
    }
  });

  // Drop anything logged before this call so the report is per-call.
  mod.takeDialogAutoLog();

  return () => {
    mod.setDialogAutoResponder(previous);
    return mod.takeDialogAutoLog();
  };
}

/**
 * Merge the auto-answer report into a tool's JSON result.
 *
 * Silence would defeat the point: an agent must be able to see that its open
 * quietly set a draft aside, or that CAD geometry was reported missing. A
 * result that is not a JSON object is returned untouched rather than mangled.
 */
export function withDialogReport(result: unknown, answered: AutoAnsweredDialogReport[]): unknown {
  if (answered.length === 0 || typeof result !== 'string') return result;
  try {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), autoAnsweredDialogs: answered });
  } catch {
    return result;
  }
}
