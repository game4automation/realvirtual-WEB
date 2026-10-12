// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * OperatorPanel (plan-542 F9) — a station's operator panel from a JSON config.
 *
 * Everything that is not the station lives here: the signal subscription
 * ({@link OperatorPanelPlugin}), the window (a {@link ControlWindow} on the
 * plate surface), the title bar (SIM/PLC chip, the config's chips, the stack
 * light, the mini E-stop while collapsed), the status strip with the restart
 * steps and the device grid. A station panel is pure data: normally a
 * `WebOperatorPanel` component in the model (plan-543), rendered by the
 * generic host `WebOperatorPanelHost`; code may still register a config
 * directly:
 *
 *   viewer.use(new OperatorPanelPlugin(config));
 *
 * The SIGNALS are the truth. Every device writes the input a PLC reads and
 * shows the output the PLC writes; the window keeps no state of its own — a
 * forced signal, an MCP write or a simulation reset shows up the same tick.
 * An invalid config, or one naming signals the model lacks, renders its
 * validation errors in the window instead of working controls.
 */

import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { Box } from '@mui/material';
import {
  CheckCircleOutline, ErrorOutline, HourglassEmpty, InfoOutlined, LockOutlined, PlayCircleOutline,
  WarningAmberOutlined,
} from '@mui/icons-material';
import type { UISlotEntry, UISlotProps } from '../../rv-ui-plugin';
import { RVBehavior } from '../../rv-behavior';
import { ControlWindow } from '../ControlWindow';
import {
  CHIP_RADIUS, ERROR, FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID, SUCCESS, WARN,
} from '../shared-sx';
import { EmergencyStop } from './EmergencyStop';
import { IlluminatedPushButton } from './IlluminatedPushButton';
import { SelectorSwitch } from './SelectorSwitch';
import { StackLight } from './StackLight';
import {
  evaluateCondition, OFFLINE_SNAPSHOT, OperatorPanelController, resolveStatus,
  type OperatorPanelConfig, type OperatorPanelSnapshot, type OperatorPanelSource, type PanelLampConfig,
  type PanelStatusRule, type SignalReader, type StatusIcon, type StatusTone,
} from './operator-panel-model';

// ─── Plugin (one window per config) ────────────────────────────────────

export type { OperatorPanelSnapshot } from './operator-panel-model';

/**
 * One window per config, as a viewer plugin: an {@link OperatorPanelController}
 * started on model load and stopped on clear, and an overlay slot whose
 * component reads the plugin by id. (A config carried by the model itself is
 * the `WebOperatorPanel` component's job — no plugin needed.)
 */
export class OperatorPanelPlugin extends RVBehavior implements OperatorPanelSource {
  readonly id: string;
  readonly slots: UISlotEntry[];
  readonly controller: OperatorPanelController;

  constructor(rawConfig: unknown) {
    super();
    this.controller = new OperatorPanelController(rawConfig);
    this.id = this.controller.id;
    const id = this.id;
    const Slot = (props: UISlotProps) => <OperatorPanel {...props} panelId={id} />;
    // A visibilityId and deliberately NO rule: the window is how the station
    // is operated, so it stays in every mode, the plain viewer included.
    this.slots = [{ slot: 'overlay', component: Slot, order: 100, visibilityId: id }];
  }

  /** The validated config, or null when its structure is invalid. */
  get config(): OperatorPanelConfig | null { return this.controller.config; }

  /** Every signal the panel reads or writes. */
  get signalNames(): readonly string[] { return this.controller.signalNames; }

  subscribe = (listener: () => void): (() => void) => this.controller.subscribe(listener);

  getSnapshot = (): OperatorPanelSnapshot => this.controller.getSnapshot();

  /** Writes an operator input. Ignored while the panel is not ready. */
  write(signal: string, value: boolean): void { this.controller.write(signal, value); }

  protected onStart(): void {
    if (this.viewer) this.controller.start(this.viewer);
  }

  protected onDestroy(): void {
    this.controller.stop();
  }
}

// ─── Status strip ──────────────────────────────────────────────────────

const TONE: Record<StatusTone, { color: string; tint: boolean; icon: StatusIcon }> = {
  ok: { color: SUCCESS, tint: false, icon: 'check' },
  neutral: { color: INK_MID, tint: false, icon: 'hourglass' },
  action: { color: WARN, tint: true, icon: 'play' },
  fault: { color: ERROR, tint: true, icon: 'error' },
};

const ICONS: Record<StatusIcon, typeof ErrorOutline> = {
  check: CheckCircleOutline,
  hourglass: HourglassEmpty,
  play: PlayCircleOutline,
  error: ErrorOutline,
  warning: WarningAmberOutlined,
  info: InfoOutlined,
};

/**
 * One line: what the station is doing, and — while a restart is due — where in
 * the restart sequence the operator is (the steps as numbers, the current one
 * bright; the words in its tooltip and accessible name).
 */
