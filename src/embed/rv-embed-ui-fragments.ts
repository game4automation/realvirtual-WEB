// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type {
  RVEmbedDirectorActionDetail,
  RVEmbedDirectorPoint,
  RVEmbedDirectorVector3,
} from './rv-embed-director';
import type { RVEmbedNodeTransformState, RVEmbedSignalValue } from './rv-embed-viewer';

type RVEmbedUIInteractiveMode = 'none' | 'orbit-on-click' | 'full';

export interface RVEmbedUIFragmentsHost {
  readonly element: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  getInteractiveMode(): RVEmbedUIInteractiveMode;
  subscribeSignal(name: string, callback: (value: RVEmbedSignalValue) => void): () => void;
  dragNodeByScreenDelta(nodePath: string, deltaX: number, deltaY: number): RVEmbedNodeTransformState | null;
  takeOver(): void;
}

/**
 * Instance-local product UI for rv-embed.
 *
 * The fragments deliberately own only DOM state. Signal values and transforms
 * stay in the real engine and are accessed through the host callbacks.
 */
export class RVEmbedUIFragments {
  private readonly contextMenu: HTMLElement;
  private readonly contextTitle: HTMLElement;
  private readonly contextItems: HTMLElement;
  private readonly contextClose: HTMLButtonElement;
  private readonly pathGizmo: HTMLButtonElement;
  private readonly pathGizmoValue: HTMLElement;
  private readonly signalUnsubscribers = new Set<() => void>();
  private pathNodePath: string | null = null;
  private pointerId: number | null = null;
  private pointerX = 0;
  private pointerY = 0;

  constructor(private readonly host: RVEmbedUIFragmentsHost) {
    const style = document.createElement('style');
    style.textContent = UI_FRAGMENT_STYLES;

    this.contextMenu = document.createElement('section');
    this.contextMenu.setAttribute('part', 'context-menu');
    this.contextMenu.setAttribute('role', 'menu');
    this.contextMenu.setAttribute('aria-hidden', 'true');
    this.contextMenu.hidden = true;

    const header = document.createElement('header');
    header.setAttribute('part', 'context-menu-header');
    this.contextTitle = document.createElement('span');
    this.contextTitle.setAttribute('part', 'context-menu-title');
    this.contextClose = document.createElement('button');
    this.contextClose.type = 'button';
    this.contextClose.setAttribute('part', 'context-menu-close');
    this.contextClose.setAttribute('aria-label', 'Close context menu');
    this.contextClose.textContent = '\u00d7';
    header.append(this.contextTitle, this.contextClose);

    this.contextItems = document.createElement('div');
    this.contextItems.setAttribute('part', 'context-menu-items');
    this.contextMenu.append(header, this.contextItems);

    this.pathGizmo = document.createElement('button');
    this.pathGizmo.type = 'button';
    this.pathGizmo.setAttribute('part', 'path-gizmo');
    this.pathGizmo.setAttribute('aria-label', 'Path point transform handle');
    this.pathGizmo.setAttribute('aria-hidden', 'true');
    this.pathGizmo.hidden = true;
    const handle = document.createElement('span');
    handle.setAttribute('part', 'path-gizmo-handle');
    this.pathGizmoValue = document.createElement('span');
    this.pathGizmoValue.setAttribute('part', 'path-gizmo-value');
    this.pathGizmo.append(handle, this.pathGizmoValue);

    host.shadowRoot.append(style, this.contextMenu, this.pathGizmo);
    this.updateInteractiveMode();
  }

  connect(signal: AbortSignal): void {
    this.host.element.addEventListener(
      'rv-director-context-menu',
      this.handleContextMenuEvent as EventListener,
      { signal },
    );
    this.host.element.addEventListener(
      'rv-director-drag',
      this.handleDirectorDragEvent as EventListener,
      { signal },
    );
    this.contextMenu.addEventListener('pointerdown', this.stopPropagation, { signal });
    this.contextMenu.addEventListener('click', this.stopPropagation, { signal });
    this.contextClose.addEventListener('click', this.handleCloseClick, { signal });
    this.contextItems.addEventListener('click', this.handleItemClick, { signal });
    this.pathGizmo.addEventListener('pointerdown', this.handlePointerDown, { signal });
    this.pathGizmo.addEventListener('pointermove', this.handlePointerMove, { signal });
    this.pathGizmo.addEventListener('pointerup', this.handlePointerEnd, { signal });
    this.pathGizmo.addEventListener('pointercancel', this.handlePointerEnd, { signal });
    this.pathGizmo.addEventListener('click', this.stopPropagation, { signal });
    signal.addEventListener('abort', this.reset, { once: true });
  }

