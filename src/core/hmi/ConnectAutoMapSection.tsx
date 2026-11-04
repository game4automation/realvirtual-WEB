// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectAutoMapSection — the signal RECONCILE strip of an expanded interface card
 * (plan-589 F6; plan-545 for the legacy seed below it).
 *
 * One line: badge `mapped / total`, *Check* (recompute now) and the two actions. Below it the
 * categories as collapsible lists.
 *
 * ## Why this replaced the auto-map strip
 *
 * plan-545's strip answered "which model signals could get an address from their comment", which
 * is a question about ONE migration path and only for S7 / PLCSIM. The reconcile report answers
 * the question the user actually has — *is this model talking to this interface* — for every
 * interface type, and it never writes (plan-589 §"Wann laeuft der Abgleich?"). The old Apply
 * survives as the explicit, merge-only **Adopt legacy addresses**, offered only where it has a
 * meaning, and the one repair the report itself offers is **Create model signals**.
 *
 * The report shown here is the one the CONNECT plugin keeps in `reconcileReports` (debounced), so
 * the badge, the Problems panel and `web_signal_reconcile` can never disagree.
 *
 * ## Address sources (plan-2025 F11 / F12)
 *
 * A second line offers the two ways to put addresses into CONNECT in bulk, by CAPABILITY rather than
 * by protocol: **Fill addresses from controller** wherever the gateway says the worker can browse
 * (`supportsDiscovery`), and **Import address table** for every interface. The legacy seed sits on
 * its own line below, labelled as such, and only where it means something (S7, PLCSIM) — it is a
 * migration path, not an address source, and it is decided by `legacyAdoptProtocolOf`, not by the
 * capability that decides Fill.
 */

import { useState, useSyncExternalStore, useCallback } from 'react';
import { Box, Typography, Button, Collapse, Tooltip, CircularProgress } from '@mui/material';
import { ExpandMore, ExpandLess } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  applyAutoMap,
  legacyAdoptProtocolOf,
  getConnectOpsSupport,
  getSignalSchema,
  isModelManagedInterfaceType,
  reconcileInterfaces,
  CONNECT_OPS_REQUIRED_MESSAGE,
  type ConnectInterface,
} from './connect-store';
import { supportsFillAddresses } from '../import/rv-fill-addresses';
import { AddressTableImportDialog, FillAddressesDialog } from './ConnectAddressSourceDialogs';
import { collectModelPlcSignals } from '../import/rv-plc-automap';
import {
  creatablePlcOnly,
  RECONCILE_CATEGORIES,
  UNSUPPORTED_TYPE_HINT,
  type ReconcileCategory,
  type ReconcileEntry,
} from '../import/rv-signal-reconcile';
import { commandRegistry } from './rv-command-registry';
import { SIGNALS_CREATE_FROM_INTERFACE_COMMAND } from './problems-store';
import { MappedBadge } from './MappedBadge';
import { ISA_AMBER, ISA_RED } from './isa-colors';

/** Rows shown per category before "+N more". */
const MAX_ROWS = 50;

const CATEGORY_LABEL: Record<ReconcileCategory, string> = {
  mapped: 'Mapped',
  'name-variant': 'Name variant (not coupled)',
  'missing-in-plc': 'Missing on the interface',
  'plc-only': 'Interface only (not in the model)',
  'type-mismatch': 'Type mismatch',
  'no-address': 'No address',
};

/** Categories that need a human. `mapped` and `plc-only` are states, not faults. */
const WARN: ReadonlySet<ReconcileCategory> = new Set<ReconcileCategory>([
  'name-variant', 'missing-in-plc', 'type-mismatch', 'no-address',
]);

/** One row's second line: the address, the other spelling, the unsupported marker. */
function rowDetail(entry: ReconcileEntry): string {
  if (entry.suggestion === UNSUPPORTED_TYPE_HINT) return UNSUPPORTED_TYPE_HINT;
  if (entry.suggestion) return `model: ${entry.suggestion}`;
  if (entry.category === 'type-mismatch') {
    return `${entry.modelType ?? '?'} / ${entry.modelDataType ?? '?'} vs `
      + `${entry.slot?.type ?? '?'} / ${entry.slot?.dataType ?? '?'}`;
  }
  return entry.slot?.protocolAddress ?? '';
}

