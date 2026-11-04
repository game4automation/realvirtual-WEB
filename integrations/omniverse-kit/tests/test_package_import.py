# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Package import with and without the Kit runtime (plan-637).

Field finding: Isaac Sim's ``python.bat`` used as a plain interpreter has
``omni.ext`` but not ``omni.usd``; importing ``realvirtual.livesync`` (and with
it ``protocol`` / ``server`` / ``stage_usd``) must still work there, while
inside Kit the extension class stays exported.
"""

import importlib
import sys
import types

import pytest

_ROOTS = ("realvirtual", "omni", "carb")


def _owned(name):
    return any(name == r or name.startswith(r + ".") for r in _ROOTS)


@pytest.fixture
def clean_modules():
    """Fresh ``realvirtual.livesync`` + fake ``omni``/``carb``, restored afterwards."""
    saved = {k: v for k, v in sys.modules.items() if _owned(k)}
    for k in list(saved):
        del sys.modules[k]
    try:
        yield
    finally:
        for k in [k for k in sys.modules if _owned(k)]:
            del sys.modules[k]
        sys.modules.update(saved)


def _package(name):
    mod = types.ModuleType(name)
    mod.__path__ = []  # a package: an unknown submodule is ModuleNotFoundError
    sys.modules[name] = mod
    return mod


def _fake_omni_ext_only():
    """``omni.ext`` (+ ``carb``, ``omni.kit.app``) present, ``omni.usd`` missing."""
    omni = _package("omni")
    omni.ext = types.ModuleType("omni.ext")
    omni.ext.IExt = object
    sys.modules["omni.ext"] = omni.ext
    omni.kit = _package("omni.kit")
    omni.kit.app = types.ModuleType("omni.kit.app")
    sys.modules["omni.kit.app"] = omni.kit.app
    carb = _package("carb")
    carb.settings = types.ModuleType("carb.settings")
    sys.modules["carb.settings"] = carb.settings


def test_import_without_omni_at_all(clean_modules):
    pkg = importlib.import_module("realvirtual.livesync")
    assert not hasattr(pkg, "RealvirtualLiveSyncExtension")
    importlib.import_module("realvirtual.livesync.protocol")
    importlib.import_module("realvirtual.livesync.server")


def test_import_with_omni_ext_but_no_omni_usd(clean_modules):
    _fake_omni_ext_only()
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("omni.usd")
    pkg = importlib.import_module("realvirtual.livesync")
    assert not hasattr(pkg, "RealvirtualLiveSyncExtension")
    importlib.import_module("realvirtual.livesync.protocol")
    importlib.import_module("realvirtual.livesync.server")
    importlib.import_module("realvirtual.livesync.stage_usd")


def test_import_in_kit_exports_extension(clean_modules):
    _fake_omni_ext_only()
    ext_mod = types.ModuleType("realvirtual.livesync.extension")

    class RealvirtualLiveSyncExtension:  # stand-in for the Kit-only module
        pass

    ext_mod.RealvirtualLiveSyncExtension = RealvirtualLiveSyncExtension
    sys.modules["realvirtual.livesync.extension"] = ext_mod
    pkg = importlib.import_module("realvirtual.livesync")
    assert pkg.RealvirtualLiveSyncExtension is RealvirtualLiveSyncExtension


def test_non_kit_import_error_in_kit_is_raised(clean_modules):
    _fake_omni_ext_only()
    # A broken extension module (not a missing omni/carb runtime) must surface.
    sys.modules["realvirtual.livesync.extension"] = None
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("realvirtual.livesync")
