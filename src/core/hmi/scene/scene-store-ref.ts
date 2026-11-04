// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Read the active scene store without loading the editor runtime. */
import type { SceneStore } from './scene-store';
let instance: SceneStore | null = null;
export function getSceneStore(): SceneStore | null { return instance; }
export function setSceneStore(store: SceneStore): void { instance = store; }