function CategoryList({ category, entries }: { category: ReconcileCategory; entries: readonly ReconcileEntry[] }) {
  const [open, setOpen] = useState(false);
  const warn = WARN.has(category);
  return (
    <Box>
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', py: 0.1,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }}
      >
        {open ? <ExpandLess sx={{ fontSize: 12 }} /> : <ExpandMore sx={{ fontSize: 12 }} />}
        <Typography sx={{ fontSize: 10, flex: 1, color: warn ? ISA_AMBER : 'rgba(255,255,255,0.7)' }}>
          {CATEGORY_LABEL[category]}
        </Typography>
        <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.6)' }}>
          {entries.length}
        </Typography>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 2, pb: 0.5 }}>
          {entries.slice(0, MAX_ROWS).map((e, i) => (
            <Tooltip key={`${e.name}-${e.slot?.topic ?? ''}-${i}`} title={e.path ?? ''} placement="right" disableInteractive>
              <Typography noWrap sx={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>
                {e.name}
                {e.slot?.topic ? `  @${e.slot.topic}` : ''}
                {rowDetail(e) ? `  ${rowDetail(e)}` : ''}
              </Typography>
            </Tooltip>
          ))}
          {entries.length > MAX_ROWS && (
            <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>+{entries.length - MAX_ROWS} more</Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

/** Reconcile strip for one interface; renders nothing for a model-managed (FMI) one. */
export function ConnectAutoMapSection({ iface }: { iface: ConnectInterface }) {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const check = useCallback(() => {
    setError(null);
    try {
      reconcileInterfaces(collectModelPlcSignals(viewer), [iface.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [viewer, iface.id]);

  const adoptLegacy = useCallback(async () => {
    setError(null);
    try {
      await applyAutoMap(iface.id, collectModelPlcSignals(viewer));
      reconcileInterfaces(collectModelPlcSignals(viewer), [iface.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [viewer, iface.id]);

  const report = snap.reconcileReports?.[iface.id] ?? null;
  const creatable = report ? creatablePlcOnly(report) : [];

  const createSignals = useCallback(async () => {
    setError(null);
    const result = await commandRegistry.execute(
      SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
      { interfaceId: iface.id, parentPath: viewer.selectionManager.getSnapshot().primaryPath, names: null },
      { origin: 'ui', viewer },
    );
    if (!result.ok) setError(result.reason);
    else reconcileInterfaces(collectModelPlcSignals(viewer), [iface.id]);
  }, [viewer, iface.id]);

  if (isModelManagedInterfaceType(iface.type)) return null;
  const legacyProtocol = legacyAdoptProtocolOf(iface.type);
  const canFill = supportsFillAddresses(getSignalSchema(iface.type), false);
  // An older CONNECT (no write core): the address sources need FillEmpty and the end-state check.
  const opsMissing = getConnectOpsSupport() === false;
  const busy = !!snap.autoMapBusy;
  const problems = report
    ? RECONCILE_CATEGORIES.filter((c) => WARN.has(c)).reduce((n, c) => n + report.counts[c], 0)
    : 0;

  return (
    <Box data-testid="connect-automap" sx={{ px: 1, py: 0.5, borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography sx={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.75)', flex: 1 }}>
          Signal reconcile
        </Typography>
        <MappedBadge
          data-testid="reconcile-badge"
          mapped={report?.counts.mapped ?? 0}
          total={report?.entries.length ?? 0}
          problems={problems}
          hasReport={report !== null}
          subject="signals"
        />
        {busy && <CircularProgress size={10} />}
        <Tooltip title="Compare the model signals with this interface again (read-only)">
          <span>
            <Button size="small" disabled={busy} onClick={check}
              sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
              Check
            </Button>
          </span>
        </Tooltip>
        {creatable.length > 0 && (
          <Tooltip title="Create model signals for the interface signals the model does not have. The CONNECT name is used unchanged; they are added under the selected node.">
            <span>
              <Button size="small" variant="outlined" disabled={busy} onClick={() => void createSignals()}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
                Create model signals ({creatable.length})
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
      <Box data-testid="connect-address-sources" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', flex: 1 }}>Addresses</Typography>
        {canFill && (
          <Tooltip title={opsMissing ? CONNECT_OPS_REQUIRED_MESSAGE
            : 'Browse the controller and fill in the address of every model signal whose name is exactly a controller symbol. Existing addresses are kept; you confirm a preview first.'}>
            <span>
              <Button size="small" variant="outlined" disabled={busy || opsMissing} onClick={() => setFillOpen(true)}
                data-testid="connect-fill-addresses"
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
                Fill addresses from controller
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={opsMissing ? CONNECT_OPS_REQUIRED_MESSAGE
          : 'Import a CSV / TSV table name;address[;dataType[;topic]] — every row is checked, valid rows are written in one batch.'}>
          <span>
            <Button size="small" disabled={busy || opsMissing} onClick={() => setImportOpen(true)}
              data-testid="connect-import-address-table"
              sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
              Import address table
            </Button>
          </span>
        </Tooltip>
      </Box>
      {legacyProtocol && (
        <Box data-testid="connect-legacy-adopt" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', flex: 1 }}>Legacy migration</Typography>
          <Tooltip title="Seed missing addresses from the legacy sources (comment prefix, Unity Metadata). Merge-only: an address this interface already has is never overwritten, and nothing is removed.">
            <span>
              <Button size="small" disabled={busy} onClick={() => void adoptLegacy()}
                sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, py: 0, px: 0.75 }}>
                Adopt legacy addresses
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}
      {fillOpen && <FillAddressesDialog open={fillOpen} onClose={() => setFillOpen(false)} iface={iface} />}
      {importOpen && <AddressTableImportDialog open={importOpen} onClose={() => setImportOpen(false)} iface={iface} />}
      {error && (
        <Typography sx={{ fontSize: 10, color: ISA_RED, lineHeight: 1.4 }}>{error}</Typography>
      )}
      {report && (
        <Box sx={{ mt: 0.25 }}>
          {RECONCILE_CATEGORIES.map((c) => {
            const entries = report.entries.filter((e) => e.category === c);
            return entries.length === 0 ? null : <CategoryList key={c} category={c} entries={entries} />;
          })}
        </Box>
      )}
      {snap.autoMapReport?.interfaceId === iface.id && snap.autoMapReport.hints.map((h) => (
        <Typography key={h} sx={{ fontSize: 10, color: ISA_AMBER, lineHeight: 1.4, mt: 0.25 }}>{h}</Typography>
      ))}
    </Box>
  );
}