  updateInteractiveMode(): void {
    const interactive = this.host.getInteractiveMode() === 'full';
    this.pathGizmo.dataset.interactive = String(interactive);
    this.pathGizmo.tabIndex = interactive ? 0 : -1;
    this.pathGizmo.setAttribute(
      'aria-label',
      interactive ? 'Drag path point' : 'Path point transform handle',
    );
  }

  clear(): void {
    this.reset();
  }

  private readonly handleContextMenuEvent = (
    event: CustomEvent<RVEmbedDirectorActionDetail>,
  ): void => {
    const detail = event.detail;
    if (detail.type !== 'contextMenu') return;
    if (!detail.open || !detail.position) {
      this.closeContextMenu();
      return;
    }
    this.openContextMenu(detail.nodePath ?? '', detail.position, detail.items);
  };

  private readonly handleDirectorDragEvent = (
    event: CustomEvent<RVEmbedDirectorActionDetail>,
  ): void => {
    const detail = event.detail;
    if (detail.type !== 'drag') return;
    this.pathNodePath = detail.nodePath;
    this.renderPathGizmo(detail.position, detail.transform);
  };

  private openContextMenu(
    nodePath: string,
    position: RVEmbedDirectorPoint,
    items: readonly string[],
  ): void {
    this.closeSignalSubscriptions();
    this.contextTitle.textContent = nodePath.split('/').at(-1) || 'Actions';
    this.contextItems.replaceChildren();

    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('part', 'context-menu-item');
      button.setAttribute('role', 'menuitem');
      button.dataset.signal = item;

      const label = document.createElement('span');
      label.setAttribute('part', 'context-menu-label');
      label.textContent = item;
      const value = document.createElement('span');
      value.setAttribute('part', 'context-menu-value');
      value.dataset.signal = item;
      value.hidden = true;
      button.append(label, value);
      this.contextItems.append(button);

      const unsubscribe = this.host.subscribeSignal(item, (nextValue) => {
        value.textContent = formatSignalValue(nextValue);
        value.hidden = false;
      });
      this.signalUnsubscribers.add(unsubscribe);
    }

    const width = this.host.element.clientWidth || 320;
    const height = this.host.element.clientHeight || 200;
    const x = clamp(position[0] + 12, 8, Math.max(8, width - 216));
    const y = clamp(position[1] + 12, 8, Math.max(8, height - 144));
    this.contextMenu.style.setProperty('--rv-menu-x', `${x}px`);
    this.contextMenu.style.setProperty('--rv-menu-y', `${y}px`);
    this.contextMenu.hidden = false;
    this.contextMenu.setAttribute('aria-hidden', 'false');
  }

  private readonly handleCloseClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    this.closeContextMenu();
  };

  private readonly handleItemClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[part="context-menu-item"]')) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeContextMenu();
  };

  private closeContextMenu(): void {
    this.closeSignalSubscriptions();
    this.contextMenu.hidden = true;
    this.contextMenu.setAttribute('aria-hidden', 'true');
    this.contextTitle.textContent = '';
    this.contextItems.replaceChildren();
  }

  private closeSignalSubscriptions(): void {
    for (const unsubscribe of this.signalUnsubscribers) unsubscribe();
    this.signalUnsubscribers.clear();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.pathNodePath || this.host.getInteractiveMode() !== 'full') return;
    event.preventDefault();
    event.stopPropagation();
    this.host.takeOver();
    this.pointerId = event.pointerId;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.pathGizmo.dataset.dragging = 'true';
    try {
      this.pathGizmo.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and older browsers may not offer capture.
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId || !this.pathNodePath) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - this.pointerX;
    const deltaY = event.clientY - this.pointerY;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    const state = this.host.dragNodeByScreenDelta(this.pathNodePath, deltaX, deltaY);
    if (state) this.renderPathGizmo(state.position, state.transform);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      this.pathGizmo.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional for synthetic events.
    }
    this.pointerId = null;
    delete this.pathGizmo.dataset.dragging;
  };

  private renderPathGizmo(
    position: RVEmbedDirectorPoint,
    transform: RVEmbedDirectorVector3,
  ): void {
    this.pathGizmo.style.setProperty('--rv-gizmo-x', `${position[0]}px`);
    this.pathGizmo.style.setProperty('--rv-gizmo-y', `${position[1]}px`);
    this.pathGizmoValue.textContent = formatTransform(transform);
    this.pathGizmo.hidden = false;
    this.pathGizmo.setAttribute('aria-hidden', 'false');
  }

  private readonly stopPropagation = (event: Event): void => {
    event.stopPropagation();
  };

  private readonly reset = (): void => {
    this.closeContextMenu();
    this.pathNodePath = null;
    this.pointerId = null;
    delete this.pathGizmo.dataset.dragging;
    this.pathGizmo.hidden = true;
    this.pathGizmo.setAttribute('aria-hidden', 'true');
    this.pathGizmoValue.textContent = '';
  };
}

