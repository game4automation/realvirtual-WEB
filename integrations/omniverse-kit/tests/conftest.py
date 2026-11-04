# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""pytest setup: make the extension package importable without Kit.

Run (any Python 3.10+ with ``pytest``, ``websockets`` and ``usd-core``)::

    python -m pytest integrations/omniverse-kit/tests
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.normpath(os.path.join(HERE, "..", "exts", "realvirtual.livesync"))
if EXT not in sys.path:
    sys.path.insert(0, EXT)

GOLDEN = os.path.join(HERE, "golden_v1.json")
