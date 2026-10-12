# Inspector UI rules (realvirtual WEB)

These rules keep the Property Inspector one piece. They are enforced by tests,
not by taste: a new local colour, font size, pixel column, `type="number"` input
or German UI string in an inspector file makes `npm run test:all` fail.

The brand and the full visual system ("The Glass Control Room": glass tiers,
Instrument Blue, monospace values) live in the private sibling
`../realvirtual-WebViewer-Private~/DESIGN.md`. Without it, the code is the
authority: `src/core/hmi/theme.ts` and `src/core/hmi/shared-sx.ts`. This file
covers the inspector only.

## 1. Build inspector UI from the four building blocks

| Block | File | Use it for |
|-------|------|------------|
| `InspectorRow` | `src/core/hmi/rv-inspector-row.tsx` | Every label → value row: editable field, read-only value, status pill, message. Props: `dot` (override/state gutter), `trailing` (icon button right of the field), `labelTitle` (tooltip), `labelColor`, `fullWidthField` (composite editors only). |
| `InspectorSubheader` | `src/core/hmi/rv-inspector-blocks.tsx` | The one group heading inside a component section (micro size, uppercase, Ink Low). `accent` tints it for a state band (Runtime Status, Transform). |
| `InspectorActionRow` | `src/core/hmi/rv-inspector-blocks.tsx` | Buttons. A pure layout wrapper: the buttons start on the value column. Keep your existing buttons inside it (`CommandActionButton` keeps its command logic); style new ones with `inspectorActionButtonSx`. |
| `DetailsDisclosure` | `src/core/hmi/rv-inspector-blocks.tsx` | Technical metadata a user rarely needs (hashes, GUIDs, package facts): collapsed by default, title + one-line summary. |

A custom field renderer (`fieldRendererRegistry`) renders its rows with these
blocks too — never its own flex rows with hand-made label widths.

### Component actions: section menu and segmented actions (plan-514)

Two more blocks in `src/core/hmi/rv-inspector-blocks.tsx` draw the actions a
plugin registers with `componentActionRegistry`. The section picks them from
the action's `placement`, `danger` and `group` fields — you do not render them
yourself.

| Block | Use it for |
|-------|------------|
| `InspectorSectionMenu` ("Section menu") | The ⋮ button in a section header. **Component management only**: Replace…, Re-import…, Remove (`placement: 'menu'`). Normal items first, then a divider, destructive items (`danger: true`) last and in the theme's error red. The button carries `aria-haspopup="menu"` and `aria-label="<Type> actions"`; Escape returns focus to it (MUI's own focus return — never override it). No visible menu action → no ⋮ button. No confirmation dialog: a removal is undone with Undo. |
| `segmentActions` + `inspectorSegmentedGroupSx` ("Segmented actions") | Consecutive body actions sharing a `group` render as ONE control on the value column: equal-width segments, joined borders, text only (Jog − \| Stop \| Jog +). A segment group is a set of **commands**; a toggle that picks one of several states stays a `ToggleButtonGroup` (`compactToggleGroupSx`). It never wraps and never overflows a 320 px inspector — `tests/browser/inspector-action-layout.browser.test.tsx`. |

Operations (Jog, Stop, Toggle) are body buttons; component management never is.
Removing a single entry of a list FIELD (e.g. a roller of `RibbonPath.Rollers`,
`ReorderableList`) is a field edit, not component management, and stays in the body.

## 2. One value column

The value column of `InspectorRow` is the only vertical edge in the inspector.
Rows, action buttons, disclosure summaries and messages start there. Do not
invent a label width (`minWidth: 72`, `width: '42%'`, `pl: '80px'`): the grid
(`inspectorGridColumns()`) owns the columns.

A message (an error, a hint, "applies after restart") is an `InspectorRow` with
an empty label and the text in the value column; it wraps, it never scrolls the
inspector sideways.

## 3. Design values — import, never re-declare

From `src/core/hmi/shared-sx.ts`:

- Text: `INK_HIGH` (values), `INK_MID` (descriptions, messages), `INK_LOW`
  (labels, hints, units, subheaders).
