// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { useEffect, useState } from 'react';
import { MenuItem, Select } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { InspectorRow } from './rv-inspector-row';
import { InspectorSubheader } from './rv-inspector-blocks';
import { DragNumberField } from './DragNumberField';
import { BooleanEditor, EnumEditor } from './rv-field-editors';
import { parseDecimal } from './rv-number-format';
import { BudgetResolver, type BlockageBudget } from '../diagnostics/rv-blockage-budget';
import { WaitRegistry } from '../diagnostics/rv-wait-registry';
import { inspectorInputSx } from './shared-sx';

const fallbackBudgets = new BudgetResolver(), fallbackWaits = new WaitRegistry();
const labels: Record<string, string> = { MaxWaitSec: 'Max Wait', MaxIdleSec: 'Max Idle', WarmupSec: 'Warmup',
  ExpectedWaits: 'Expected Waits', ExpectFlow: 'Expect Flow', Exempt: 'Exempt', Scope: 'Scope', Severity: 'Severity' };
export function BlockageBudgetFieldRenderer({ value, fieldName, nodePath, viewer, onEdit }: FieldRendererProps) {
  const resolver = viewer?.blockageBudgets ?? fallbackBudgets;
  const node = viewer?.registry?.getNode(nodePath);
  const effective = resolver.resolve(node ?? nodePath);
  const inherited = resolver.resolve(node ?? nodePath, true);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => setDraft(value == null ? '' : String(value)), [value]);
  const label = labels[fieldName] ?? fieldName;
  if (['MaxWaitSec', 'MaxIdleSec', 'WarmupSec'].includes(fieldName)) {
    const key = fieldName as 'MaxWaitSec' | 'MaxIdleSec' | 'WarmupSec';
    const parsed = draft.trim() === '' ? inherited[key] : parseDecimal(draft);
    const error = parsed === null ? 'Enter a finite number.'
      : key === 'WarmupSec' && parsed < 0 ? 'Warmup must be at least 0 s.'
      : key !== 'WarmupSec' && parsed <= 0 ? 'The budget must be greater than 0 s.'
      : key === 'MaxIdleSec' && parsed < effective.MaxWaitSec ? 'Max Idle must be at least Max Wait.'
      : key === 'MaxWaitSec' && parsed > effective.MaxIdleSec ? 'Max Wait must not exceed Max Idle.' : '';
    return <>
      {key === 'MaxWaitSec' && <InspectorSubheader>Budget</InspectorSubheader>}
      <InspectorRow label={label}>
        <DragNumberField compact value={draft} onValueChange={setDraft}
          onCommit={() => { if (!error) onEdit?.(draft.trim() === '' ? null : parsed); }}
          unit="s" min={0} max={Number.MAX_SAFE_INTEGER} step={0.1} ariaLabel={label}
          placeholder={`${inherited[key]} s (${inherited.sources[key]})`} error={!!error} />
      </InspectorRow>
      {error && <InspectorRow label=""><span role="alert">{error}</span></InspectorRow>}
    </>;
  }
  if (fieldName === 'ExpectedWaits') {
    const kinds = viewer?.waitRegistry?.knownWaitKinds() ?? fallbackWaits.knownWaitKinds();
    const selected = Array.isArray(value) ? value as string[] : effective.ExpectedWaits;
    return <><InspectorSubheader>Expected waits</InspectorSubheader><InspectorRow label={label}>
      <Select multiple size="small" value={[...selected]} sx={inspectorInputSx}
        inputProps={{ 'aria-label': label }} onChange={e => onEdit?.(e.target.value)}>
        {kinds.map(kind => <MenuItem key={kind} value={kind}>{kind}</MenuItem>)}
      </Select>
    </InspectorRow></>;
  }
  if (fieldName === 'Exempt' || fieldName === 'ExpectFlow') return <>
    <InspectorRow label={label}><BooleanEditor value={value == null ? effective[fieldName] : value === true}
      onChange={v => onEdit?.(v)} ariaLabel={label} /></InspectorRow>
    <InspectorRow label="">{fieldName === 'Exempt' ? 'Exclude this subtree from blockage checks.' : 'Sinks in this scope must keep delivering while the run is active.'}</InspectorRow>
  </>;
  const options = fieldName === 'Scope' ? ['node', 'subtree'] : ['error', 'warning', 'info'];
  return <InspectorRow label={label}><EnumEditor value={String(value ?? effective[fieldName as keyof BlockageBudget])}
    options={options} onChange={v => onEdit?.(v)} ariaLabel={label} /></InspectorRow>;
}
for (const fieldName of Object.keys(labels)) fieldRendererRegistry.register({
  componentType: 'BlockageBudget', fieldName, component: BlockageBudgetFieldRenderer,
});
// Signal fields deliberately use ComponentSignalSlots in the containing section:
// the standard ComponentReference drag targets and binding persistence.
