// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Shared statistics window. Only the visible rows section owns a polling timer. */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Switch, Tab, Tabs, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { UISlotProps } from '../rv-ui-plugin';
import { FloatingPanel } from '../hmi/FloatingPanel';
import { InspectorRow } from '../hmi/rv-inspector-row';
import { InspectorSubheader } from '../hmi/rv-inspector-blocks';
import { formatDecimal } from '../hmi/rv-number-format';
import { FS, INK_LOW, MONO } from '../hmi/shared-sx';
import type { StatsRegistry, StatsRow, StatsSectionSpec, StatsSetting } from './rv-stats-registry';
import {
  closeStatsHub, getStatsHubSnapshot, subscribeStatsHub, setStatsHubSection,
  getStatsHubGroupBy, setStatsHubGroupBy,
} from './stats-hub-store';

const noSubscription = () => () => {};

function SettingSwitch({ registry, section, setting }: {
  registry: StatsRegistry; section: StatsSectionSpec; setting: StatsSetting;
}) {
  const [revision, refresh] = useState(0);
  const get = useCallback(() => setting.get(), [setting, revision]);
  const checked = useSyncExternalStore(setting.subscribe ?? noSubscription, get);
  return <InspectorRow label={setting.label} alignField="end">
    <Switch size="small" checked={checked} slotProps={{ input: { role: 'switch', 'aria-label': setting.label } as never }}
      onChange={(_, value) => { registry.setSetting(section, setting, value); refresh(v => v + 1); }} />
  </InspectorRow>;
}

function RowsSection({ section }: { section: StatsSectionSpec }) {
  const [rows, setRows] = useState<readonly StatsRow[]>([]);
  useSyncExternalStore(subscribeStatsHub, getStatsHubSnapshot);
  const grouped = getStatsHubGroupBy(section.id);
  useEffect(() => {
    const refresh = () => setRows([...(section.rows?.() ?? [])]);
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [section]);
  const groups = new Map<string | undefined, StatsRow[]>();
  for (const row of rows) {
    const group = grouped ? row.group : undefined;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(row);
  }
  if (rows.length === 0) return <Typography role="status" variant="caption"
    sx={{ color: 'text.secondary', px: 1, pb: 0.5 }}>No values yet — start the simulation to collect statistics.</Typography>;
  return <>
    {rows.some(row => row.group !== undefined) && <InspectorRow label="Group rows" alignField="end">
      <Switch size="small" checked={grouped} slotProps={{ input: { role: 'switch', 'aria-label': 'Group rows' } as never }}
        onChange={(_, value) => setStatsHubGroupBy(section.id, value)} />
    </InspectorRow>}
    <Table size="small" aria-label={`${section.title} statistics`} sx={{
      '& .MuiTableCell-root': { fontSize: FS.body, py: 0.5, px: 1 },
      '& .MuiTableCell-head': { fontSize: FS.micro, color: INK_LOW, textTransform: 'uppercase' },
    }}>
      <TableHead><TableRow><TableCell>Label</TableCell><TableCell align="right">Value</TableCell><TableCell>Unit</TableCell></TableRow></TableHead>
      <TableBody>{[...groups].map(([group, members]) => <Fragment key={group === undefined ? 'ungrouped' : `group:${group}`}>
        {grouped && <TableRow><TableCell colSpan={3}><InspectorSubheader>{group ?? 'Ungrouped'}</InspectorSubheader></TableCell></TableRow>}
        {members.map(row => <TableRow key={row.key} title={row.owner}>
          <TableCell>{row.label}</TableCell>
          <TableCell align="right" sx={{ fontFamily: MONO }}>{typeof row.value === 'number' ? formatDecimal(row.value) : row.value ?? '—'}</TableCell>
          <TableCell>{row.unit}</TableCell>
        </TableRow>)}
      </Fragment>)}</TableBody>
    </Table>
  </>;
}

export function StatsHubWindow({ viewer }: UISlotProps) {
  const registry = viewer.stats;
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const { open, activeSection } = useSyncExternalStore(subscribeStatsHub, getStatsHubSnapshot);
  const sections = registry.available();
  const previous = useRef<readonly StatsSectionSpec[]>([]);
  const id = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // Capture focus before React removes the old tab DOM.
  const focusInTabs = tabsRef.current?.contains(document.activeElement);
  const focusedTab = focusInTabs
    ? document.activeElement?.getAttribute('data-section-id') : null;
  const restoreTabFocus = focusInTabs &&
    (sections.length < 2 || (focusedTab != null && !sections.some(section => section.id === focusedTab)));
  let active = sections.find(section => section.id === activeSection);
  if (!active) {
    // If a live tab disappeared, continue forwards through the previous tab order.
    const oldIndex = previous.current.findIndex(section => section.id === activeSection);
    const nextIds = oldIndex < 0 ? [] : previous.current.slice(oldIndex + 1).map(section => section.id);
    active = nextIds.map(nextId => sections.find(section => section.id === nextId)).find(Boolean) ?? sections[0];
  }
  const selected = active?.id ?? null;
  useLayoutEffect(() => {
    if (!open || !restoreTabFocus) return;
    const target = sections.length >= 2
      ? tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      : bodyRef.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    target?.focus();
  });
  useEffect(() => {
    previous.current = sections;
    if (sections.length === 0) {
      if (open) closeStatsHub();
      return;
    }
    if (selected !== activeSection) setStatsHubSection(selected);
  }, [registry, version, open, activeSection, selected]);

  return <FloatingPanel open={open && !!active} onClose={closeStatsHub} title="Statistics"
    role="region" aria-label="Statistics" panelId="stats-hub" defaultWidth={560} defaultHeight={440} minWidth={360}>
    <Box ref={bodyRef} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {sections.length >= 2 && <Tabs ref={tabsRef} sx={{ minHeight: 32, '& .MuiTab-root': { minHeight: 32, fontSize: FS.label, fontWeight: 700, textTransform: 'none' } }} value={selected} onChange={(_, value: string) => setStatsHubSection(value)}
        aria-label="Statistics sections" variant="scrollable" scrollButtons="auto" selectionFollowsFocus>
        {sections.map((section, index) => <Tab key={section.id} value={section.id} data-section-id={section.id} label={section.title}
          id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} />)}
      </Tabs>}
      {sections.map((section, index) => {
        const isActiveTab = section.id === selected;
        const Body = section.Body;
        return <Box key={section.id} role="tabpanel" tabIndex={-1} id={`${id}-panel-${index}`}
          aria-labelledby={sections.length >= 2 ? `${id}-tab-${index}` : undefined}
          aria-label={sections.length === 1 ? section.title : undefined} hidden={!isActiveTab}
          sx={{ display: isActiveTab ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto', p: 1 }}>
          {open && isActiveTab && section.description &&
            <Typography variant="caption" sx={{ color: 'text.secondary', px: 1, pb: 0.5 }}>{section.description}</Typography>}
          {open && isActiveTab && section.settings?.map(setting =>
            <SettingSwitch key={setting.id} registry={registry} section={section} setting={setting} />)}
          {Body && <Body viewer={viewer} active={open && isActiveTab} />}
          {section.rows && open && isActiveTab && <RowsSection key={section.id} section={section} />}
        </Box>;
      })}
    </Box>
  </FloatingPanel>;
}
