# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
"""Version of the extension (plan-637 Phase 6).

The one source is ``config/extension.toml`` (``[package] version``) - the same
file Kit reads and the viewer build packs into the download zip. It is read
here with a small parser because Kit's Python 3.10 has no ``tomllib``.

Sent to the viewer in the ``ready`` ack (``extVersion``), so the viewer can
point to a newer download.
"""

from __future__ import annotations

import os
import re

_TOML = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "config", "extension.toml")
)

UNKNOWN_VERSION = "0.0.0"


def read_extension_version(path: str = _TOML) -> str:
    """``[package] version`` of ``extension.toml``; ``0.0.0`` when unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return UNKNOWN_VERSION
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
            continue
        if section == "[package]":
            m = re.match(r'version\s*=\s*"([^"]+)"', stripped)
            if m:
                return m.group(1)
    return UNKNOWN_VERSION


EXTENSION_VERSION = read_extension_version()
