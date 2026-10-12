// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InspectorGallery — DEV-ONLY reference page of the Inspector building blocks
 * (plan-510, DESIGN.md). Every block in every state on one 320-px inspector
 * column, so a new inspector section can be compared against the canon.
 *
 * Opened with `?rvDev=inspector-gallery` on the dev server only. It is reached
 * exclusively through the `import.meta.env.DEV`-gated dynamic import in
 * `main.ts` → `mount-inspector-gallery.ts`; a production build contains none of
 * it (tests/inspector-gallery-gate.node.test.ts + the build marker check).
 */

import { useState } from 'react';
import { Box, Button, Chip, IconButton, Tooltip, Typography } from '@mui/material';
import { Circle, Delete, SwapHoriz } from '@mui/icons-material';
import { InspectorRow } from '../rv-inspector-row';
import {
  DetailsDisclosure, InspectorActionRow, InspectorSectionMenu, InspectorSubheader,
  inspectorActionButtonSx, inspectorSegmentedGroupSx,
} from '../rv-inspector-blocks';
import type { ComponentAction, ComponentActionContext } from '../rv-component-action-registry';
import { BooleanEditor, EnumEditor, NumberEditor, StringEditor } from '../rv-field-editors';
import { formatUnit } from '../rv-number-format';
import { ACCENT, DIVIDER, ERROR, FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID, MONO, SUCCESS, WARN } from '../shared-sx';

/** Stable marker string that must NOT appear in a production bundle (plan-510 §9.6). */
export const INSPECTOR_GALLERY_MARKER = 'rv-inspector-gallery-marker';

const valueSx = { fontSize: FS.label, color: INK_HIGH, fontFamily: MONO } as const;
const messageSx = { fontSize: FS.label, color: INK_MID, whiteSpace: 'normal', overflowWrap: 'anywhere' } as const;

/** Gallery-local menu actions — NOT registered anywhere (the gallery registers nothing). */
const GALLERY_MENU_ACTIONS: readonly ComponentAction[] = [
  { id: 'replace', label: 'Replace FMU…', icon: SwapHoriz, placement: 'menu', onClick: () => {} },
  { id: 'reimport', label: 'Re-import…', placement: 'menu', onClick: () => {} },
  { id: 'remove', label: 'Remove', icon: Delete, placement: 'menu', danger: true, onClick: () => {} },
];
/** The menu only reads `componentType` for its aria-label; the callbacks above ignore the ctx. */
const GALLERY_CTX = { componentType: 'Fmu' } as unknown as ComponentActionContext;

function OverrideDot({ onReset }: { onReset: () => void }) {
  return (
    <IconButton size="small" onClick={onReset} title="Reset to default" sx={{ width: 20, height: 20, p: 0, color: ACCENT }}>
      <Circle sx={{ fontSize: ICON_SIZE.dot }} />
    </IconButton>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <Box sx={{ borderTop: `1px solid ${DIVIDER}` }}>
      <Box sx={{ px: 1, py: 0.375, display: 'flex', alignItems: 'center' }}>
        <Typography sx={{ fontSize: FS.label, fontWeight: 700, color, letterSpacing: 0.5, textTransform: 'uppercase' }}>{title}</Typography>
        <Typography sx={{ fontSize: FS.label, fontWeight: 600, fontFamily: MONO, ml: 'auto', color: SUCCESS }}>running</Typography>
      </Box>
      <Box sx={{ py: 1 }}>{children}</Box>
    </Box>
  );
}