function formatSignalValue(value: RVEmbedSignalValue): string {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function formatTransform(transform: RVEmbedDirectorVector3): string {
  return `X ${transform[0].toFixed(3)} m  Y ${transform[1].toFixed(3)} m  Z ${transform[2].toFixed(3)} m`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

const UI_FRAGMENT_STYLES = `
  [part="context-menu"],
  [part="path-gizmo"] {
    font-family: Inter, Roboto, Arial, sans-serif;
    color: rgba(255, 255, 255, 0.92);
  }

  [part="context-menu"][hidden],
  [part="path-gizmo"][hidden] {
    display: none;
  }

  [part="context-menu"] {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 4;
    width: min(208px, calc(100% - 16px));
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    background: rgba(18, 18, 18, 0.82);
    backdrop-filter: blur(calc(16px * var(--rv-ui-blur-scale, 1)));
    transform: translate3d(var(--rv-menu-x, 8px), var(--rv-menu-y, 8px), 0);
  }

  [part="context-menu-header"] {
    display: flex;
    min-height: 32px;
    align-items: center;
    gap: 8px;
    padding: 0 4px 0 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  [part="context-menu-title"] {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: rgba(255, 255, 255, 0.7);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [part="context-menu-close"],
  [part="context-menu-item"] {
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
  }

  [part="context-menu-close"] {
    width: 28px;
    height: 28px;
    padding: 0;
    color: rgba(255, 255, 255, 0.7);
    font-size: 18px;
    line-height: 1;
  }

  [part="context-menu-close"]:hover,
  [part="context-menu-item"]:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.92);
  }

  [part="context-menu-close"]:focus-visible,
  [part="context-menu-item"]:focus-visible,
  [part="path-gizmo"]:focus-visible {
    outline: 2px solid #4fc3f7;
    outline-offset: -2px;
  }

  [part="context-menu-items"] {
    padding: 4px;
  }

  [part="context-menu-item"] {
    display: flex;
    width: 100%;
    min-height: 32px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    text-align: left;
  }

  [part="context-menu-label"] {
    overflow: hidden;
    font-size: 13px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [part="context-menu-value"] {
    color: #4fc3f7;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
  }

  [part="context-menu-value"][hidden] {
    display: none;
  }

  [part="path-gizmo"] {
    --rv-gizmo-x: 0px;
    --rv-gizmo-y: 0px;
    position: absolute;
    top: 0;
    left: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: transparent;
    transform: translate3d(var(--rv-gizmo-x), var(--rv-gizmo-y), 0) translate(-9px, -9px);
    pointer-events: none;
    touch-action: none;
  }

  [part="path-gizmo"][data-interactive="true"] {
    cursor: move;
    pointer-events: auto;
  }

  [part="path-gizmo-handle"] {
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border: 2px solid #4fc3f7;
    border-radius: 4px;
    background: rgba(18, 18, 18, 0.82);
    backdrop-filter: blur(calc(8px * var(--rv-ui-blur-scale, 1)));
  }

  [part="path-gizmo"][data-interactive="true"]:hover [part="path-gizmo-handle"],
  [part="path-gizmo"][data-dragging="true"] [part="path-gizmo-handle"] {
    background: #4fc3f7;
  }

  [part="path-gizmo-value"] {
    max-width: min(280px, calc(100vw - 48px));
    overflow: hidden;
    padding: 4px 6px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 2px;
    background: rgba(18, 18, 18, 0.82);
    backdrop-filter: blur(calc(8px * var(--rv-ui-blur-scale, 1)));
    color: rgba(255, 255, 255, 0.92);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    [part="context-menu-close"],
    [part="context-menu-item"] {
      min-height: 44px;
    }

    [part="context-menu-close"] {
      width: 44px;
    }

    [part="context-menu"],
    [part="path-gizmo-handle"],
    [part="path-gizmo-value"] {
      backdrop-filter: blur(calc(8px * var(--rv-ui-blur-scale, 1)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    [part="context-menu"],
    [part="path-gizmo"] {
      transition: none;
    }
  }
`;
