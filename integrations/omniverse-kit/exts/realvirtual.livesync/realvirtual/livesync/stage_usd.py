# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""USD side of the realvirtual live link (plan-637 section 2.8).

Pure ``pxr`` - no ``omni`` import - so it is tested with ``usd-core``
outside Kit. Kit hands in ``omni.usd.get_context().get_stage``.

Layout in the stage::

    /World/realvirtual            Xform, references the uploaded .usdz (default prim Root),
                                  +90 deg about X when the stage is Z-up (the snapshot is Y-up)
        Scenes/Scene/...          the runtime snapshot (one prim per runtime node)
        Materials/...             (moved under Root by the browser so bindings survive the reference)
        MUs/mu_<id>               spawned MUs: references to the template prim inside the file

Rules (plan-637 R2):

* Templates are made ``invisible``; a spawned MU authors
  ``visibility = inherited`` explicitly so it never inherits that (R2 #2).
* A pre-placed MU stays the prim of the snapshot. Its pose arrives in world
  space; the prim gets ``!resetXformStack!`` and ``world * wrapper``, so it
  lands at the right place whatever its parent does (R2 #1). ``muDelete``
  hides it, ``reset`` shows it again.
* Node matrices are written with the Sdf API inside one ``Sdf.ChangeBlock``
  onto attribute specs created once per node (no ``AddTransformOp`` per frame).
* A spawned MU references a SUB-ROOT prim of the file; material bindings that
  point outside it are dropped by USD composition, so the bindings of the
  template are re-authored on the spawned prim (stage-path materials).
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Tuple

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, Vt

from . import protocol as P

FILE_ROOT = "/Root"


def _matrix(m: P.Matrix) -> Gf.Matrix4d:
    return Gf.Matrix4d(*[float(v) for v in m])


class UsdStageAdapter:
    """Applies live-link messages to a USD stage."""

    def __init__(self, stage_provider: Callable[[], Usd.Stage], wrapper_path: str = "/World/realvirtual"):
        self._stage_provider = stage_provider
        self.wrapper_path = Sdf.Path(wrapper_path)
        self.mus_path = self.wrapper_path.AppendChild("MUs")
        self._file: Optional[str] = None
        self._nodes: List[Sdf.Path] = []
        self._template_files: List[str] = []
        self._templates: List[Optional[Sdf.Path]] = []
        self._preplaced: Dict[int, Sdf.Path] = {}
        self._hidden_preplaced: set = set()
        self._spawned: Dict[int, Sdf.Path] = {}
        self._xform_specs: Dict[Sdf.Path, Sdf.AttributeSpec] = {}
        self._bindings: Dict[int, List[Tuple[Sdf.Path, Sdf.Path]]] = {}

    # ── helpers ──

    @property
    def stage(self) -> Usd.Stage:
        return self._stage_provider()

    def to_stage_path(self, file_path: str) -> Sdf.Path:
        """``/Root/Scenes/Scene/A`` → ``/World/realvirtual/Scenes/Scene/A``."""
        if file_path != FILE_ROOT and not file_path.startswith(FILE_ROOT + "/"):
            raise ValueError("prim path outside the snapshot: %s" % file_path)
        rest = file_path[len(FILE_ROOT):]
        return Sdf.Path(str(self.wrapper_path) + rest)

    def node_path(self, index: int) -> Sdf.Path:
        return self._nodes[index]

    def spawned_path(self, mu_id: int) -> Optional[Sdf.Path]:
        return self._spawned.get(mu_id)

    def _layer(self) -> Sdf.Layer:
        return self.stage.GetEditTarget().GetLayer()

    def _wrapper_matrix(self, stage: Usd.Stage) -> Gf.Matrix4d:
        m = Gf.Matrix4d(1.0)
        mpu = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
        if abs(mpu - 1.0) > 1e-9:
            m.SetScale(1.0 / mpu)
        if UsdGeom.GetStageUpAxis(stage) == UsdGeom.Tokens.z:
            rot = Gf.Matrix4d(1.0).SetRotate(Gf.Rotation(Gf.Vec3d(1, 0, 0), 90.0))
            m = m * rot
        return m

    def _xform_spec(self, layer: Sdf.Layer, path: Sdf.Path) -> Sdf.AttributeSpec:
        spec = self._xform_specs.get(path)
        if spec is not None and spec.layer == layer and not spec.expired:
            return spec
        prim_spec = Sdf.CreatePrimInLayer(layer, path)
        spec = prim_spec.attributes.get("xformOp:transform")
        if spec is None:
            spec = Sdf.AttributeSpec(prim_spec, "xformOp:transform", Sdf.ValueTypeNames.Matrix4d)
        self._xform_specs[path] = spec
        return spec

    @staticmethod
    def _set_op_order(prim_spec: Sdf.PrimSpec, reset_stack: bool) -> None:
        order = prim_spec.attributes.get("xformOpOrder")
        if order is None:
            order = Sdf.AttributeSpec(prim_spec, "xformOpOrder", Sdf.ValueTypeNames.TokenArray, Sdf.VariabilityUniform)
        ops = ["!resetXformStack!", "xformOp:transform"] if reset_stack else ["xformOp:transform"]
        order.default = Vt.TokenArray(ops)

    @staticmethod
    def _set_visibility(prim_spec: Sdf.PrimSpec, value: str) -> None:
        vis = prim_spec.attributes.get("visibility")
        if vis is None:
            vis = Sdf.AttributeSpec(prim_spec, "visibility", Sdf.ValueTypeNames.Token)
        vis.default = value

    # ── StageAdapter ──

    def mount(self, usd_path: str, begin: P.MountBegin) -> None:
        stage = self.stage
        if stage.GetPrimAtPath(self.wrapper_path):
            stage.RemovePrim(self.wrapper_path)
        parent = self.wrapper_path.GetParentPath()
        if parent != Sdf.Path.absoluteRootPath and not stage.GetPrimAtPath(parent):
            UsdGeom.Xform.Define(stage, parent)
        wrapper = UsdGeom.Xform.Define(stage, self.wrapper_path)
        wrapper.GetPrim().GetReferences().AddReference(usd_path)
        wrapper.MakeMatrixXform().Set(self._wrapper_matrix(stage))
        UsdGeom.Xform.Define(stage, self.mus_path)

        self._file = usd_path
        self._nodes = [self.to_stage_path(p) for p in begin.nodes]
        self._template_files = list(begin.templates)
        self._templates = [self.to_stage_path(p) if p else None for p in begin.templates]
        self._preplaced = {mu_id: self._nodes[i] for mu_id, i in begin.preplaced}
        self._hidden_preplaced = set()
        self._spawned = {}
        self._xform_specs = {}
        self._bindings = {}

        missing = [str(p) for p in self._nodes if not stage.GetPrimAtPath(p)]
        if missing:
            raise ValueError("%d node prims missing in the snapshot, e.g. %s" % (len(missing), missing[0]))
        layer = self._layer()
        with Sdf.ChangeBlock():
            for path in self._templates:
                if path is not None:
                    self._set_visibility(Sdf.CreatePrimInLayer(layer, path), UsdGeom.Tokens.invisible)

    def set_node_matrices(self, items: Dict[int, P.Matrix]) -> None:
        layer = self._layer()
        nodes = self._nodes
        with Sdf.ChangeBlock():
            for idx, m in items.items():
                if idx >= len(nodes):
                    continue
                self._xform_spec(layer, nodes[idx]).default = _matrix(m)

    def spawn_mu(self, mu_id: int, template_index: int, matrix: P.Matrix) -> None:
        stage = self.stage
        if template_index >= len(self._templates) or self._templates[template_index] is None or self._file is None:
            return
        if mu_id in self._spawned:
            self.delete_mu(mu_id)
        path = self.mus_path.AppendChild("mu_%d" % mu_id)
        layer = self._layer()
        with Sdf.ChangeBlock():
            spec = Sdf.CreatePrimInLayer(layer, path)
            spec.specifier = Sdf.SpecifierDef
            spec.typeName = "Xform"
            spec.referenceList.Prepend(Sdf.Reference(self._file, Sdf.Path(self._template_files[template_index])))
            self._set_visibility(spec, UsdGeom.Tokens.inherited)
            self._xform_spec(layer, path).default = _matrix(matrix)
            self._set_op_order(spec, reset_stack=False)
        self._spawned[mu_id] = path
        self._rebind_materials(stage, template_index, path)

    def delete_mu(self, mu_id: int) -> None:
        path = self._spawned.pop(mu_id, None)
        if path is not None:
            self._xform_specs.pop(path, None)
            self.stage.RemovePrim(path)
            return
        pre = self._preplaced.get(mu_id)
        if pre is not None and mu_id not in self._hidden_preplaced:
            self._hidden_preplaced.add(mu_id)
            self._set_visibility(Sdf.CreatePrimInLayer(self._layer(), pre), UsdGeom.Tokens.invisible)

    def set_mu_matrices(self, items: Dict[int, P.Matrix]) -> None:
        stage = self.stage
        layer = self._layer()
        wrapper_world = None
        with Sdf.ChangeBlock():
            for mu_id, m in items.items():
                path = self._spawned.get(mu_id)
                if path is not None:
                    self._xform_spec(layer, path).default = _matrix(m)
                    continue
                pre = self._preplaced.get(mu_id)
                if pre is None:
                    continue
                if wrapper_world is None:
                    wrapper_world = self._wrapper_world(stage)
                spec = self._xform_spec(layer, pre)
                spec.default = _matrix(m) * wrapper_world
                prim_spec = Sdf.CreatePrimInLayer(layer, pre)
                self._set_op_order(prim_spec, reset_stack=True)
                if mu_id in self._hidden_preplaced:
                    self._hidden_preplaced.discard(mu_id)
                    self._set_visibility(prim_spec, UsdGeom.Tokens.inherited)

    def reset(self) -> None:
        for mu_id in list(self._spawned):
            self.delete_mu(mu_id)
        layer = self._layer()
        with Sdf.ChangeBlock():
            for mu_id in list(self._hidden_preplaced):
                self._set_visibility(Sdf.CreatePrimInLayer(layer, self._preplaced[mu_id]), UsdGeom.Tokens.inherited)
        self._hidden_preplaced.clear()

    # ── internals ──

    def _wrapper_world(self, stage: Usd.Stage) -> Gf.Matrix4d:
        prim = stage.GetPrimAtPath(self.wrapper_path)
        return UsdGeom.XformCache().GetLocalToWorldTransform(prim)

    def _rebind_materials(self, stage: Usd.Stage, template_index: int, spawned: Sdf.Path) -> None:
        bindings = self._bindings.get(template_index)
        if bindings is None:
            bindings = []
            tpl_path = self._templates[template_index]
            tpl = stage.GetPrimAtPath(tpl_path)
            if tpl:
                for prim in Usd.PrimRange(tpl):
                    mat_path = UsdShade.MaterialBindingAPI(prim).GetDirectBinding().GetMaterialPath()
                    if not mat_path.isEmpty:
                        bindings.append((prim.GetPath().MakeRelativePath(tpl_path), mat_path))
            self._bindings[template_index] = bindings
        for rel, mat_path in bindings:
            target = spawned if str(rel) == "." else spawned.AppendPath(rel)
            prim = stage.GetPrimAtPath(target)
            material = UsdShade.Material(stage.GetPrimAtPath(mat_path))
            if prim and material:
                UsdShade.MaterialBindingAPI.Apply(prim).Bind(material)