- Lines and fields: `DIVIDER`, `ROW_HOVER`, `FIELD_BG`, `FIELD_BORDER`,
  `FIELD_BORDER_HOVER`, `inspectorInputSx`.
- Accents: `ACCENT`, `SUCCESS`, `WARN`, `ERROR` (the theme palette is built from
  them). State colours of a component come from that component's own table
  (e.g. `FMU_STATE_COLORS`).
- Semantic colours (plan-514):

  | Token | Value | Use |
  |-------|-------|-----|
  | `LINK` | `#64b5f6` | Interactive references: node links in Knowledge / Metadata, instruction targets, the Transform band, the detached inspector title |
  | `WARN_LIGHT` | `#ffb74d` | A lightened warning: hover of a warning control, "Live-controlled" |
  | `OCCUPIED` | `#e8b04a` | A sensor sees an MU, a snap port is paired — its own semantic, not a warning |
  | `LIVE` | `#4dd0e1` | A behaviour's runtime state while it runs |
  | `NEUTRAL` | `#808080` | Unbound / unknown state |
  | `ON_ACCENT` | `#ffffff` | Text and icons on a filled accent surface |

  A translucent tint of a token is written as a hex-alpha suffix on the token
  (`` `${ACCENT}2e` ``), never as a new `rgba()` literal.
- Type scale: `FS.micro` 10, `FS.label` 11, `FS.body` 12, `FS.title` 14 — no
  other sizes. Icons: `ICON_SIZE.*`. Values, hashes, GUIDs: `MONO`.

## 4. Numbers

- Inputs are `NumberEditor` / `DragNumberField`: a text input with
  `inputMode="decimal"`, never `type="number"`.
- Comma and dot are both decimal separators (`9,81` is 9.81); there are no
  thousands separators (`1.000,5` is invalid, the field turns red and blur
  restores the last valid value). Parse with `parseDecimal`
  (`src/core/hmi/rv-number-format.ts`).
- Display is always a dot. Read-only values go through `formatDecimal` (trims
  float noise); an editable draft stays `String(value)` so an untouched field
  never commits a rounded value.
- Units are written with superscripts: `m/s²`, `m²`, `m³` (`formatUnit`).

## 5. Where things go

- A component's runtime state belongs in its section header (the header value
  of `getPrimaryDisplayValue`, coloured by `getSignalHeaderColor`) — not as a
  second headline inside the section.
- An override is the row's `dot` (click = reset), not a chip or a button.
- Technical metadata goes into a collapsed `DetailsDisclosure`.
- Configuration fields first, then runtime, then parameters, then details.

## 6. Language

The UI is English. `tests/ui-language.node.test.ts` scans every string literal
and JSX text under `src/` for German. Old texts outside the inspector are frozen
in `tests/fixtures/ui-language-allowlist.json`; that list only shrinks.

## 7. The guardrails and their baseline

- ESLint rule `rv/hmi-design` (`eslint.config.js`, `HMI_DESIGN_SCOPE`): no hex /
  `rgba()` literals, no numeric `fontSize`, no `'NNpx'` or percentage columns,
  no `type="number"` in the inspector files. Enforced by
  `tests/hmi-design-lint.node.test.ts`, which runs in `npm run test:node` and
  therefore `npm run test:all` (`npm test` alone does not run it).
- Existing violations were frozen in `eslint-suppressions.json`. Since plan-514
  the inspector baseline is **empty** (`{}`, `SUPPRESSION_CEILING = { files: 0,
  total: 0 }`): every design violation in a scope file is an error. The file
  stays for later waves; the baseline **only shrinks** — fix violations, then
  run `npm run lint:prune` and lower `SUPPRESSION_CEILING` to the new measurement.
- **Never** regenerate the baseline (`npm run lint:baseline` was the one-time
  bootstrap), never add an entry, never raise `SUPPRESSION_CEILING` or
  `ALLOWLIST_CEILING` — not without the user's explicit approval. Fix the code
  instead.

## 8. Reference page

`?rvDev=inspector-gallery` on the dev server (`npm run dev`) shows every block
in every state (long label, override dot, error row, disabled action, open and
closed disclosure, number field with unit and range, a segmented action group
with and without a disabled segment, and the open section menu with its danger
item). It is development-only
and never part of a production build.
