// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Section primitive — controlled/uncontrolled contract (plan-405 §9.3).
 *
 * `Section` is the most-used primitive in the editor's docked panels (13 call
 * sites across KinematicsPanel, MaterialsPanel and MechanismSection), and none
 * of its consumers has a render test of its own. plan-405 adds an optional
 * controlled `open` prop to it, so the regression risk is concentrated in one
 * question: does a caller that passes NOTHING new still behave exactly as
 * before? That is the first block below; the controlled form is the second.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { Section } from '@rv-private/plugins/asset-editor/panel-primitives';

afterEach(cleanup);

/** The clickable header row — the caption's parent Box carries the onClick. */
function header(container: HTMLElement): HTMLElement {
  return container.querySelector('.MuiTypography-caption')!.parentElement as HTMLElement;
}

/**
 * The header chevron, not the Collapse class: MUI applies `MuiCollapse-hidden`
 * only when the exit TRANSITION finishes, which makes it a timing assertion.
 * The icon is rendered straight from the open state, synchronously.
 */
function isExpanded(container: HTMLElement): boolean {
  return container.querySelector('[data-testid="ExpandMoreIcon"]') !== null;
}

describe('Section — uncontrolled (unchanged behaviour)', () => {
  it('starts open by default and collapses on click', () => {
    const { container } = render(<Section title="Kinematics"><div>body</div></Section>);
    expect(screen.getByText('Kinematics')).toBeTruthy();
    expect(isExpanded(container)).toBe(true);

    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(false);

    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(true);
  });

  it('honours defaultOpen={false}', () => {
    const { container } = render(
      <Section title="Mechanism" defaultOpen={false}><div>body</div></Section>,
    );
    expect(isExpanded(container)).toBe(false);
    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(true);
  });

  it('still toggles itself when only onOpenChange is given (no open prop)', () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Section title="Materials" defaultOpen={false} onOpenChange={onOpenChange}>
        <div>body</div>
      </Section>,
    );
    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(true);       // uncontrolled state still moves
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('a headerAction click does not toggle the section', () => {
    const { container } = render(
      <Section title="Kinematics" headerAction={<button type="button">act</button>}>
        <div>body</div>
      </Section>,
    );
    fireEvent.click(screen.getByText('act'));
    expect(isExpanded(container)).toBe(true);
  });
});

describe('Section — controlled', () => {
  it('renders the state the open prop dictates and does NOT self-toggle', () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Section title="Mechanism" open={false} onOpenChange={onOpenChange}>
        <div>body</div>
      </Section>,
    );
    expect(isExpanded(container)).toBe(false);

    fireEvent.click(header(container));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // The parent has not updated the prop, so the section must stay put —
    // otherwise the 3D overview and the panel would disagree about "open".
    expect(isExpanded(container)).toBe(false);
  });

  it('follows the parent when the parent updates the prop', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <Section title="Mechanism" open={open} onOpenChange={setOpen}>
          <div>body</div>
        </Section>
      );
    }
    const { container } = render(<Host />);
    expect(isExpanded(container)).toBe(false);

    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(true);

    fireEvent.click(header(container));
    expect(isExpanded(container)).toBe(false);
  });

  it('open={true} wins over a contradicting defaultOpen={false}', () => {
    const { container } = render(
      <Section title="Mechanism" defaultOpen={false} open={true}><div>body</div></Section>,
    );
    expect(isExpanded(container)).toBe(true);
  });
});
