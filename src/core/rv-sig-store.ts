// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore } from 'react';
import type { SignatureState } from './persistence/rv-sig-verify';
import type { LogicRunState, RVViewer } from './rv-viewer';

export interface SignatureUiState {
  signatureState: SignatureState;
  logicRunState: LogicRunState;
  modelName: string;
  signerOrganization?: string;
  viewer: RVViewer | null;
}

const EMPTY_STATE: SignatureUiState = {
  signatureState: 'none',
  logicRunState: 'active',
  modelName: '',
  viewer: null,
};

const listeners = new Set<() => void>();
let state = EMPTY_STATE;

function emit(): void {
  for (const listener of listeners) listener();
}

export function signatureUnlockKey(modelName: string): string {
  return `rv-sig-unlock:${modelName}`;
}

export function isSignatureUnlocked(modelName: string): boolean {
  if (!modelName) return false;
  try {
    return localStorage.getItem(signatureUnlockKey(modelName)) === '1';
  } catch {
    return false;
  }
}

export function persistSignatureUnlock(modelName: string): void {
  if (!modelName) return;
  try {
    localStorage.setItem(signatureUnlockKey(modelName), '1');
  } catch {
    // Storage unavailable/private mode: activation still applies for this load.
  }
}

export function setSignatureUiState(next: SignatureUiState): void {
  if (
    state.signatureState === next.signatureState
    && state.logicRunState === next.logicRunState
    && state.modelName === next.modelName
    && state.signerOrganization === next.signerOrganization
    && state.viewer === next.viewer
  ) return;
  state = next;
  emit();
}

export function resetSignatureUiState(): void {
  setSignatureUiState(EMPTY_STATE);
}

export function getSignatureUiState(): SignatureUiState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSignatureUiState(): SignatureUiState {
  return useSyncExternalStore(subscribe, getSignatureUiState, getSignatureUiState);
}