function StatusStrip({ rule, restart }: { rule: PanelStatusRule; restart?: OperatorPanelConfig['restart'] }) {
  const tone = TONE[rule.tone];
  const Icon = ICONS[rule.icon ?? tone.icon];
  const steps = rule.step && restart ? restart.steps : null;
  return (
    <Box
      role="status"
      aria-label="Station state"
      data-state={rule.kind}
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.75, px: 1, minHeight: 26, boxSizing: 'border-box',
        borderRadius: '4px',
        bgcolor: tone.tint ? `${tone.color}24` : 'transparent',
        border: `1px solid ${tone.tint ? `${tone.color}66` : 'rgba(255,255,255,0.08)'}`,
      }}
    >
      <Icon sx={{ fontSize: ICON_SIZE.md, color: tone.color }} />
      <Box component="span" data-part="state-text" sx={{ fontSize: FS.label, lineHeight: 1.3, fontWeight: 700, letterSpacing: '0.03em', color: INK_HIGH }}>
        {rule.text}
      </Box>
      {steps && restart && (
        <Box
          role="note"
          aria-label={`Restart after a stop: step ${rule.step} of ${steps.length}, ${steps[rule.step! - 1] ?? ''}`}
          title={restart.hint}
          sx={{ ml: 'auto', display: 'flex', gap: 0.5 }}
        >
          {steps.map((step, i) => {
            const current = i + 1 === rule.step;
            return (
              <Box
                key={step}
                component="span"
                title={step}
                data-current={current ? 'true' : undefined}
                sx={{
                  width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  fontSize: FS.label, fontWeight: 700, lineHeight: 1,
                  color: current ? INK_HIGH : INK_LOW,
                  border: `1px solid ${current ? INK_HIGH : 'rgba(255,255,255,0.25)'}`,
                }}
              >
                {i + 1}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// ─── Title bar ─────────────────────────────────────────────────────────

function Chip({ children, color, label, title }: { children: ReactNode; color?: string; label: string; title?: string }) {
  return (
    <Box
      component="span"
      role="status"
      aria-label={label}
      title={title}
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.25, height: 20, px: 0.75, boxSizing: 'border-box',
        borderRadius: CHIP_RADIUS, fontSize: FS.label, fontWeight: 600, letterSpacing: '0.03em', whiteSpace: 'nowrap',
        color: color ?? INK_HIGH,
        border: `1px solid ${color ? `${color}80` : 'rgba(255,255,255,0.25)'}`,
        bgcolor: color ? `${color}1f` : 'transparent',
      }}
    >
      {children}
    </Box>
  );
}

// ─── Window ────────────────────────────────────────────────────────────

const NOOP_SUBSCRIBE = () => () => {};
const OFFLINE_GETTER = () => OFFLINE_SNAPSHOT;

export interface OperatorPanelProps extends UISlotProps {
  /** Window id (remembered position / collapsed state); also the plugin id looked up without `source`. */
  panelId: string;
  /** The panel runtime. Omitted → the {@link OperatorPanelPlugin} registered under `panelId`. */
  source?: OperatorPanelSource | null;
  /** Window title; defaults to the config's `title`. */
  title?: string;
  /** Where the window first appears; defaults to the config's `position`. */
  defaultPosition?: { x: number; y: number };
  /** Start collapsed (until the user expands it once — then the stored state wins). */
  defaultCollapsed?: boolean;
}

/** The operator window of an operator panel: a {@link OperatorPanelSource} or the plugin with id `panelId`. */
export function OperatorPanel({ viewer, panelId, source, title: titleProp, defaultPosition, defaultCollapsed }: OperatorPanelProps) {
  const plugin = source ?? viewer?.getPlugin<OperatorPanelPlugin>(panelId);
  const snap = useSyncExternalStore(plugin?.subscribe ?? NOOP_SUBSCRIBE, plugin?.getSnapshot ?? OFFLINE_GETTER);
  const config = plugin?.config ?? null;
  const title = titleProp || config?.title || 'Operator panel';

  if (!config) {
    return (
      <ControlWindow
        title={title}
        panelId={panelId}
        surface="plate"
        defaultWidth={300}
        defaultPosition={defaultPosition}
        defaultCollapsed={defaultCollapsed}
      >
        <Errors errors={snap.errors.length > 0 ? snap.errors : ['No operator panel plugin is registered under this id.']} />
      </ControlWindow>
    );
  }

  const off = !snap.ready;
  const v: SignalReader = (name) => snap.values[name] === true;
  const lamp = (l: PanelLampConfig | undefined) => l && ({
    color: l.color,
    on: v(l.signal),
    flash: !off && !!l.flashWhen && evaluateCondition(l.flashWhen, v),
    driven: l.simDriven !== false || !snap.simulated,
  });
  const plc = snap.modeLabel !== '' && !snap.modeLabel.startsWith('Simulation');
  const rule = off ? null : resolveStatus(config, v);

  const estop = (e: OperatorPanelConfig['estops'][number], size: 'full' | 'mini') => (
    <EmergencyStop
      key={`${e.label}-${size}`}
      label={e.label}
      size={size}
      value={v(e.signal)}
      normallyClosed={e.normallyClosed !== false}
      disabled={off}
      lamp={lamp(e.lamp)}
      onWrite={(value) => plugin?.write(e.signal, value)}
    />
  );

  const headerExtras = (
    <>
      <Chip label="Connection mode" title={snap.modeLabel || 'No connection mode'}>
        {plc && <LockOutlined sx={{ fontSize: ICON_SIZE.xs }} />}
        {snap.modeLabel ? (plc ? 'PLC' : 'SIM') : '—'}
      </Chip>
      {!off && (config.chips ?? []).filter((c) => evaluateCondition(c.when, v)).map((c) => (
        <Chip key={c.label} label={c.label} color={c.tone === 'neutral' ? undefined : WARN}>{c.text}</Chip>
      ))}
      {config.stackLight.length > 0 && (
        <StackLight segments={config.stackLight.map((t) => ({
          name: t.name, color: t.color, on: v(t.signal), driven: t.simDriven !== false || !snap.simulated,
        }))} />
      )}
    </>
  );

  // The device grid: every device on its cell; devices sharing a cell stack.
  const cells = new Map<string, { row: number; col: number; separated: boolean; items: ReactNode[] }>();
  const place = (row: number, col: number, node: ReactNode, separated = false) => {
    const key = `${row}:${col}`;
    const cell = cells.get(key) ?? { row, col, separated: false, items: [] };
    cell.items.push(node);
    cell.separated ||= separated;
    cells.set(key, cell);
  };
  config.buttons.forEach((b) => place(b.row, b.col, (
    <IlluminatedPushButton
      key={b.signal}
      label={b.label}
      legend={b.legend}
      cap={b.capColor}
      lamp={lamp(b.lamp)}
      disabled={off}
      onPress={() => plugin?.write(b.signal, true)}
      onRelease={() => plugin?.write(b.signal, false)}
    />
  ), b.separated));
  config.selectors.forEach((s) => place(s.row, s.col, (
    <SelectorSwitch
      key={s.signal}
      label={s.label}
      caption={s.caption}
      variant={s.variant}
      disabled={off}
      positions={[
        { id: String(s.positions[0].value), legend: s.positions[0].legend },
        { id: String(s.positions[1].value), legend: s.positions[1].legend },
      ]}
      value={off ? null : String(v(s.signal))}
      lamp={lamp(s.lamp)}
      onChange={(id) => plugin?.write(s.signal, id === 'true')}
    />
  )));
  config.estops.forEach((e) => place(e.row, e.col, estop(e, 'full')));

  return (
    <ControlWindow
      title={title}
      panelId={panelId}
      surface="plate"
      defaultWidth={config.width ?? 300}
      defaultPosition={defaultPosition ?? config.position ?? { x: 80, y: 100 }}
      defaultCollapsed={defaultCollapsed}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>{headerExtras}</Box>
      {snap.errors.length > 0 ? <Errors errors={snap.errors} /> : rule && <StatusStrip rule={rule} restart={config.restart} />}
      <Box
        data-part="device-grid"
        // Row gap 2 px: a legend box is two lines high, so rows are already apart.
        sx={{ display: 'grid', gridTemplateColumns: `repeat(${config.columns ?? 3}, minmax(0, 1fr))`, columnGap: 1, rowGap: 0.25 }}
      >
        {[...cells.values()].map((c) => (
          <Box
            key={`${c.row}:${c.col}`}
            data-cell={`${c.row}:${c.col}`}
            sx={{
              gridRow: c.row,
              gridColumn: c.col,
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.5,
              minWidth: 0,
              // A separated cell (an immediate stop) gets a hairline on its left
              // edge, drawn inside the column gap so the columns stay equal.
              '&::before': c.separated
                ? { content: '""', position: 'absolute', left: -4.5, top: 4, bottom: 4, borderLeft: '1px solid rgba(255,255,255,0.12)' }
                : undefined,
            }}
          >
            {c.items.map((item, i) => (
              // Devices sharing a cell are separate units (caption, marks and
              // knob each belong to one switch): a short hairline between them.
              <Fragment key={i}>
                {i > 0 && (
                  <Box
                    aria-hidden
                    data-part="unit-divider"
                    sx={{ width: '56%', flex: '0 0 1px', height: '1px', my: 0.5, bgcolor: 'rgba(255,255,255,0.18)' }}
                  />
                )}
                {item}
              </Fragment>
            ))}
          </Box>
        ))}
      </Box>
    </ControlWindow>
  );
}

/** Validation errors in the window: the panel says what is wrong with its config. */
function Errors({ errors }: { errors: readonly string[] }) {
  return (
    <Box role="alert" aria-label="Operator panel configuration" sx={{ display: 'flex', gap: 0.75, fontSize: FS.label, color: INK_MID }}>
      <ErrorOutline sx={{ fontSize: ICON_SIZE.md, color: WARN, flex: '0 0 auto' }} />
      <Box component="ul" sx={{ m: 0, pl: 1.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        {errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}
        {errors.length > 6 && <li>… and {errors.length - 6} more</li>}
      </Box>
    </Box>
  );
}
