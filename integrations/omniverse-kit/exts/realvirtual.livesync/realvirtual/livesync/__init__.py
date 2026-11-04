# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""realvirtual Live Sync - receives the USD live link of realvirtual WEB (plan-637).

Inside Kit the extension class is exported from here (Kit looks for
``omni.ext.IExt`` subclasses in the module named in ``extension.toml``).
Outside Kit (tests, other tools) only the pure modules ``protocol``,
``server`` and ``stage_usd`` are used.

"Outside Kit" includes a Python where ``omni.ext`` is importable but the Kit
runtime is not - e.g. Isaac Sim's ``python.bat`` run as a plain interpreter,
where ``omni.usd`` / ``carb`` / ``omni.ui`` are missing. The Kit-only module
``extension`` is therefore imported only when it can be: a missing ``omni`` /
``carb`` module skips it, any other import error is a real bug and is raised.
"""

_KIT_ONLY_ROOTS = ("omni", "carb")

try:  # pragma: no cover - only inside Kit
    import omni.ext  # noqa: F401
except ImportError:  # outside Kit
    pass
else:
    try:
        from .extension import RealvirtualLiveSyncExtension  # noqa: F401
    except ModuleNotFoundError as exc:  # omni.ext without the Kit runtime
        if (exc.name or "").split(".")[0] not in _KIT_ONLY_ROOTS:
            raise
