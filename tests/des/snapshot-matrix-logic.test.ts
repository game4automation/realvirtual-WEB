// SPDX-License-Identifier: AGPL-3.0-only
import { registerLogicMatrix } from './continuation-matrix-helpers';

// plan-2207 Phase 3: pure LogicStep models (the Laser GLB runs its LogicStep fallback without the PLC plugin).
registerLogicMatrix(['DemoRealvirtualWeb', 'LaserWeldingAssemblyStation'], ['DemoRealvirtualWeb']);