/** The gallery itself — every block in every state. */
export function InspectorGallery() {
  const [speed, setSpeed] = useState(100);
  const [g, setG] = useState(-9.81);
  const [e, setE] = useState(0.7);
  const [overridden, setOverridden] = useState(true);
  const [flag, setFlag] = useState(true);
  const [dir, setDir] = useState('LinearX');
  const [name, setName] = useState('Conveyor_01');

  return (
    <Box data-rv={INSPECTOR_GALLERY_MARKER} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography sx={{ fontSize: FS.title, fontWeight: 600, color: INK_HIGH }}>Inspector building blocks</Typography>
      <Typography sx={{ fontSize: FS.body, color: INK_MID, maxWidth: 520 }}>
        Reference for new inspector UI (DESIGN.md): rows, subheaders, action rows and disclosures on one value
        column, design values from shared-sx.ts. Dev server only.
      </Typography>

      <Box sx={{ width: 320, bgcolor: 'background.paper', borderRadius: 1 }}>
        <Section title="InspectorRow" color={ACCENT}>
          <InspectorRow label="TargetSpeed" labelTitle="TargetSpeed">
            <NumberEditor value={speed} onChange={setSpeed} unit="mm/s" ariaLabel="TargetSpeed" />
          </InspectorRow>
          <InspectorRow
            label="g"
            labelTitle="Gravity acceleration — applies after restart"
            labelColor={INK_MID}
            dot={overridden ? <OverrideDot onReset={() => setOverridden(false)} /> : undefined}
          >
            <NumberEditor value={g} onChange={(v) => { setG(v); setOverridden(true); }} unit={formatUnit('m/s2')} ariaLabel="g" />
          </InspectorRow>
          <InspectorRow label="e" labelTitle="Coefficient of restitution" labelColor={INK_MID}>
            <NumberEditor value={e} onChange={setE} min={0.5} max={1} ariaLabel="e" />
          </InspectorRow>
          <InspectorRow label="A very long field label that must be truncated with an ellipsis" labelTitle="A very long field label that must be truncated with an ellipsis">
            <StringEditor value={name} onChange={setName} />
          </InspectorRow>
          <InspectorRow label="Active">
            <BooleanEditor value={flag} onChange={setFlag} />
          </InspectorRow>
          <InspectorRow label="Direction">
            <EnumEditor value={dir} onChange={setDir} options={['LinearX', 'LinearY', 'LinearZ']} />
          </InspectorRow>
          <InspectorRow label="Read-only" labelColor={INK_LOW}>
            <Typography sx={{ ...valueSx, color: INK_LOW }}>0.3</Typography>
          </InspectorRow>
          <InspectorRow label="SignalStart" labelColor={INK_LOW}>
            <Chip size="small" label="Cell.Start ● linked" sx={{ height: 18, fontSize: FS.micro, color: ACCENT, border: `1px solid ${ACCENT}`, bgcolor: 'transparent' }} />
          </InspectorRow>
          <InspectorRow label="SignalEnded" labelColor={INK_LOW}>
            <Typography sx={{ fontSize: FS.label, color: INK_LOW }}>unlinked</Typography>
          </InspectorRow>
          <InspectorRow label="">
            <Typography sx={{ ...messageSx, color: ERROR }}>
              Error row: a long message wraps inside the value column and never scrolls the inspector sideways.
            </Typography>
          </InspectorRow>
        </Section>

        <Section title="InspectorSubheader" color={ACCENT}>
          <InspectorSubheader>Parameters</InspectorSubheader>
          <InspectorSubheader accent={WARN} trailing={<Typography sx={{ fontSize: FS.micro, color: WARN }}>waiting</Typography>}>
            Runtime status (accent)
          </InspectorSubheader>
        </Section>

        <Section title="InspectorActionRow" color={ACCENT}>
          <InspectorRow label="Status" labelColor={INK_LOW}>
            <Chip size="small" label="running · CONNECT" sx={{ height: 18, fontSize: FS.micro, color: SUCCESS, border: `1px solid ${SUCCESS}`, bgcolor: 'transparent' }} />
          </InspectorRow>
          <InspectorActionRow>
            <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Stop</Button>
            <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Re-provision</Button>
            <Tooltip title="Disabled: the reason is the tooltip">
              <span style={{ display: 'inline-flex' }}>
                <Button size="small" variant="outlined" disabled sx={inspectorActionButtonSx}>Trust & start</Button>
              </span>
            </Tooltip>
          </InspectorActionRow>
        </Section>

        <Section title="Segmented actions" color={ACCENT}>
          <InspectorActionRow>
            <Box sx={inspectorSegmentedGroupSx}>
              <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Jog −</Button>
              <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Stop</Button>
              <Button size="small" variant="contained" sx={inspectorActionButtonSx}>Jog +</Button>
            </Box>
          </InspectorActionRow>
          <InspectorActionRow>
            <Box sx={inspectorSegmentedGroupSx}>
              <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Jog −</Button>
              <Tooltip title="Disabled: the reason is the tooltip">
                <span style={{ display: 'inline-flex' }}>
                  <Button size="small" variant="outlined" disabled sx={inspectorActionButtonSx}>Stop</Button>
                </span>
              </Tooltip>
              <Button size="small" variant="outlined" sx={inspectorActionButtonSx}>Jog +</Button>
            </Box>
          </InspectorActionRow>
        </Section>

        <Box sx={{ borderTop: `1px solid ${DIVIDER}` }}>
          <Box sx={{ px: 1, py: 0.375, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: FS.label, fontWeight: 700, color: ACCENT, letterSpacing: 0.5, textTransform: 'uppercase' }}>Section menu (open)</Typography>
            <Box sx={{ ml: 'auto' }}>
              <InspectorSectionMenu actions={GALLERY_MENU_ACTIONS} ctx={GALLERY_CTX} onAfterClick={() => {}} defaultOpen />
            </Box>
          </Box>
          <InspectorRow label="" labelColor={INK_LOW}>
            <Typography sx={messageSx}>
              Component management only: normal items first, then a divider, destructive items last and red.
            </Typography>
          </InspectorRow>
        </Box>

        <Section title="DetailsDisclosure" color={ACCENT}>
          <DetailsDisclosure title="Package details" summary="BouncingBall · 188.5 kB">
            <InspectorRow label="Model" labelColor={INK_LOW}><Typography sx={valueSx}>BouncingBall</Typography></InspectorRow>
            <InspectorRow label="SHA-256" labelColor={INK_LOW}><Typography sx={valueSx}>1f3a9c02…77be</Typography></InspectorRow>
          </DetailsDisclosure>
          <DetailsDisclosure title="Open by default" summary="2 rows" defaultOpen>
            <InspectorRow label="GUID" labelColor={INK_LOW}><Typography sx={valueSx}>{'{8c4e810f…4d23}'}</Typography></InspectorRow>
            <InspectorRow label="FMI" labelColor={INK_LOW}><Typography sx={valueSx}>2.0</Typography></InspectorRow>
          </DetailsDisclosure>
        </Section>
      </Box>
    </Box>
  );
}
