# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""UsdStageAdapter against real USD (usd-core, no Kit) - plan-637 section 9,
test_stage_usd.py: template invisible, several spawned MUs visible with their
material, pre-placed MU with resetXformStack at its world pose."""

import pytest

pxr = pytest.importorskip("pxr")
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade  # noqa: E402

from realvirtual.livesync import protocol as P  # noqa: E402
from realvirtual.livesync.stage_usd import UsdStageAdapter  # noqa: E402

# The shape the browser uploads: three's USDZExporter output after
# `patchModelUsda` (Materials moved under Root, bindings on the Xform prims).
SNAPSHOT_USDA = """#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Scope "Scenes" (
        kind = "sceneLibrary"
    )
    {
        def Xform "Scene"
        {
            def Xform "Cell"
            {
                matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 1) )
                uniform token[] xformOpOrder = ["xformOp:transform"]

                def Xform "Axis"
                {
                    matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )
                    uniform token[] xformOpOrder = ["xformOp:transform"]
                }

                def Xform "Box" (
                    prepend apiSchemas = ["MaterialBindingAPI"]
                )
                {
                    matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 2, 0, 1) )
                    uniform token[] xformOpOrder = ["xformOp:transform"]
                    rel material:binding = </Root/Materials/Material_1>

                    def Mesh "Geometry"
                    {
                        int[] faceVertexCounts = [3]
                        int[] faceVertexIndices = [0, 1, 2]
                        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
                    }
                }

                def Xform "Pre"
                {
                    matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0.5, 0, 1) )
                    uniform token[] xformOpOrder = ["xformOp:transform"]

                    def Mesh "Geometry"
                    {
                        int[] faceVertexCounts = [3]
                        int[] faceVertexIndices = [0, 1, 2]
                        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
                    }
                }
            }
        }
    }

    def "Materials"
    {
        def Material "Material_1"
        {
            token outputs:surface.connect = </Root/Materials/Material_1/PreviewSurface.outputs:surface>

            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (1, 0, 0)
                token outputs:surface
            }
        }
    }
}
"""

NODES = [
    "/Root/Scenes/Scene/Cell",
    "/Root/Scenes/Scene/Cell/Axis",
    "/Root/Scenes/Scene/Cell/Box",
    "/Root/Scenes/Scene/Cell/Pre",
]
TEMPLATES = ["/Root/Scenes/Scene/Cell/Box"]
PRE_MU = 7


def mat(tx=0.0, ty=0.0, tz=0.0):
    return (1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, tx, ty, tz, 1.0)


@pytest.fixture
def setup(tmp_path):
    snapshot = tmp_path / "snapshot.usda"
    snapshot.write_text(SNAPSHOT_USDA, encoding="utf-8")
    stage = Usd.Stage.CreateInMemory()
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)  # Isaac Sim default
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    adapter = UsdStageAdapter(lambda: stage)
    begin = P.MountBegin(1, 0, 0, 1, "identity", NODES, TEMPLATES, [(PRE_MU, 3)])
    adapter.mount(str(snapshot), begin)
    return stage, adapter


def world(stage, path):
    return UsdGeom.XformCache().GetLocalToWorldTransform(stage.GetPrimAtPath(path))


def visibility(stage, path):
    return UsdGeom.Imageable(stage.GetPrimAtPath(path)).ComputeVisibility()


def bound_material(stage, path):
    mat_, _rel = UsdShade.MaterialBindingAPI(stage.GetPrimAtPath(path)).ComputeBoundMaterial()
    return str(mat_.GetPath()) if mat_ else None


def test_mount_references_snapshot_under_z_up_wrapper(setup):
    stage, adapter = setup
    cell = "/World/realvirtual/Scenes/Scene/Cell"
    assert stage.GetPrimAtPath(cell)
    # three (1, 0, 0) under a +90 deg X wrapper stays on X.
    assert Gf.IsClose(world(stage, cell).ExtractTranslation(), Gf.Vec3d(1, 0, 0), 1e-9)
    # three Y-up (0, 2, 0) of the Box becomes Isaac Z-up (.., 0, 2).
    assert Gf.IsClose(world(stage, cell + "/Box").ExtractTranslation(), Gf.Vec3d(1, 0, 2), 1e-9)


def test_materials_survive_the_reference(setup):
    stage, _ = setup
    assert bound_material(stage, "/World/realvirtual/Scenes/Scene/Cell/Box") == "/World/realvirtual/Materials/Material_1"


def test_template_invisible_and_spawned_mus_visible(setup):
    stage, adapter = setup
    adapter.spawn_mu(10, 0, mat(3, 0, 0))
    adapter.spawn_mu(11, 0, mat(4, 0, 0))
    assert visibility(stage, "/World/realvirtual/Scenes/Scene/Cell/Box") == UsdGeom.Tokens.invisible
    for mu in (10, 11):
        path = str(adapter.spawned_path(mu))
        assert visibility(stage, path) == UsdGeom.Tokens.inherited
        assert visibility(stage, path + "/Geometry") == UsdGeom.Tokens.inherited
        assert bound_material(stage, path) == "/World/realvirtual/Materials/Material_1"
    # Spawned pose: MU matrix in the MUs frame (= wrapper frame).
    assert Gf.IsClose(world(stage, str(adapter.spawned_path(11))).ExtractTranslation(), Gf.Vec3d(4, 0, 0), 1e-9)


def test_spawned_mu_moves_and_is_deleted(setup):
    stage, adapter = setup
    adapter.spawn_mu(10, 0, mat(1, 0, 0))
    adapter.set_mu_matrices({10: mat(0, 5, 0)})  # three Y → Isaac Z
    assert Gf.IsClose(world(stage, str(adapter.spawned_path(10))).ExtractTranslation(), Gf.Vec3d(0, 0, 5), 1e-9)
    path = adapter.spawned_path(10)
    adapter.delete_mu(10)
    assert not stage.GetPrimAtPath(path)


def test_preplaced_mu_lands_at_world_pose_with_reset_xform_stack(setup):
    stage, adapter = setup
    pre = "/World/realvirtual/Scenes/Scene/Cell/Pre"
    # Parent Cell sits at three (1, 0, 0); the MU's WORLD pose is three (2, 3, 4).
    adapter.set_mu_matrices({PRE_MU: mat(2, 3, 4)})
    assert UsdGeom.Xformable(stage.GetPrimAtPath(pre)).GetResetXformStack()
    # Rx(+90): (x, y, z) -> (x, -z, y)
    assert Gf.IsClose(world(stage, pre).ExtractTranslation(), Gf.Vec3d(2, -4, 3), 1e-6)


def test_preplaced_delete_hides_and_reset_shows(setup):
    stage, adapter = setup
    pre = "/World/realvirtual/Scenes/Scene/Cell/Pre"
    adapter.delete_mu(PRE_MU)
    assert visibility(stage, pre) == UsdGeom.Tokens.invisible
    adapter.spawn_mu(12, 0, mat())
    adapter.reset()
    assert visibility(stage, pre) == UsdGeom.Tokens.inherited
    assert adapter.spawned_path(12) is None
    assert not stage.GetPrimAtPath("/World/realvirtual/MUs/mu_12")


def test_node_matrices_are_local(setup):
    stage, adapter = setup
    adapter.set_node_matrices({1: mat(0, 0.25, 0)})
    axis = stage.GetPrimAtPath("/World/realvirtual/Scenes/Scene/Cell/Axis")
    local = UsdGeom.Xformable(axis).GetLocalTransformation()
    assert Gf.IsClose(local.ExtractTranslation(), Gf.Vec3d(0, 0.25, 0), 1e-9)
    # second write reuses the attribute spec
    adapter.set_node_matrices({1: mat(0, 0.5, 0)})
    assert Gf.IsClose(UsdGeom.Xformable(axis).GetLocalTransformation().ExtractTranslation(), Gf.Vec3d(0, 0.5, 0), 1e-9)


def test_remount_drops_spawned_mus(setup, tmp_path):
    stage, adapter = setup
    adapter.spawn_mu(10, 0, mat())
    snapshot = tmp_path / "snapshot2.usda"
    snapshot.write_text(SNAPSHOT_USDA, encoding="utf-8")
    adapter.mount(str(snapshot), P.MountBegin(2, 0, 0, 1, "identity", NODES, TEMPLATES, []))
    assert not stage.GetPrimAtPath("/World/realvirtual/MUs/mu_10")
    assert stage.GetPrimAtPath("/World/realvirtual/Scenes/Scene/Cell")


def test_mount_rejects_missing_node_prim(tmp_path):
    snapshot = tmp_path / "s.usda"
    snapshot.write_text(SNAPSHOT_USDA, encoding="utf-8")
    stage = Usd.Stage.CreateInMemory()
    adapter = UsdStageAdapter(lambda: stage)
    with pytest.raises(ValueError):
        adapter.mount(str(snapshot), P.MountBegin(1, 0, 0, 1, "identity", NODES + ["/Root/Scenes/Scene/Nope"], [], []))
