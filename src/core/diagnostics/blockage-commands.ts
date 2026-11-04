// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { CommandError, type CommandImpl } from '../hmi/rv-command-registry';

export const blockage: CommandImpl = {
  enabled: () => true,
  run: ({ viewer }) => viewer.blockageWatch.inspect(),
};
export const waitGraph: CommandImpl = {
  enabled: () => true,
  run: ({ viewer }) => ({ edges: viewer.waitRegistry?.collect(viewer.simTime, true) ?? [],
    sources: viewer.waitRegistry?.sources() ?? [] }),
};
export const blockageWatchStatus: CommandImpl = {
  enabled: () => true,
  run: ({ viewer }) => viewer.blockageWatch.status(),
};
export const blockageWatch: CommandImpl<{ on: boolean }> = {
  enabled: () => true,
  run: ({ viewer }, args) => {
    if (typeof args?.on !== 'boolean') throw new CommandError('on must be a boolean');
    viewer.blockageWatch.setOn(args.on);
    return viewer.blockageWatch.status();
  },
};
