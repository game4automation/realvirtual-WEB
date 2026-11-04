# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
#
# AGV pallet stacker, v2 - built against the manufacturer's own drawings.
# Library model public/library/MobileRobots/AGVStacker.glb (plan-612 Phase 1).
#
# ARCHITECTURE (from the vendor dimension drawing and front view), bottom to top:
#   1. a wide flat SKID plate hugging the floor, with safety plates and bumpers
#   2. a LOW, heavily rounded white pod, top at ~0.90 m - half the mast height
#   3. a separate DISPLAY HEAD, a tilted monitor on a neck
#   4. the mast crossbeam carrying the nav scanner and the beacon
#   5. a slim fork carriage. This machine has NO load backrest.
#
# LONGITUDINAL LAYOUT - the thing v2 got wrong on the first pass.
# y = 0 is the FORK HEEL, i.e. the front face of the mast and carriage. The
# drawing's 1687 mm overall breaks down as 1150 mm of fork in front of that plane
# and 537 mm of machine behind it. Putting any part of the mast at positive y
# makes the forks grow out of the middle of the mast - mechanically impossible,
# and it is what made the pallet intersect the mast:
#
#     fork      y    0.000 .. 1.150
#     mast      y   -0.105 .. 0.000
#     pod       y   -0.537 .. -0.105
#     pallet    y    0.010 .. 1.210   (10 mm clear of the carriage)
#
# Dimensions: 1687 x 855 x 1798 mm, fork 1150 x 180 mm at 90 mm ground clearance.
# TWO deliberate deviations from the original, see FORK_CC and WHEEL ARMS.
#
# WHEEL ARMS (plan-612). The load rollers sit in two flat wheel arms on the
# CHASSIS, not in the fork blades: a stacker that lifts its rollers with the load
# would stand on nothing. The arms run under the forks inside the two fork windows
# of a Europallet entered on its 800 mm face (bottom boards at 0..100, 345..455
# and 700..800 mm leave |x| = 55..300 mm free) and pass under the end of a roller
# conveyor (its end legs stand at |x| = 430..570 mm). At lift 0 the blades rest
# just above the arms; the fork top is at 88 mm, under the 100 mm deck opening.
#
# ORIGIN. The exported root sits at the middle of the vehicle INCLUDING a carried
# pallet (pod rear y = -0.537 .. pallet front y = +1.210), so an explicit
# Agv.VehicleLength / VehicleWidth (symmetric about the root) is the true body.
# All geometry below is still authored in the heel frame (y = 0 at the fork heel);
# the shift happens once, right before export (see RECENTRE).
#
# Run: blender --background --python build_agv_stacker.py -- <out.glb> [--ref <dir>]
#   <out.glb>  output file (required)
#   --ref      the .agv-ref folder with the reference pictograms (iso7010-W015.png,
#              iso7010-W024.png); the ISO 7010 set of the starter package is read
#              from <ref>/../Packages/io.realvirtual.starter/Assets/3DPrefabs/Decals/Imgs.
#              Default: env RV_AGV_REF, else the first ancestor folder of this
#              script or of the current directory that contains `.agv-ref`.

import bpy
import bmesh
import math
import os
import sys
from mathutils import Matrix, Vector


def _parse_args(argv):
    # Blender hands everything after `--` to the script untouched.
    args = argv[argv.index('--') + 1:] if '--' in argv else []
    out, ref = None, None
    i = 0
    while i < len(args):
        if args[i] == '--ref' and i + 1 < len(args):
            ref = args[i + 1]
            i += 2
            continue
        if out is None:
            out = args[i]
        i += 1
    if not out:
        raise SystemExit('usage: blender --background --python build_agv_stacker.py '
                         '-- <out.glb> [--ref <.agv-ref dir>]')
    return os.path.abspath(out), ref


def _find_ref(explicit):
    if explicit:
        return os.path.abspath(explicit)
    if os.environ.get('RV_AGV_REF'):
        return os.path.abspath(os.environ['RV_AGV_REF'])
    for start in (os.path.dirname(os.path.abspath(__file__)), os.getcwd()):
        d = start
        while True:
            cand = os.path.join(d, '.agv-ref')
            if os.path.isdir(cand):
                return cand
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
    raise SystemExit('reference folder .agv-ref not found - pass --ref <dir> or set RV_AGV_REF')

# ----------------------------------------------------------------------------- spec
WIDTH        = 0.855
OVERALL_LEN  = 1.687
MAST_HEIGHT  = 1.798
FORK_LEN     = 1.150
FORK_WIDTH   = 0.180

MAST_DEPTH   = 0.105
Y_REAR       = -(OVERALL_LEN - FORK_LEN)               # -0.537
Y_POD_FRONT  = -MAST_DEPTH                             # -0.105
POD_LEN      = Y_POD_FRONT - Y_REAR                    #  0.432
Y_POD_MID    = (Y_REAR + Y_POD_FRONT) / 2.0

# Blades: bottom 48 mm (4 mm over the wheel arms), top 88 mm - under the 100 mm
# deck opening of a Europallet (the drawing's "90 mm"). The carriage keeps its
# original home height CARRIAGE_BASE: the chain reeving below is solved for it.
FORK_BLADE_THICK = 0.040
FORK_BLADE_CLEAR = 0.048
Z_BLADE_TOP      = FORK_BLADE_CLEAR + FORK_BLADE_THICK
CARRIAGE_BASE    = 0.028

# DEVIATION FROM THE ORIGINAL. The drawing gives 680 mm across the fork outsides
# (500 mm centre-to-centre). That does not fit a Europallet entered on its 800 mm
# face: the outer bottom boards occupy 0..100 and 700..800 mm, leaving at most
# 600 mm of clear span, so the real machine would ride up on them. Function wins,
# so the forks sit centred in the pallet's two windows.
FORK_CC      = 0.3725                                  # 552.5 mm across the outsides

# --- lift mechanism -----------------------------------------------------------
# 1:1 is impossible in this mast (see the comment at Mast_CylBarrel), so it is a
# 2:1 chain reeving. Everything below follows from LIFT_TRAVEL and the mast
# height; the sprocket's home height has a window of only 29 mm.
LIFT_TRAVEL     = 1.200
RAM_STROKE      = LIFT_TRAVEL / 2.0          # 0.600
CARRIAGE_TOP    = 0.333                      # chain anchor on the carriage, home
SPROCKET_R      = 0.042
SPROCKET_Z0     = 1.030                      # home; allowed window 1.013 .. 1.042
CHAIN_ANCHOR_Z  = 0.145
# One texture tile = one chain pitch. The strands are Z-scaled to lift, which
# stretches their UVs, so a component animating them must counter-scale the
# texture repeat by the same factor - that is why each strand owns its material.
CHAIN_PITCH_UV  = 0.032
CYL_BARREL_Z0   = 0.145
CYL_BARREL_LEN  = 0.680
# The rod must still be guided by the barrel at full stroke, so it has to be at
# least the stroke plus an overlap: rod bottom at full lift stays below the
# barrel mouth.
CYL_ROD_LEN     = 0.850

# --- running gear -------------------------------------------------------------
# Three-wheel layout: one steered drive wheel on the centreline at the rear, two
# load rollers in the forks, plus two passive stabiliser casters at the rear
# corners. With the drive wheel at full lock it rolls sideways, so its axis lies
# on x = 0 while the unsteered load rollers' axis is the line y = Y_LOAD_WHEEL -
# the instantaneous centre is where they meet, i.e. the middle of the load-roller
# axle. Everything the motion sim needs follows from that point.
#
# Y_LOAD_WHEEL is NOT a guess: it is solved from the published 1310 mm turning
# radius. The governing point is the rear chassis corner, so
#     sqrt((Y_LOAD_WHEEL - Y_REAR)^2 + (WIDTH/2)^2) = 1.310
# gives 0.701 m, i.e. 449 mm behind the fork tip. Placing the rollers at the tip
# (the first attempt) would have made the machine turn 330 mm too tightly.
Y_LOAD_WHEEL  = 0.701
LOAD_WHEEL_R  = 0.019           # fits the 44 mm wheel arm (was 0.027 in the blades)
Y_DRIVE_WHEEL = -0.367          # on the centreline, under the pod
DRIVE_WHEEL_R = 0.085
Y_CASTER      = -0.477
CASTER_R      = 0.048

SKID_H       = 0.070
POD_TOP      = 0.900
POD_W        = WIDTH - 0.065
HEAD_BOT     = 0.950
HEAD_TOP     = 1.300
MAST_X       = 0.300
SCANNER_X    = -0.165          # offset, so the scanner stays visible from the load side
WHEEL_R      = 0.085

# --- wheel arms (chassis) --------------------------------------------------
ARM_W        = 0.160            # |x| = 0.106 .. 0.266 around each fork centre
ARM_H        = 0.044            # top 4 mm under the blade bottom at lift 0
ARM_Y0       = -0.050           # 20 mm into the skid front (-0.030)
ARM_TIP      = Y_LOAD_WHEEL + LOAD_WHEEL_R + 0.060

# --- pallet seat / root -------------------------------------------------------
PALLET_Y0    = 0.010            # pallet rear face, 10 mm clear of the carriage
PALLET_LEN   = 1.200
PALLET_MID_Y = PALLET_Y0 + PALLET_LEN / 2.0
# RECENTRE: the exported root is the middle of pod rear .. carried pallet front.
Y_ROOT       = (Y_REAR + PALLET_Y0 + PALLET_LEN) / 2.0

TRI_BUDGET   = 14000

OUT_GLB, _REF_ARG = _parse_args(sys.argv)
OUT_DIR = _find_ref(_REF_ARG)   # reference assets (pictograms) live here


# ------------------------------------------------------------------------- helpers

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects,
                  bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def mat(name, color, rough=0.45, metal=0.0, emit=None, emit_strength=0.0,
        coat=0.0, image=None, alpha=1.0, interp='Linear'):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (color[0], color[1], color[2], 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit is not None:
        b.inputs['Emission Color'].default_value = (emit[0], emit[1], emit[2], 1.0)
        b.inputs['Emission Strength'].default_value = emit_strength
    if coat > 0.0:
        for key in ('Coat Weight', 'Clearcoat', 'Coat'):
            if key in b.inputs:
                b.inputs[key].default_value = coat
                break
        for key in ('Coat Roughness', 'Clearcoat Roughness'):
            if key in b.inputs:
                b.inputs[key].default_value = 0.08
                break
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    if image is not None:
        tex = m.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        tex.interpolation = interp
        m.node_tree.links.new(tex.outputs['Color'], b.inputs['Base Color'])
        # Only wire emission for materials that are meant to glow. Doing it
        # unconditionally exports a redundant emissive texture and makes the
        # glTF writer warn about two images feeding one sampler.
        if emit_strength > 0.0:
            m.node_tree.links.new(tex.outputs['Color'], b.inputs['Emission Color'])
            b.inputs['Emission Strength'].default_value = emit_strength
    return m


def box(name, size, loc, material, bevel=0.010, segments=2, angle=40):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = Vector(size)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        md = ob.modifiers.new('Bevel', 'BEVEL')
        md.width = bevel
        md.segments = segments
        md.limit_method = 'ANGLE'
        md.angle_limit = math.radians(angle)
        bpy.ops.object.modifier_apply(modifier=md.name)
    ob.data.materials.append(material)
    return ob


def cyl(name, radius, depth, loc, material, axis='Z', verts=16, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth,
                                        location=loc)
    ob = bpy.context.active_object
    ob.name = name
    if axis == 'X':
        ob.rotation_euler[1] = math.radians(90)
    elif axis == 'Y':
        ob.rotation_euler[0] = math.radians(90)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    if bevel > 0:
        md = ob.modifiers.new('Bevel', 'BEVEL')
        md.width = bevel
        md.segments = 2
        md.limit_method = 'ANGLE'
        md.angle_limit = math.radians(50)
        bpy.ops.object.modifier_apply(modifier=md.name)
    ob.data.materials.append(material)
    return ob


def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.10
    e.location = loc
    bpy.context.collection.objects.link(e)
    return e


def parent_to(child, parent):
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


def shrink_above(ob, z_from, sx, sy):
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    cx = sum(v.co.x for v in bm.verts) / len(bm.verts)
    cy = sum(v.co.y for v in bm.verts) / len(bm.verts)
    z_top = max(v.co.z for v in bm.verts)
    for v in bm.verts:
        if v.co.z > z_from:
            t = (v.co.z - z_from) / max(z_top - z_from, 1e-6)
            v.co.x = cx + (v.co.x - cx) * (1.0 - t * (1.0 - sx))
            v.co.y = cy + (v.co.y - cy) * (1.0 - t * (1.0 - sy))
    bm.to_mesh(me)
    bm.free()


def drop_front(ob, z_from, drop):
    """Slope the top of a body downwards towards +Y (the mast side)."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    z_top = max(v.co.z for v in bm.verts)
    y_lo = min(v.co.y for v in bm.verts)
    y_hi = max(v.co.y for v in bm.verts)
    span = max(z_top - z_from, 1e-6)
    y_span = max(y_hi - y_lo, 1e-6)
    for v in bm.verts:
        if v.co.z > z_from:
            tz = (v.co.z - z_from) / span
            ty = (v.co.y - y_lo) / y_span
            v.co.z -= drop * tz * ty * ty
    bm.to_mesh(me)
    bm.free()


def strip(name, w, d, length, origin, up, material):
    """A bar whose ORIGIN sits at one end, so scaling Z lengthens it from there.

    Chain strands change length as the mast lifts. Putting the origin at the
    fixed end means the whole animation is a single Z scale, with no matching
    translation to keep in sync.
    """
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=origin)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = Vector((w, d, length))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    off = length / 2.0 if up else -length / 2.0
    for v in ob.data.vertices:
        v.co.z += off
    ob.data.materials.append(material)
    return ob


def body_section(ob, z):
    """Half-width and y-range of a body AT a given height, queried from the
    actual surface.

    Reading vertices does not work: a bevelled box only has vertices along its
    edges, so at mid height there are none to find. closest_point_on_mesh asks
    the surface itself and works wherever the body happens to be tessellated.
    """
    off = ob.matrix_world.translation

    def probe(p_world):
        ok, loc, nor, idx = ob.closest_point_on_mesh(Vector(p_world) - off)
        if not ok:
            raise RuntimeError('could not probe %s at %s' % (ob.name, p_world))
        return loc + off

    y_mid = ob.matrix_world.translation.y
    hw = probe((5.0, y_mid, z)).x
    y0 = probe((0.0, -5.0, z)).y
    y1 = probe((0.0, 5.0, z)).y
    return abs(hw), min(y0, y1), max(y0, y1)


def taper_fork_tip(ob, tip_y, taper_len=0.22, keep_thick=0.018):
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    zs = [v.co.z for v in bm.verts]
    z_top, z_bot = max(zs), min(zs)
    for v in bm.verts:
        if v.co.y > tip_y - taper_len and abs(v.co.z - z_top) < 1e-4:
            t = (v.co.y - (tip_y - taper_len)) / taper_len
            v.co.z = z_top - t * (z_top - z_bot - keep_thick)
    bm.to_mesh(me)
    bm.free()


def make_screen_image(w=256, h=160):
    """Generate the HMI screen content in-script - the one texture that earns
    its keep, because a screen IS pixels and a plane's UV is already 0..1."""
    img = bpy.data.images.new('AGV_Screen', width=w, height=h)
    px = [0.0] * (w * h * 4)

    def put(x, y, r, g, b):
        if 0 <= x < w and 0 <= y < h:
            i = (y * w + x) * 4
            px[i], px[i + 1], px[i + 2], px[i + 3] = r, g, b, 1.0

    for y in range(h):
        for x in range(w):
            put(x, y, 0.015, 0.045, 0.085)
    for y in range(h - 18, h):
        for x in range(w):
            put(x, y, 0.03, 0.17, 0.26)
    for i in range(14):
        yy = h - 30 - i * 8
        for x in range(8, 78):
            if (x + i) % 7 < 5:
                put(x, yy, 0.25, 0.62, 0.75)
    for y in range(44, 120):
        for x in range(100, 160):
            e = (abs(x - 130) / 30.0) ** 2 + (abs(y - 82) / 38.0) ** 2
            if e < 1.0:
                put(x, y, 0.15, 0.55 + 0.35 * (1.0 - e), 0.95)
    for i in range(5):
        bh = 12 + i * 9
        for y in range(28, 28 + bh):
            for x in range(188 + i * 12, 196 + i * 12):
                put(x, y, 0.20, 0.85, 0.45)
    img.pixels = px
    img.pack()
    return img


def _img(name, w, h, fill=(0, 0, 0, 1)):
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    return img, [c for _ in range(w * h) for c in fill]


def make_chain_image(w=32, h=64):
    """Tileable leaf-chain pattern.

    A chain is the textbook case for a texture: the link pitch is a few
    millimetres, so modelling it would cost hundreds of triangles per strand and
    still alias. Two plates and a pin per pitch, drawn twice per tile.
    """
    img, px = _img('AGV_ChainTex', w, h, (0.055, 0.058, 0.065, 1.0))

    def put(x, y, r, g, b):
        if 0 <= x < w and 0 <= y < h:
            i = (y * w + x) * 4
            px[i], px[i + 1], px[i + 2] = r, g, b

    for pitch in range(2):
        y0 = pitch * (h // 2)
        inner = (pitch % 2 == 0)
        x_lo, x_hi = (9, 23) if inner else (5, 27)
        for y in range(y0 + 3, y0 + (h // 2) - 3):      # link plates
            t = abs((y - (y0 + h // 4)) / float(h // 4))
            shade = 0.34 - 0.16 * t * t
            for x in range(x_lo, x_hi):
                put(x, y, shade, shade * 1.02, shade * 1.08)
            put(x_lo, y, 0.07, 0.07, 0.08)
            put(x_hi - 1, y, 0.07, 0.07, 0.08)
        cy = y0 + h // 4                                 # pin head
        for y in range(cy - 3, cy + 4):
            for x in range(13, 20):
                if (x - 16) ** 2 + (y - cy) ** 2 <= 9:
                    put(x, y, 0.46, 0.47, 0.50)
    img.pixels = px
    img.pack()
    return img


def make_tread_image(w=64, h=64):
    """Tileable block tread for the drive wheel and rollers."""
    img, px = _img('AGV_TreadTex', w, h, (0.055, 0.055, 0.060, 1.0))

    def put(x, y, v):
        if 0 <= x < w and 0 <= y < h:
            i = (y * w + x) * 4
            px[i], px[i + 1], px[i + 2] = v, v, v * 1.04

    for y in range(h):
        for x in range(w):
            put(x, y, 0.050)
    for b in range(4):                                   # tread blocks
        x0 = b * 16 + 2
        skew = 6 if b % 2 else 0
        for y in range(h):
            yy = (y + skew) % h
            if 4 <= (yy % 22) <= 17:
                for x in range(x0, x0 + 12):
                    put(x, y, 0.105)
    img.pixels = px
    img.pack()
    return img


# Atlas regions in PIXELS. Deriving the UVs from this table instead of typing
# them by hand is what stops the "decal shows the wrong part of the atlas" class
# of bug - and it is how the upside-down warning sign slipped through before.
ATLAS_W, ATLAS_H = 512, 640
GUTTER = 8

# Pictogram sources. Four come from our own starter package, which already
# ships an ISO 7010 set - drawing them by hand produced a lightning bolt that
# read as scattered blocks and a plug that read as a plus sign.
PKG_DECALS = os.path.abspath(os.path.join(
    OUT_DIR, '..', 'Packages', 'io.realvirtual.starter', 'Assets', '3DPrefabs',
    'Decals', 'Imgs'))
PICTOGRAMS = {
    'electrical': os.path.join(PKG_DECALS, 'ISO_7010_W012.png'),
    'laser':      os.path.join(PKG_DECALS, 'ISO_7010_W004.svg.png'),
    'barcode':    os.path.join(PKG_DECALS, 'Barcode.png'),
    'warning':    os.path.join(PKG_DECALS, 'ISO_7010_W001.png'),
    # not in the package - public domain, fetched from Wikimedia Commons
    'no_stand':   os.path.join(OUT_DIR, 'iso7010-W015.png'),
    'crush':      os.path.join(OUT_DIR, 'iso7010-W024.png'),
}

# Regions in PIXELS, every pair separated by at least GUTTER. Without that gap
# the sampler pulls in the neighbouring graphic.
REGIONS = {
    'crush':      (  8,   8, 146, 128),   # 138x120
    'laser':      (154,   8, 292, 128),   # 138x120
    'electrical': (300,   8, 438, 128),   # 138x120
    'charge':     (  8, 136,  98, 226),   #  90x90
    'vent':       (106, 136, 346, 256),   # 240x120
    'capacity':   (354, 136, 504, 230),   # 150x94
    'nameplate':  (  8, 264, 238, 392),   # 230x128
    'warning':    (246, 264, 384, 384),   # 138x120
    'no_stand':   (392, 264, 504, 384),   # 112x120
    'fleet':      (  8, 400, 168, 514),   # 160x114
    'hazard':     (176, 400, 504, 434),   # 328x34
    'wordmark':   (176, 442, 504, 514),   # 328x72
    'barcode':    (  8, 522, 308, 578),   # 300x56
}

_names = list(REGIONS)
for _i in range(len(_names)):
    for _j in range(_i + 1, len(_names)):
        _a, _b = REGIONS[_names[_i]], REGIONS[_names[_j]]
        if (min(_a[2], _b[2]) > max(_a[0], _b[0])
                and min(_a[3], _b[3]) > max(_a[1], _b[1])):
            raise RuntimeError('atlas regions overlap: %s / %s'
                               % (_names[_i], _names[_j]))
for _k, _r in REGIONS.items():
    if _r[2] > ATLAS_W or _r[3] > ATLAS_H:
        raise RuntimeError('region %s runs past the atlas' % _k)


def region_uv(name):
    """UVs normalise against the atlas WIDTH and HEIGHT separately - dividing
    both axes by one number only works while the atlas is square."""
    x0, y0, x1, y1 = REGIONS[name]
    return (x0 / ATLAS_W, y0 / ATLAS_H, x1 / ATLAS_W, y1 / ATLAS_H)


# 5x7 bitmap font. Building letters out of bars produced hollow boxes that read
# as nothing at all - the wordmark and "1400 KG" were both unreadable. A real
# glyph table is the smallest fix that does not drag in a font file.
FONT = {
    '0': ('01110', '10001', '10001', '10001', '10001', '10001', '01110'),
    '1': ('00100', '01100', '00100', '00100', '00100', '00100', '01110'),
    '2': ('01110', '10001', '00001', '00010', '00100', '01000', '11111'),
    '3': ('11111', '00010', '00100', '00010', '00001', '10001', '01110'),
    '4': ('00010', '00110', '01010', '10010', '11111', '00010', '00010'),
    '5': ('11111', '10000', '11110', '00001', '00001', '10001', '01110'),
    '6': ('00110', '01000', '10000', '11110', '10001', '10001', '01110'),
    '7': ('11111', '00001', '00010', '00100', '01000', '01000', '01000'),
    '8': ('01110', '10001', '10001', '01110', '10001', '10001', '01110'),
    '9': ('01110', '10001', '10001', '01111', '00001', '00010', '01100'),
    'A': ('01110', '10001', '10001', '11111', '10001', '10001', '10001'),
    'B': ('11110', '10001', '10001', '11110', '10001', '10001', '11110'),
    'C': ('01110', '10001', '10000', '10000', '10000', '10001', '01110'),
    'D': ('11100', '10010', '10001', '10001', '10001', '10010', '11100'),
    'E': ('11111', '10000', '10000', '11110', '10000', '10000', '11111'),
    'F': ('11111', '10000', '10000', '11110', '10000', '10000', '10000'),
    'G': ('01110', '10001', '10000', '10111', '10001', '10001', '01111'),
    'H': ('10001', '10001', '10001', '11111', '10001', '10001', '10001'),
    'I': ('01110', '00100', '00100', '00100', '00100', '00100', '01110'),
    'J': ('00111', '00010', '00010', '00010', '00010', '10010', '01100'),
    'K': ('10001', '10010', '10100', '11000', '10100', '10010', '10001'),
    'L': ('10000', '10000', '10000', '10000', '10000', '10000', '11111'),
    'M': ('10001', '11011', '10101', '10101', '10001', '10001', '10001'),
    'N': ('10001', '11001', '10101', '10011', '10001', '10001', '10001'),
    'O': ('01110', '10001', '10001', '10001', '10001', '10001', '01110'),
    'P': ('11110', '10001', '10001', '11110', '10000', '10000', '10000'),
    'Q': ('01110', '10001', '10001', '10001', '10101', '10010', '01101'),
    'R': ('11110', '10001', '10001', '11110', '10100', '10010', '10001'),
    'S': ('01111', '10000', '10000', '01110', '00001', '00001', '11110'),
    'T': ('11111', '00100', '00100', '00100', '00100', '00100', '00100'),
    'U': ('10001', '10001', '10001', '10001', '10001', '10001', '01110'),
    'V': ('10001', '10001', '10001', '10001', '10001', '01010', '00100'),
    'W': ('10001', '10001', '10001', '10101', '10101', '11011', '10001'),
    'X': ('10001', '10001', '01010', '00100', '01010', '10001', '10001'),
    'Y': ('10001', '10001', '01010', '00100', '00100', '00100', '00100'),
    'Z': ('11111', '00001', '00010', '00100', '01000', '10000', '11111'),
    '.': ('00000', '00000', '00000', '00000', '00000', '01100', '01100'),
    '-': ('00000', '00000', '00000', '11111', '00000', '00000', '00000'),
    ' ': ('00000', '00000', '00000', '00000', '00000', '00000', '00000'),
}


def make_decal_atlas(w=ATLAS_W, h=ATLAS_H):
    """One atlas for every flat graphic. Twelve graphics, ONE material.

    Drawing is CLIPPED to the active region and every pixel painted outside it
    is counted, then the build fails. The first direction arrow drew a head
    156 px wide inside a 90 px region and smeared into its neighbour with
    nothing complaining.
    """
    img, px = _img('AGV_DecalAtlas', w, h, (0.0, 0.0, 0.0, 0.0))
    s = w                      # row stride
    clip = [0, 0, w, h]
    cur = ['init']
    spill = {}

    GREEN = (0.24, 0.76, 0.22)
    DARK = (0.05, 0.05, 0.06)
    AMBER = (0.96, 0.74, 0.05)
    RED = (0.80, 0.08, 0.08)
    PLATE = (0.88, 0.89, 0.91)

    def put(x, y, c, a=1.0):
        x, y = int(x), int(y)
        if not (clip[0] <= x < clip[2] and clip[1] <= y < clip[3]):
            # Count per region: a global counter names whichever region happened
            # to be drawn last, which sends you looking at the wrong graphic.
            if 0 <= x < w and 0 <= y < h:
                spill[cur[0]] = spill.get(cur[0], 0) + 1
            return
        i = (y * s + x) * 4
        px[i], px[i + 1], px[i + 2], px[i + 3] = c[0], c[1], c[2], a

    def bar(x0, y0, w, h, c):
        for y in range(int(y0), int(y0 + h)):
            for x in range(int(x0), int(x0 + w)):
                put(x, y, c)

    def use(key):
        clip[:] = list(REGIONS[key])
        cur[0] = key
        return REGIONS[key]

    def text(sv, cx, cy, scale, c, spacing=1):
        tw = len(sv) * (5 + spacing) * scale - spacing * scale
        rw = clip[2] - clip[0]
        if tw > rw - 6:
            raise RuntimeError('text %r is %d px wide at scale %d, region %r is '
                               'only %d px' % (sv, tw, scale, cur[0], rw))
        x = cx - tw / 2.0
        y0 = cy - (7 * scale) / 2.0
        for ch in sv.upper():
            g = FONT.get(ch, FONT[' '])
            for r in range(7):
                row = g[6 - r]               # image y grows upward
                for col in range(5):
                    if row[col] == '1':
                        bar(x + col * scale, y0 + r * scale, scale, scale, c)
            x += (5 + spacing) * scale

    def triangle(key, border):
        """Equilateral and fitted to the region. A hand-picked slope gave a
        squashed sign whose base overran its region by 5 px."""
        gx0, gy0, gx1, gy1 = use(key)
        rw, rh = gx1 - gx0, gy1 - gy0
        base = min(rw - 4, (rh - 4) * 2.0 / math.sqrt(3.0))
        th = base * math.sqrt(3.0) / 2.0
        gcx = (gx0 + gx1) // 2
        by = gy0 + (rh - th) / 2.0
        for y in range(int(by), int(by + th)):
            half = (1.0 - (y - by) / th) * base / 2.0
            for x in range(int(gcx - half), int(gcx + half)):
                put(x, y, DARK if half - abs(x - gcx) < border else AMBER)
        return gcx, by, th

    def disc(key, ring, fill):
        gx0, gy0, gx1, gy1 = use(key)
        cx, cy = (gx0 + gx1) // 2, (gy0 + gy1) // 2
        r = min(gx1 - gx0, gy1 - gy0) // 2 - 3
        for y in range(gy0, gy1):
            for x in range(gx0, gx1):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if d <= r * r:
                    put(x, y, ring if d > (r - 9) ** 2 else fill)
        return cx, cy, r

    def blit(key, path):
        """Box-sample a PNG into a region, preserving its aspect (letterboxed).

        Letterboxing means the region aspect does not have to match the source:
        the graphic keeps its proportions and the spare margin stays
        transparent. Stretching an ISO sign would be worse than not using it.
        """
        if not os.path.exists(path):
            raise RuntimeError('pictogram missing: %s' % path)
        src = bpy.data.images.load(path, check_existing=True)
        sw, sh = src.size
        sp = list(src.pixels)
        gx0, gy0, gx1, gy1 = use(key)
        rw, rh = gx1 - gx0, gy1 - gy0
        scale = min(rw / float(sw), rh / float(sh))
        dw, dh = int(sw * scale), int(sh * scale)
        ox, oy = gx0 + (rw - dw) // 2, gy0 + (rh - dh) // 2
        # If the source has no usable alpha, key out its white background -
        # these signs are drawn on white, and a white box around a triangle
        # looks like a sticker that was cut out wrong.
        corner = sp[0:4]
        key_white = corner[3] > 0.9 and min(corner[0:3]) > 0.9
        step = max(int(1.0 / scale), 1)
        for dy in range(dh):
            for dx in range(dw):
                acc = [0.0, 0.0, 0.0, 0.0]
                n = 0
                for sy in range(int(dy / scale), min(int(dy / scale) + step, sh)):
                    for sx in range(int(dx / scale), min(int(dx / scale) + step, sw)):
                        i = (sy * sw + sx) * 4
                        acc[0] += sp[i]
                        acc[1] += sp[i + 1]
                        acc[2] += sp[i + 2]
                        acc[3] += sp[i + 3]
                        n += 1
                if not n:
                    continue
                r, g, b, a = (c / n for c in acc)
                if key_white and min(r, g, b) > 0.92:
                    continue
                if a < 0.04:
                    continue
                put(ox + dx, oy + dy, (r, g, b), a)
        bpy.data.images.remove(src)

    # --- hazard stripes ------------------------------------------------------
    x0, y0, x1, y1 = use('hazard')
    for y in range(y0, y1):
        for x in range(x0, x1):
            put(x, y, AMBER if ((x + (y1 - y) * 2) // 26) % 2 == 0 else DARK)

    # --- wordmark, real lettering --------------------------------------------
    x0, y0, x1, y1 = use('wordmark')
    text('REALVIRTUAL', (x0 + x1) / 2.0, (y0 + y1) / 2.0, 4, GREEN)

    # --- fleet number: the single most characteristic marking on an AGV ------
    x0, y0, x1, y1 = use('fleet')
    bar(x0, y0, x1 - x0, y1 - y0, DARK)
    bar(x0 + 5, y0 + 5, x1 - x0 - 10, y1 - y0 - 10, AMBER)
    text('02', (x0 + x1) / 2.0, (y0 + y1) / 2.0, 12, DARK)

    # --- charging: a PLUG. The previous symbol read as a plus sign, which at a
    # charging interface points at a terminal polarity instead.
    cx, cy, r = disc('charge', DARK, PLATE)
    bar(cx - 16, cy - 4, 32, 8, DARK)
    bar(cx - 9, cy + 4, 5, 14, DARK)
    bar(cx + 4, cy + 4, 5, 14, DARK)
    bar(cx - 4, cy - 20, 8, 16, DARK)

    # --- real ISO 7010 artwork instead of hand-drawn symbols ----------------
    blit('electrical', PICTOGRAMS['electrical'])   # W012 electricity
    blit('laser', PICTOGRAMS['laser'])             # W004 laser beam
    blit('no_stand', PICTOGRAMS['no_stand'])       # W015 overhead load
    blit('crush', PICTOGRAMS['crush'])             # W024 crushing of hands
    blit('barcode', PICTOGRAMS['barcode'])

    # --- nameplate -----------------------------------------------------------
    x0, y0, x1, y1 = use('nameplate')
    bar(x0, y0, x1 - x0, y1 - y0, (0.70, 0.72, 0.75))
    bar(x0 + 5, y0 + 5, x1 - x0 - 10, y1 - y0 - 10, PLATE)
    text('REALVIRTUAL', (x0 + x1) / 2.0, y1 - 24, 3, DARK)
    text('AGV STACKER', (x0 + x1) / 2.0, y1 - 47, 3, DARK)
    text('1400 KG - 1200 MM', (x0 + x1) / 2.0, y1 - 68, 2, DARK)
    text('SN 2026-0042', (x0 + x1) / 2.0, y1 - 88, 2, DARK)

    # --- warning triangle: still hand-drawn, the package has no W001 --------
    cx, by, th = triangle('warning', 9)
    bar(cx - 7, by + th * 0.30, 14, th * 0.36, DARK)
    bar(cx - 7, by + th * 0.15, 14, th * 0.10, DARK)

    # --- vent grille ---------------------------------------------------------
    x0, y0, x1, y1 = use('vent')
    for r2 in range((y1 - y0) // 14):
        bar(x0 + 8, y0 + 8 + r2 * 14, x1 - x0 - 16, 7, (0.13, 0.14, 0.16))

    # --- capacity plate ------------------------------------------------------
    x0, y0, x1, y1 = use('capacity')
    bar(x0, y0, x1 - x0, y1 - y0, (0.16, 0.17, 0.19))
    bar(x0 + 5, y0 + 5, x1 - x0 - 10, y1 - y0 - 10, PLATE)
    text('1400 KG', (x0 + x1) / 2.0, y1 - 24, 3, DARK)
    for i in range(4):
        bar(x0 + 16, y0 + 12 + i * 11, 112 - i * 24, 6, (0.22, 0.45, 0.78))

    if spill:
        raise RuntimeError('atlas drawing spilled outside its region: '
                           + ', '.join('%s %d px' % kv for kv in sorted(spill.items())))
    img.pixels = px
    img.pack()
    return img


DECAL_REF = None
_DECALS = []


def decal(name, w, h, loc, material, u0, v0, u1, v1, rot=(0, 0, 0)):
    """A thin plane aimed at one region of the decal atlas."""
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = Vector((w, h, 1.0))
    ob.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    # A region that is wider-than-tall painted onto a taller-than-wide plane is a
    # stretched graphic, and it is easy to miss by eye. The arrow was 49% off.
    ar_px = ((u1 - u0) * ATLAS_W) / max((v1 - v0) * ATLAS_H, 1e-6)
    ar_m = w / max(h, 1e-6)
    if not (0.96 <= ar_m / ar_px <= 1.04):
        print('WARNING: %s is %.0f%% out of aspect (atlas %.2f, plane %.2f)'
              % (name, abs(ar_m / ar_px - 1) * 100, ar_px, ar_m))

    # A decal whose normal points INTO the body shows its back face, and every
    # glyph on it reads mirrored. Both flanks were wrong this way: the rotation
    # that yields a +X normal had been given to the -X side.
    if DECAL_REF is not None:
        # Read the POLYGON normal: decal() bakes the rotation into the mesh with
        # transform_apply, so the object matrix is rotation-free by this point
        # and would always report (0, 0, 1).
        n = ob.data.polygons[0].normal.copy()
        out = Vector(loc) - Vector(DECAL_REF)
        if n.dot(out) <= 0.0:
            raise RuntimeError('%s faces into the machine (normal %s, outward %s)'
                               ' - it would render mirrored'
                               % (name, tuple(round(v, 2) for v in n),
                                  tuple(round(v, 2) for v in out)))

    uv = ob.data.uv_layers.active.data
    corners = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
    for i, c in enumerate(corners):
        uv[i].uv = c
    ob.data.materials.append(material)
    _DECALS.append(ob)
    return ob


def decal_cyl(name, arc_w, h, centre, radius, theta_mid, material,
              u0, v0, u1, v1, segments=12):
    """A decal that WRAPS a cylinder instead of floating in front of it.

    A flat plane on a round housing stands off at its edges - visible as soon as
    the label is more than a few degrees wide. This builds a strip of quads that
    follows the surface, so the label sits on the housing all the way across.
    """
    arc = arc_w / radius
    verts, faces, uvs = [], [], []
    for i in range(segments + 1):
        t = theta_mid + (i / float(segments) - 0.5) * arc
        x = centre[0] + radius * math.cos(t)
        y = centre[1] + radius * math.sin(t)
        verts.append((x, y, centre[2] - h / 2.0))
        verts.append((x, y, centre[2] + h / 2.0))
    for i in range(segments):
        faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))

    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)

    # Wind the faces so the normal points AWAY from the cylinder axis; built the
    # other way round the label renders mirrored, exactly like a flat decal
    # whose rotation was given the wrong sign.
    me.polygons[0].normal_update() if hasattr(me.polygons[0], 'normal_update') else None
    p = me.polygons[0]
    cen = Vector(p.center)
    radial = Vector((cen.x - centre[0], cen.y - centre[1], 0.0))
    if p.normal.dot(radial) < 0.0:
        me.flip_normals()

    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            col = vi // 2
            top = vi % 2
            uvl.data[li].uv = (u0 + (u1 - u0) * col / float(segments),
                               v1 if top else v0)
    ob.data.materials.append(material)

    ar_px = ((u1 - u0) * ATLAS_W) / max((v1 - v0) * ATLAS_H, 1e-6)
    ar_m = arc_w / max(h, 1e-6)
    if not (0.96 <= ar_m / ar_px <= 1.04):
        print('WARNING: %s is %.0f%% out of aspect (atlas %.2f, decal %.2f)'
              % (name, abs(ar_m / ar_px - 1) * 100, ar_px, ar_m))
    _DECALS.append(ob)
    return ob


def scale_uv(ob, su, sv):
    """Repeat a tiling texture along the object, in place."""
    for d in ob.data.uv_layers.active.data:
        d.uv = (d.uv[0] * su, d.uv[1] * sv)


def tri_count():
    total = 0
    for ob in bpy.context.scene.objects:
        if ob.type == 'MESH':
            ob.data.calc_loop_triangles()
            total += len(ob.data.loop_triangles)
    return total


def bake_vertex_ao(strength=0.55, samples=24, distance=0.055):
    sc = bpy.context.scene
    prev = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.render.bake.margin = 0
    if sc.world is None:
        sc.world = bpy.data.worlds.new('World')
    # Reach matters more than strength: unlimited AO lets every one of these
    # interpenetrating bodies shadow its neighbour across whole faces.
    sc.world.light_settings.distance = distance

    # Decal planes are zero-thickness and sit flush on a surface; AO on them is
    # just noise from the body they lie against, so keep them out of the bake.
    meshes = [o for o in sc.objects
              if o.type == 'MESH' and not o.name.startswith('Decal_')]
    for ob in meshes:
        if not ob.data.color_attributes:
            ob.data.color_attributes.new(name='Col', type='BYTE_COLOR',
                                         domain='CORNER')
        ob.data.color_attributes.active_color_index = 0
    # Decals skip the bake but still need the attribute: a consumer that
    # multiplies by a MISSING COLOR_0 gets black, not white. Give them a
    # neutral one so every primitive in the file carries the same attribute.
    for ob in sc.objects:
        if ob.type == 'MESH' and ob.name.startswith('Decal_'):
            if not ob.data.color_attributes:
                ca = ob.data.color_attributes.new(name='Col', type='BYTE_COLOR',
                                                  domain='CORNER')
                for d in ca.data:
                    d.color = (1.0, 1.0, 1.0, 1.0)

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    try:
        bpy.ops.object.bake(type='AO')
    except RuntimeError as exc:
        print('AO bake failed (%s)' % exc)
        sc.render.engine = prev
        return False
    for ob in meshes:
        for d in ob.data.color_attributes[0].data:
            c = d.color
            d.color = (1 - strength + strength * c[0],
                       1 - strength + strength * c[1],
                       1 - strength + strength * c[2], 1.0)
    sc.render.engine = prev
    bpy.ops.object.select_all(action='DESELECT')
    print('AO baked on %d meshes' % len(meshes))
    return True


# ----------------------------------------------------------------------- materials
clear_scene()

M_WHITE  = mat('AGV_BodyWhite',    (0.905, 0.915, 0.925), rough=0.26, coat=0.6)
M_DARK   = mat('AGV_BodyDark',     (0.055, 0.060, 0.070), rough=0.36)
M_GREY   = mat('AGV_Housing',      (0.225, 0.240, 0.260), rough=0.42)
M_FRAME  = mat('AGV_Frame',        (0.140, 0.150, 0.165), rough=0.40, metal=0.65)
M_GREEN  = mat('AGV_AccentGreen',  (0.255, 0.760, 0.235), rough=0.33)
M_BRASS  = mat('AGV_SafetyPlate',  (0.78, 0.64, 0.22),    rough=0.38, metal=0.6)
M_RUBBER = mat('AGV_Rubber',       (0.040, 0.040, 0.045), rough=0.88)

M_LAMP_RED   = mat('AGV_Lamp_Red',   (0.55, 0.04, 0.04), rough=0.22,
                   emit=(1.0, 0.07, 0.05), emit_strength=4.0)
M_LAMP_WHITE = mat('AGV_Lamp_White', (0.80, 0.84, 0.88), rough=0.20,
                   emit=(1.0, 1.0, 0.96), emit_strength=2.4)
M_LAMP_GREEN = mat('AGV_Lamp_Green', (0.08, 0.45, 0.12), rough=0.22,
                   emit=(0.10, 0.85, 0.18), emit_strength=1.1)
M_SCREEN = mat('AGV_Screen', (0.02, 0.05, 0.10), rough=0.18,
               image=make_screen_image(), emit_strength=1.4, interp='Closest')

# Texture-backed materials. Each strand gets its OWN chain material: the strands
# are scaled in Z to lift, which stretches their UVs, so whoever animates them
# has to counter-scale the texture repeat per strand - impossible if they share
# one material.
_CHAIN_IMG = make_chain_image()
M_CHAIN_A = mat('AGV_Chain_Fixed', (0.10, 0.10, 0.11), rough=0.52, metal=0.75,
                image=_CHAIN_IMG)
M_CHAIN_B = mat('AGV_Chain_Carriage', (0.10, 0.10, 0.11), rough=0.52, metal=0.75,
                image=_CHAIN_IMG)
M_TREAD = mat('AGV_Tread', (0.05, 0.05, 0.055), rough=0.90,
              image=make_tread_image())
M_DECAL = mat('AGV_Decals', (1, 1, 1), rough=0.40, image=make_decal_atlas())
M_DECAL.blend_method = 'BLEND'
_dtex = [n for n in M_DECAL.node_tree.nodes if n.type == 'TEX_IMAGE'][0]
M_DECAL.node_tree.links.new(
    _dtex.outputs['Alpha'],
    M_DECAL.node_tree.nodes['Principled BSDF'].inputs['Alpha'])
M_HALO = mat('AGV_Lamp_Halo', (1.0, 0.12, 0.08), rough=1.0,
             emit=(1.0, 0.12, 0.08), emit_strength=0.7, alpha=0.07)

# Laser scanner. The emitting band is bright enough to pass the bloom
# threshold; the swept field is kept very faint, because at 1.8 m radius it
# covers a large part of the frame and would otherwise swamp the machine.
M_SCAN_EMIT = mat('AGV_Scanner_Beam', (0.60, 0.03, 0.03), rough=0.20,
                  emit=(1.0, 0.05, 0.04), emit_strength=3.2)
M_SCAN_FIELD = mat('AGV_Scanner_Field', (1.0, 0.08, 0.06), rough=1.0,
                   emit=(1.0, 0.08, 0.06), emit_strength=2.2, alpha=0.20)

# ------------------------------------------------------------------------ geometry
root = empty('AGV_Stacker', (0, 0, 0))

# =================================================================== skid
chassis = empty('Chassis', (0, 0, 0))
parent_to(chassis, root)

SKID_FRONT = -0.030
SKID_L = SKID_FRONT - Y_REAR
skid = box('Skid_Plate', (WIDTH, SKID_L, SKID_H),
           (0, (Y_REAR + SKID_FRONT) / 2.0, SKID_H / 2.0), M_GREY,
           bevel=0.028, segments=3)
shrink_above(skid, SKID_H * 0.45, 0.93, 0.97)
parent_to(skid, chassis)

for sx, tag in ((-1, 'L'), (1, 'R')):
    bump = cyl('Skid_Bumper_%s' % tag, 0.026, 0.055,
               (sx * (WIDTH / 2.0 - 0.055), Y_REAR + 0.030, SKID_H + 0.020),
               M_DARK, axis='Z', verts=12)
    parent_to(bump, chassis)

for i, z in enumerate((0.108, 0.162)):
    p = box('Skid_SafetyPlate_%d' % (i + 1), (0.190, 0.014, 0.038),
            (-0.055, Y_REAR + 0.004, z), M_BRASS, bevel=0.004)
    parent_to(p, chassis)

# =================================================================== pod
POD_H = POD_TOP - SKID_H
pod = box('Pod_Body', (POD_W, POD_LEN - 0.015, POD_H),
          (0, Y_POD_MID, SKID_H + POD_H / 2.0), M_WHITE, bevel=0.075, segments=5,
          angle=30)
shrink_above(pod, SKID_H + POD_H * 0.52, 0.90, 0.86)
drop_front(pod, z_from=SKID_H + POD_H * 0.60, drop=0.105)
parent_to(pod, chassis)

wrap = box('Pod_Wrap', (POD_W + 0.006, POD_LEN - 0.008, 0.115),
           (0, Y_POD_MID, SKID_H + 0.058), M_GREY, bevel=0.030, segments=3)
parent_to(wrap, chassis)

# --- face ---------------------------------------------------------------------
y_face = Y_REAR + 0.008
face_out = box('Pod_FaceOutline', (0.410, 0.016, 0.420),
               (0, y_face + 0.004, 0.560), M_GREEN, bevel=0.055, segments=4,
               angle=30)
parent_to(face_out, chassis)
face = box('Pod_Face', (0.372, 0.020, 0.382), (0, y_face, 0.560), M_DARK,
           bevel=0.048, segments=4, angle=30)
parent_to(face, chassis)
for sx, tag in ((-1, 'L'), (1, 'R')):
    eye = box('Lamp_Eye_%s' % tag, (0.078, 0.014, 0.022),
              (sx * 0.072, y_face - 0.006, 0.600), M_LAMP_WHITE, bevel=0.005)
    parent_to(eye, chassis)

for i in range(3):
    ch = box('Lamp_Status_%d' % (i + 1), (0.014, 0.165, 0.030),
             (POD_W / 2.0 - 0.020, Y_POD_MID + 0.020, 0.560 + i * 0.080),
             M_LAMP_GREEN, bevel=0.004)
    ch.rotation_euler[0] = math.radians(20)
    parent_to(ch, chassis)

# --- shut lines: thin recessed grooves, so the housing reads as panels --------
# These are cheap (about 40 triangles each) and they are where the baked AO
# collects, which is what actually sells them.
bpy.context.view_layer.update()
for z in (SKID_H + 0.190, POD_TOP - 0.145):
    hw, y0s, y1s = body_section(pod, z)
    g = box('Pod_ShutLine_%d' % int(z * 1000),
            (2 * hw + 0.003, (y1s - y0s) - 0.030, 0.005),
            (0, (y0s + y1s) / 2.0, z), M_GREY, bevel=0.002)
    parent_to(g, chassis)

# --- decals, all from the one atlas ------------------------------------------
# Twelve graphics, ONE material. Placement follows what the machine actually
# needs, not what was easy to put somewhere:
#   * the fleet number is the most characteristic marking on an AGV - the
#     vendor's own fleet software labels this vehicle "02". It replaces the
#     invented travel-direction arrow, which real AGVs do not carry.
#   * the type plate moved off the removable cowling onto the skirt: swap the
#     cowling and the machine would otherwise lose its identity.
#   * "do not stand under the load" moved to the mast, where the hazard is.
#     On the rear flank nobody at risk would ever see it.
#   * hazard stripes now on BOTH ends - a vehicle that drives itself needs the
#     hi-vis marking where it can hit something, not only at the back.
R = region_uv
RX, RY = math.radians(90), math.radians(90)
DECAL_REF = (0.0, Y_POD_MID, 0.45)   # reference point decals must face away from

y_dec = Y_REAR + 0.002
x_flank = POD_W / 2.0 + 0.004          # OUTSIDE the shell; POD_W/2 IS the surface
x_wrap = POD_W / 2.0 + 0.007           # the skirt stands slightly proud

for nm, reg, w, h, loc, rot in (
    # rear face
    ('Decal_Wordmark',   'wordmark',   0.300, 0.0659, (0, y_dec, 0.300),     (RX, 0, 0)),
    ('Decal_Charge',     'charge',     0.085, 0.085,  (0.215, y_dec, 0.130), (RX, 0, 0)),
    ('Decal_Electrical', 'electrical', 0.082, 0.0713,  (0.215, y_dec, 0.228), (RX, 0, 0)),
    # left flank
    ('Decal_Warning',    'warning',    0.135, 0.1174,  (-x_flank, Y_POD_MID - 0.085, 0.300), (RX, 0, -RY)),
    ('Decal_Fleet_L',    'fleet',      0.140, 0.0997, (-x_flank, Y_POD_MID + 0.131, 0.300), (RX, 0, -RY)),
    # type plate on the SKIRT, which is structure, not a removable cowling
    ('Decal_Nameplate',  'nameplate',  0.185, 0.103,  (-x_wrap, Y_POD_MID + 0.060, 0.126), (RX, 0, -RY)),
    ('Decal_Barcode',    'barcode',    0.150, 0.028,  (-x_flank, Y_POD_MID - 0.085, 0.430), (RX, 0, -RY)),
    # right flank
    ('Decal_Vent',       'vent',       0.225, 0.1125, (x_flank, Y_POD_MID - 0.060, 0.330), (RX, 0, RY)),
    ('Decal_Fleet_R',    'fleet',      0.140, 0.0997, (x_flank, Y_POD_MID + 0.131, 0.300), (RX, 0, RY)),
    # skid, both ends
    ('Decal_Hazard_R',   'hazard',     0.480, 0.0498, (0, Y_REAR - 0.001, 0.036),   (RX, 0, 0)),
    ('Decal_Hazard_F',   'hazard',     0.480, 0.0498, (0, SKID_FRONT + 0.001, 0.036), (RX, 0, math.radians(180))),
):
    d = decal(nm, w, h, loc, M_DECAL, *R(reg), rot=rot)
    parent_to(d, chassis)

# Roof marking: the fleet number, big enough to read from a gantry camera.
# Do not compute the roof height - MEASURE it. The roof is shaped by two mesh
# operations and reproducing their combined effect in a formula got it wrong
# twice: once buried 8 mm inside the shell, once unnoticed.
ROOF_Y = Y_POD_MID - 0.096
bpy.context.view_layer.update()
_dg = bpy.context.evaluated_depsgraph_get()
_hit, _loc, _nor, _i, _ob, _m = bpy.context.scene.ray_cast(
    _dg, (0.0, ROOF_Y, 2.0), (0.0, 0.0, -1.0))
if not _hit:
    raise RuntimeError('no roof under the fleet number at y=%.3f' % ROOF_Y)
print('roof under fleet number: %s at z=%.4f' % (_ob.name, _loc.z))
roofnum = decal('Decal_Fleet_Top', 0.168, 0.120, (0, ROOF_Y, _loc.z + 0.003),
                M_DECAL, *R('fleet'), rot=(0, 0, 0))
parent_to(roofnum, chassis)

# =================================================================== display head
head = empty('DisplayHead', (0, 0, 0))
parent_to(head, root)

# The neck must sit on the SAME Y as the shell it carries, or the monitor reads
# as floating next to a disconnected block.
NECK_Y = Y_POD_MID + 0.045
neck = box('Head_Neck', (0.200, 0.145, 0.145), (0, NECK_Y, POD_TOP - 0.020),
           M_GREY, bevel=0.020, segments=3)
parent_to(neck, head)

HEAD_H = HEAD_TOP - HEAD_BOT
shell = box('Head_Shell', (0.470, 0.072, HEAD_H),
            (0, NECK_Y, HEAD_BOT + HEAD_H / 2.0), M_GREY, bevel=0.020, segments=3)
shell.rotation_euler[0] = math.radians(-7)
parent_to(shell, head)

screen = box('Head_Screen', (0.412, 0.010, HEAD_H - 0.062),
             (0, NECK_Y - 0.042, HEAD_BOT + HEAD_H / 2.0 - 0.005), M_SCREEN,
             bevel=0.003)
screen.rotation_euler[0] = math.radians(-7)
parent_to(screen, head)

for i, (x, m) in enumerate(((-0.040, M_LAMP_RED), (0.010, M_LAMP_GREEN))):
    b = cyl('Head_Indicator_%d' % (i + 1), 0.012, 0.014,
            (x, NECK_Y - 0.034, HEAD_TOP + 0.010), m, axis='Z', verts=12)
    parent_to(b, head)
cam = box('Head_Camera', (0.056, 0.026, 0.022), (0.082, NECK_Y - 0.034,
          HEAD_TOP + 0.008), M_DARK, bevel=0.005)
parent_to(cam, head)

# =================================================================== mast
# Entirely BEHIND the fork heel plane: y -MAST_DEPTH .. 0.
mast = empty('Mast', (0, 0, 0))
parent_to(mast, root)

y_mast_mid = -MAST_DEPTH / 2.0
RAIL_Z0 = 0.055
RAIL_H = MAST_HEIGHT - RAIL_Z0
RAIL_ZC = RAIL_Z0 + RAIL_H / 2.0

# The rails are C-sections opening INWARD, not solid boxes - that channel is what
# the carriage rollers run in, so it has to be real geometry if the lift is ever
# to be shown working. Three parts per rail: outer web plus front and rear flange.
WEB_T, FLANGE_T, FLANGE_W = 0.013, 0.015, 0.070
for sx, tag in ((-1, 'L'), (1, 'R')):
    x_web = sx * (MAST_X + 0.036)
    web = box('Mast_Web_%s' % tag, (WEB_T, MAST_DEPTH, RAIL_H),
              (x_web, y_mast_mid, RAIL_ZC), M_FRAME, bevel=0.004)
    parent_to(web, mast)
    for fy, ftag in ((y_mast_mid + MAST_DEPTH / 2.0 - FLANGE_T / 2.0, 'F'),
                     (y_mast_mid - MAST_DEPTH / 2.0 + FLANGE_T / 2.0, 'R')):
        fl = box('Mast_Flange_%s%s' % (tag, ftag),
                 (FLANGE_W, FLANGE_T, RAIL_H),
                 (x_web - sx * FLANGE_W / 2.0, fy, RAIL_ZC), M_FRAME, bevel=0.004)
        parent_to(fl, mast)

mhead = box('Mast_Head', (2 * MAST_X + 0.105, MAST_DEPTH + 0.015, 0.105),
            (0, y_mast_mid, MAST_HEIGHT - 0.052), M_FRAME, bevel=0.014)
parent_to(mhead, mast)

# Lower tie between the rails - a mast of two unconnected posts reads as scenery.
tie = box('Mast_Tie', (2 * MAST_X + 0.030, 0.050, 0.060), (0, y_mast_mid, 0.145),
          M_FRAME, bevel=0.008)
parent_to(tie, mast)

# --- lift mechanism: 2:1 chain over a travelling sprocket ---------------------
# A cylinder lifting the carriage directly would need 2600 mm of extended length
# inside a 1798 mm mast - impossible. So the ram carries a sprocket, the chain is
# anchored to the mast on one side and to the carriage on the other, and the
# carriage travels TWICE the ram. Ram stroke is therefore LIFT_TRAVEL / 2.
Y_CYL = y_mast_mid - 0.010

barrel = cyl('Mast_CylBarrel', 0.042, CYL_BARREL_LEN,
             (0, Y_CYL, CYL_BARREL_Z0 + CYL_BARREL_LEN / 2.0), M_GREY, axis='Z')
parent_to(barrel, mast)

# LiftRam travels h/2 while Lift travels h. Everything that rides the piston
# hangs here, so the whole mechanism is driven by one number.
ram = empty('LiftRam', (0, Y_CYL, 0))
parent_to(ram, root)

rod = cyl('Mast_CylRod', 0.026, CYL_ROD_LEN,
          (0, Y_CYL, SPROCKET_Z0 - CYL_ROD_LEN / 2.0), M_GREY, axis='Z')
parent_to(rod, ram)

sprocket = cyl('Mast_ChainSprocket', SPROCKET_R, 0.022, (0, Y_CYL, SPROCKET_Z0),
               M_GREY, axis='X', verts=20)
parent_to(sprocket, ram)

# Fixed strand: anchored low on the mast, rises over the rear of the sprocket.
# Origin at the anchor, so lifting is a pure Z scale (0.885 -> 1.485 m).
y_chain_rear = Y_CYL - SPROCKET_R
anchor = box('Chain_Anchor', (0.046, 0.030, 0.040), (0, y_chain_rear,
             CHAIN_ANCHOR_Z), M_FRAME, bevel=0.005)
parent_to(anchor, mast)
chain_fixed = strip('Chain_Fixed', 0.018, 0.012, SPROCKET_Z0 - CHAIN_ANCHOR_Z,
                    (0, y_chain_rear, CHAIN_ANCHOR_Z), True, M_CHAIN_A)
scale_uv(chain_fixed, 1.0, (SPROCKET_Z0 - CHAIN_ANCHOR_Z) / CHAIN_PITCH_UV)
parent_to(chain_fixed, mast)

# Carriage strand: hangs off the front of the sprocket down to the carriage top.
# Origin at the sprocket, so it rides the ram and only needs scaling (0.697 ->
# 0.097 m). Parented to the ram for exactly that reason.
y_chain_front = Y_CYL + SPROCKET_R
chain_carr = strip('Chain_Carriage', 0.018, 0.012, SPROCKET_Z0 - CARRIAGE_TOP,
                   (0, y_chain_front, SPROCKET_Z0), False, M_CHAIN_B)
scale_uv(chain_carr, 1.0, (SPROCKET_Z0 - CARRIAGE_TOP) / CHAIN_PITCH_UV)
parent_to(chain_carr, ram)

# --- end stops, so the carriage has something to run against ------------------
for z, tag in ((0.098, 'Bottom'), (MAST_HEIGHT - 0.175, 'Top')):
    for sx in (-1, 1):
        st = box('Mast_EndStop_%s_%s' % (tag, 'L' if sx < 0 else 'R'),
                 (0.052, 0.058, 0.026), (sx * MAST_X, y_mast_mid, z), M_GREY,
                 bevel=0.004)
        parent_to(st, mast)

# --- bolt circles on the head and the tie -------------------------------------
for xs, z in (((-0.255, -0.085, 0.085, 0.255), MAST_HEIGHT - 0.052),
              ((-0.200, 0.200), 0.145)):
    for i, x in enumerate(xs):
        b = cyl('Mast_Bolt_%d_%d' % (int(z * 1000), i), 0.009, 0.010,
                # Rear face: on the front they protrude 9 mm into the plane the
                # pallet has to reach, and the clearance check catches it.
                (x, y_mast_mid - MAST_DEPTH / 2.0 - 0.004, z), M_GREY, axis='Y',
                verts=6)
        parent_to(b, mast)

# The hose has to BE somewhere. Free-floating up the middle of the mast it just
# reads as a stray line, so it runs against the cylinder barrel and is clamped.
HOSE_X = 0.050
hose = cyl('Mast_Hose', 0.011, CYL_BARREL_LEN - 0.04,
           (HOSE_X, Y_CYL - 0.030, CYL_BARREL_Z0 + CYL_BARREL_LEN / 2.0),
           M_DARK, axis='Z', verts=10)
parent_to(hose, mast)
for hz in (CYL_BARREL_Z0 + 0.075, CYL_BARREL_Z0 + CYL_BARREL_LEN - 0.075):
    cl = box('Mast_HoseClamp_%d' % int(hz * 1000), (0.040, 0.020, 0.018),
             (HOSE_X - 0.012, Y_CYL - 0.030, hz), M_GREY, bevel=0.003)
    parent_to(cl, mast)
fitting = cyl('Mast_HoseFitting', 0.015, 0.038,
              (HOSE_X, Y_CYL - 0.030, CYL_BARREL_Z0 + CYL_BARREL_LEN + 0.010),
              M_GREY, axis='Z', verts=10)
parent_to(fitting, mast)

# --- scanner on an arm sweeping back over the pod, offset so it stays visible
# No taper on the arm: it was cosmetic, and it turned the only flat face on
# this bracket into a sloped one. The laser label needs somewhere to lie flush.
arm = box('Mast_ScannerArm', (0.100, 0.290, 0.100),
          (SCANNER_X, y_mast_mid - 0.145, MAST_HEIGHT - 0.058), M_FRAME,
          bevel=0.022, segments=3)
parent_to(arm, mast)

Y_SCAN = y_mast_mid - 0.270
scan_foot = cyl('Scanner_Foot', 0.068, 0.032, (SCANNER_X, Y_SCAN,
                MAST_HEIGHT - 0.034), M_DARK, axis='Z')
parent_to(scan_foot, mast)
scan_win = cyl('Scanner_Window', 0.096, 0.042, (SCANNER_X, Y_SCAN,
               MAST_HEIGHT + 0.001), M_DARK, axis='Z')
parent_to(scan_win, mast)

# The emitting band itself, just proud of the dark window so it reads as the
# source of the scan rather than a sticker on it.
scan_emit = cyl('Lamp_ScannerBeam', 0.0975, 0.016, (SCANNER_X, Y_SCAN,
                MAST_HEIGHT + 0.001), M_SCAN_EMIT, axis='Z')
parent_to(scan_emit, mast)

# --- scan field: the horizontal sweep of the LiDAR ---------------------------
# An annulus, not a full disc. A disc centred on the scanner cuts straight
# through the mast head and rails and tints them red - measured, everything
# around the scanner sits within 0.554 m, so the ring starts at 0.62 m.
# The blind sector matches what the mast head actually occludes, 10..154 deg
# seen from the scanner, so the gap in the ring is physically the right one.
# Short and local: the point is to SEE the scanner working, not to show a
# true scan range. The angular limits stay as measured - the arm, the left
# rail and the head sit inside this radius band and the field must not cross
# them.
SCAN_RI, SCAN_RO, SCAN_SEG = 0.18, 0.40, 28
SCAN_FROM, SCAN_TO = math.radians(160), math.radians(365)
_v, _f = [], []
for i in range(SCAN_SEG + 1):
    a_ = SCAN_FROM + (SCAN_TO - SCAN_FROM) * i / float(SCAN_SEG)
    ca, sa = math.cos(a_), math.sin(a_)
    _v.append((SCANNER_X + SCAN_RI * ca, Y_SCAN + SCAN_RI * sa,
               MAST_HEIGHT + 0.001))
    _v.append((SCANNER_X + SCAN_RO * ca, Y_SCAN + SCAN_RO * sa,
               MAST_HEIGHT + 0.001))
for i in range(SCAN_SEG):
    _f.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
_me = bpy.data.meshes.new('Scanner_ScanField')
_me.from_pydata(_v, [], _f)
_me.update()
scan_field = bpy.data.objects.new('Scanner_ScanField', _me)
bpy.context.collection.objects.link(scan_field)
scan_field.data.materials.append(M_SCAN_FIELD)
# NOTE: shadow casting is NOT set here. visible_shadow is a Blender object
# property and glTF carries no shadow flag, so anything set here is lost on
# export - the renderer has to do it after import. Setting it here looked like
# a fix and changed nothing.
parent_to(scan_field, mast)
scan_body = cyl('Scanner_Body', 0.100, 0.060, (SCANNER_X, Y_SCAN,
                MAST_HEIGHT + 0.052), M_WHITE, axis='Z', bevel=0.014)
parent_to(scan_body, mast)

# --- mast decals (need y_mast_mid, which only exists here) --------------------
# A decal on a rail face can be at most MAST_DEPTH wide - the capacity plate was
# 150 mm on a 105 mm rail and hung 22 mm off each edge into thin air.
RAIL_FACE_X = MAST_X + 0.036 + 0.0075
MAX_RAIL_W = MAST_DEPTH - 0.008

for nm, reg, w, h, sx, z in (
    ('Decal_Capacity', 'capacity', 0.095, 0.0595, -1, 0.640),
    ('Decal_NoStand',  'no_stand', 0.090, 0.0964, -1, 0.830),
    ('Decal_Crush',    'crush',    0.095, 0.0826, +1, 0.600),
):
    if w > MAX_RAIL_W:
        raise RuntimeError('%s is %.0f mm wide on a %.0f mm rail face'
                           % (nm, w * 1000, MAX_RAIL_W * 1000))
    d = decal(nm, w, h, (sx * RAIL_FACE_X, y_mast_mid, z), M_DECAL, *region_uv(reg),
              rot=(math.radians(90), 0, sx * math.radians(90)))
    parent_to(d, mast)

# Laser class marking belongs ON the scanner housing - and the housing is a
# cylinder, so the label has to follow it. SCANNER_BODY_R + 0.5 mm keeps it just
# clear of the surface without floating.
# Flat on the bracket, not wrapped around the round housing. A cylinder of
# this size is faceted, so even a curved decal stands off its facet planes by
# about a millimetre - and at the silhouette it reads as hanging off the edge.
# The support is a plain vertical face and has none of those problems.
# decal_cyl() stays available for anything that genuinely needs wrapping.
ARM_HALF_W = 0.050
scan_label = decal('Decal_LaserScanner', 0.078, 0.0678,
                   (SCANNER_X - ARM_HALF_W - 0.0016, y_mast_mid - 0.145,
                    MAST_HEIGHT - 0.058), M_DECAL, *region_uv('laser'),
                   rot=(math.radians(90), 0, math.radians(-90)))
parent_to(scan_label, mast)

# =================================================================== lift
lift = empty('Lift', (0, 0, 0))
parent_to(lift, root)

CARR_D = 0.054
carriage = box('Carriage', (2 * MAST_X + 0.040, CARR_D, 0.280),
               (0, -CARR_D / 2.0, CARRIAGE_BASE + 0.165), M_FRAME, bevel=0.010)
parent_to(carriage, lift)

for sx, tag in ((-1, 'L'), (1, 'R')):
    shoe = box('Carriage_Shoe_%s' % tag, (0.050, 0.086, 0.230),
               (sx * MAST_X, y_mast_mid, CARRIAGE_BASE + 0.180), M_GREY,
               bevel=0.008)
    parent_to(shoe, lift)
    # Guide rollers running inside the rail channel, two per side.
    for i, z in enumerate((CARRIAGE_BASE + 0.082, CARRIAGE_BASE + 0.272)):
        r = cyl('Carriage_Roller_%s%d' % (tag, i + 1), 0.026, 0.024,
                (sx * (MAST_X + 0.022), y_mast_mid, z), M_GREY, axis='X',
                verts=12)
        parent_to(r, lift)

# Load sensor on the carriage, ABOVE pallet height. At fork level it would sit
# inside the pallet's middle block.
fork_scan = box('Load_Sensor', (0.105, 0.058, 0.058), (0, -0.018, 0.330),
                M_DARK, bevel=0.009)
parent_to(fork_scan, lift)

for sx, tag in ((-1, 'L'), (1, 'R')):
    f = box('Fork_%s' % tag, (FORK_WIDTH, FORK_LEN, FORK_BLADE_THICK),
            (sx * FORK_CC / 2.0, FORK_LEN / 2.0,
             FORK_BLADE_CLEAR + FORK_BLADE_THICK / 2.0), M_FRAME, bevel=0.005)
    taper_fork_tip(f, tip_y=FORK_LEN)
    parent_to(f, lift)

    # L-shank: the thick section lives behind the heel plane, inside the mast
    # depth, where there is room for it. Its bottom is level with the blade
    # bottom, so at lift 0 it clears the wheel arm running underneath.
    shank = box('Fork_Shank_%s' % tag, (FORK_WIDTH, 0.070, 0.160),
                (sx * FORK_CC / 2.0, -0.035, FORK_BLADE_CLEAR + 0.080), M_FRAME,
                bevel=0.007)
    parent_to(shank, lift)

# Fork-top anchor for the load handover (plan-612): an Empty on the blade top at
# the pallet centre. A carried pallet is attached here, so it rides the Lift.
fork_anchor = empty('ForkAnchor', (0, PALLET_MID_Y, Z_BLADE_TOP))
parent_to(fork_anchor, lift)

# =================================================================== wheel arms
# Two flat arms on the CHASSIS under the forks, each carrying one load roller.
# A solid arm up to the roller, two cheek plates around it and a nose ahead of
# it, so the roller stays visible from the side.
ARM_ROLLER_GAP = 0.006
_arm_rear_end = Y_LOAD_WHEEL - LOAD_WHEEL_R - ARM_ROLLER_GAP
_arm_nose_y0 = Y_LOAD_WHEEL + LOAD_WHEEL_R + ARM_ROLLER_GAP
for sx, tag in ((-1, 'L'), (1, 'R')):
    cx = sx * FORK_CC / 2.0
    arm = box('Chassis_WheelArm_%s' % tag,
              (ARM_W, _arm_rear_end - ARM_Y0, ARM_H),
              (cx, (ARM_Y0 + _arm_rear_end) / 2.0, ARM_H / 2.0), M_FRAME,
              bevel=0.006)
    parent_to(arm, chassis)
    for cs, ctag in ((-1, 'I'), (1, 'O')):
        cheek = box('Chassis_WheelArm_%s_Cheek%s' % (tag, ctag),
                    (0.012, _arm_nose_y0 - _arm_rear_end + 0.020, ARM_H - 0.004),
                    (cx + cs * 0.034, Y_LOAD_WHEEL, (ARM_H - 0.004) / 2.0 + 0.002),
                    M_FRAME, bevel=0.002)
        parent_to(cheek, chassis)
    nose = box('Chassis_WheelArm_%s_Nose' % tag,
               (ARM_W - 0.020, ARM_TIP - _arm_nose_y0, ARM_H - 0.010),
               (cx, (_arm_nose_y0 + ARM_TIP) / 2.0, (ARM_H - 0.010) / 2.0 + 0.002),
               M_FRAME, bevel=0.008)
    parent_to(nose, chassis)
    w = cyl('Wheel_Load%s' % tag, LOAD_WHEEL_R, 0.050,
            (cx, Y_LOAD_WHEEL, LOAD_WHEEL_R), M_RUBBER, axis='X')
    parent_to(w, chassis)

# =================================================================== wheels
# Steer is its own node sitting exactly on the drive wheel's vertical axis, so a
# Drive can rotate it about the vertical while the wheel below spins about its
# own axle. Without this split the two motions cannot be driven independently.
steer = empty('Steer', (0, Y_DRIVE_WHEEL, DRIVE_WHEEL_R))
parent_to(steer, chassis)

drive_house = box('Wheel_DriveHousing', (0.150, 0.165, 0.130),
                  (0, Y_DRIVE_WHEEL, DRIVE_WHEEL_R + 0.090), M_GREY, bevel=0.012)
parent_to(drive_house, steer)
drive = cyl('Wheel_Drive', DRIVE_WHEEL_R, 0.082, (0, Y_DRIVE_WHEEL, DRIVE_WHEEL_R),
            M_TREAD, axis='X')
scale_uv(drive, 3.0, 1.0)
parent_to(drive, steer)

for sx, tag in ((-1, 'L'), (1, 'R')):
    c = cyl('Wheel_Caster%s' % tag, CASTER_R, 0.040,
            (sx * (WIDTH / 2.0 - 0.090), Y_CASTER, CASTER_R), M_TREAD, axis='X')
    scale_uv(c, 2.0, 1.0)
    parent_to(c, chassis)

# ======================================== personnel protection scanners
# Two units let into the rear corners of the skid, scanning just above the
# floor. Their fields are NOT a free choice: measured against the machine
# outline in the scan plane, each corner only sees 149 deg - the forks reaching
# 1.15 m forward block everything ahead. Drawing a textbook 270 deg fan would
# mean drawing a field straight through our own forks and load.
SAFETY_Z = 0.150
SAFETY_RI, SAFETY_RO, SAFETY_SEG = 0.13, 0.36, 24
SAFETY = (
    ('L', -0.360, -0.500, 213.0, 353.0),
    ('R', +0.360, -0.500, 187.0, 327.0),
)

for tag, sx_, sy_, a0, a1 in SAFETY:
    hous = box('Safety_Scanner_%s' % tag, (0.112, 0.112, 0.120),
               (sx_, sy_, SAFETY_Z), M_DARK, bevel=0.012)
    parent_to(hous, chassis)
    cap = box('Safety_Cap_%s' % tag, (0.100, 0.100, 0.018),
              (sx_, sy_, SAFETY_Z + 0.066), M_GREY, bevel=0.005)
    parent_to(cap, chassis)

    # The emitting band. Named Lamp_* so the viewer's Lamp component can drive
    # it - a safety scanner that goes red on a stop is worth seeing.
    beam = cyl('Lamp_SafetyBeam_%s' % tag, 0.059, 0.026, (sx_, sy_, SAFETY_Z),
               M_SCAN_EMIT, axis='Z', verts=20)
    parent_to(beam, chassis)

    _v, _f = [], []
    for i in range(SAFETY_SEG + 1):
        ang = math.radians(a0 + (a1 - a0) * i / float(SAFETY_SEG))
        ca, sa = math.cos(ang), math.sin(ang)
        _v.append((sx_ + SAFETY_RI * ca, sy_ + SAFETY_RI * sa, SAFETY_Z))
        _v.append((sx_ + SAFETY_RO * ca, sy_ + SAFETY_RO * sa, SAFETY_Z))
    for i in range(SAFETY_SEG):
        _f.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    _m2 = bpy.data.meshes.new('Safety_Field_%s' % tag)
    _m2.from_pydata(_v, [], _f)
    _m2.update()
    fld = bpy.data.objects.new('Safety_Field_%s' % tag, _m2)
    bpy.context.collection.objects.link(fld)
    fld.data.materials.append(M_SCAN_FIELD)
    parent_to(fld, chassis)

# =================================================================== lamps
lamps = empty('Lamps', (0, 0, 0))
parent_to(lamps, root)

beacon_base = cyl('Beacon_Base', 0.045, 0.026, (SCANNER_X, Y_SCAN,
                  MAST_HEIGHT + 0.095), M_DARK, axis='Z')
parent_to(beacon_base, lamps)
lamp_beacon = cyl('Lamp_Beacon', 0.043, 0.058, (SCANNER_X, Y_SCAN,
                  MAST_HEIGHT + 0.137), M_LAMP_RED, axis='Z', bevel=0.010)
parent_to(lamp_beacon, lamps)

bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.018, radius2=0.098,
                                depth=0.200,
                                location=(SCANNER_X, Y_SCAN, MAST_HEIGHT + 0.030))
halo = bpy.context.active_object
halo.name = 'Lamp_Beacon_Halo'
halo.data.materials.append(M_HALO)
parent_to(halo, lamps)

# Pallet seat: 10 mm clear of the carriage, on top of the blades.
snap = empty('Snap-Load', (0, 0.010 + 0.600, Z_BLADE_TOP))
parent_to(snap, root)

# ------------------------------------------------ decals must not overlap
# Two decals can each be correctly oriented, correctly proportioned and inside
# their atlas region, and still sit on top of each other. Nothing caught the
# fleet number running 47 mm into the vent grille until somebody looked.
bpy.context.view_layer.update()
_boxes = []
for _d in _DECALS:
    _ws = [_d.matrix_world @ Vector(c) for c in _d.bound_box]
    _boxes.append((_d.name,
                   [min(v[i] for v in _ws) for i in range(3)],
                   [max(v[i] for v in _ws) for i in range(3)]))
_TOL = 0.002
_clashes = []
for _i in range(len(_boxes)):
    for _j in range(_i + 1, len(_boxes)):
        _na, _la, _ha = _boxes[_i]
        _nb, _lb, _hb = _boxes[_j]
        _ov = [min(_ha[k], _hb[k]) - max(_la[k], _lb[k]) for k in range(3)]
        if all(o > _TOL for o in _ov):
            _clashes.append('%s / %s by %.0fx%.0fx%.0f mm'
                            % (_na, _nb, _ov[0] * 1000, _ov[1] * 1000,
                               _ov[2] * 1000))
if _clashes:
    raise RuntimeError('decals overlap: ' + '; '.join(_clashes))
print('decals: %d placed, none overlapping' % len(_DECALS))

# ============================================ realvirtual components
# Components live in extras.realvirtual.<Type> on the node, which is what the
# viewer reads (schema: schema/v1/rv-odt.json). Writing them here rather than
# clicking them in the asset editor keeps the model reproducible: rebuild the
# script and the machine comes back fully wired.
#
# Axes: the export bakes Y-up into the data and no node carries a rotation, so
# a node's local axes ARE the glTF world axes. Lift travels +Y, the steering
# head turns about Y, wheels turn about their X axle.
#
# All lengths in mm and mm/s, angles in degrees - realvirtual convention.

def rv(ob, comp, props):
    """Attach one component to a node.

    Read back through to_dict(): ob.get() hands out a live IDPropertyGroup, and
    assigning one back inside a fresh dict crashes Blender outright
    (EXCEPTION_ACCESS_VIOLATION), not a Python error you can catch.
    """
    cur = ob.get('realvirtual')
    if hasattr(cur, 'to_dict'):
        cur = cur.to_dict()
    elif cur is None:
        cur = {}
    else:
        cur = dict(cur)
    cur[comp] = props
    ob['realvirtual'] = cur


def ref(path, component='realvirtual.Drive'):
    """A ComponentReference. The path is absolute and STARTS AT the scene root
    node, so it begins with the root's own name - a bare node name silently
    resolves to nothing. `componentType` is REQUIRED for a component target:
    without it the viewer resolves the reference to the bare NODE (a Drive_Gear
    master then has no position and the slave goes NaN). Unity form: namespaced
    type + index."""
    return {'type': 'ComponentReference', 'path': path,
            'componentType': component, 'componentIndex': 0}


def path_of(ob):
    """The node path the viewer resolves: root name first, '/'-joined.

    Computed from the live hierarchy instead of typed as a literal, so moving a
    node (the load rollers went from Lift to Chassis) cannot leave a stale
    reference behind."""
    parts = []
    while ob is not None:
        parts.append(ob.name)
        ob = ob.parent
    return '/'.join(reversed(parts))

# --- lift: 1200 mm of carriage travel ---------------------------------------
rv(lift, 'Drive', {
    'Direction': 'LinearY', 'UseLimits': True,
    'LowerLimit': 0.0, 'UpperLimit': LIFT_TRAVEL * 1000.0,
    'TargetSpeed': 250.0, 'Acceleration': 500.0, 'UseAcceleration': True,
    'StartPosition': 0.0,
})

# --- ram: the same motion at half the distance ------------------------------
# Not a second, independently commanded axis: the 2:1 chain reeving MAKES it
# half. Drive_Gear states that relationship instead of leaving two drives to be
# kept in sync by whoever writes the sequence.
rv(ram, 'Drive', {
    'Direction': 'LinearY', 'UseLimits': True,
    'LowerLimit': 0.0, 'UpperLimit': RAM_STROKE * 1000.0,
    'TargetSpeed': 125.0, 'Acceleration': 250.0, 'UseAcceleration': True,
})
rv(ram, 'Drive_Gear', {
    'MasterDrive': ref(path_of(lift)),
    'GearFactor': 0.5, 'Offset': 0.0,
})

# --- steering and traction --------------------------------------------------
rv(steer, 'Drive', {
    'Direction': 'RotationY', 'UseLimits': True,
    'LowerLimit': -95.0, 'UpperLimit': 95.0,
    'TargetSpeed': 60.0, 'Acceleration': 180.0, 'UseAcceleration': True,
})
rv(drive, 'Drive', {
    'Direction': 'RotationX', 'UseLimits': False,
    'TargetSpeed': 360.0, 'Acceleration': 720.0, 'UseAcceleration': True,
})

# Every other wheel is geared to the drive wheel by the ratio of the rolling
# radii, so the whole running gear turns consistently from one command.
for _ob, _r, _tag in ((bpy.data.objects['Wheel_CasterL'], CASTER_R, 'caster L'),
                      (bpy.data.objects['Wheel_CasterR'], CASTER_R, 'caster R'),
                      (bpy.data.objects['Wheel_LoadL'], LOAD_WHEEL_R, 'load L'),
                      (bpy.data.objects['Wheel_LoadR'], LOAD_WHEEL_R, 'load R')):
    rv(_ob, 'Drive', {'Direction': 'RotationX', 'UseLimits': False,
                      'TargetSpeed': 360.0})
    rv(_ob, 'Drive_Gear', {'MasterDrive': ref(path_of(drive)),
                           'GearFactor': DRIVE_WHEEL_R / _r, 'Offset': 0.0})

# --- lamps ------------------------------------------------------------------
# Period/Flashing differ by role: the beacon pulses, status and safety lamps
# are steady until a signal says otherwise.
LAMPS = (
    ('Lamp_Beacon', 3.0, True, 0.8),
    ('Lamp_ScannerBeam', 2.0, False, 1.0),
    ('Lamp_SafetyBeam_L', 2.0, False, 1.0),
    ('Lamp_SafetyBeam_R', 2.0, False, 1.0),
    ('Lamp_Eye_L', 1.6, False, 1.0),
    ('Lamp_Eye_R', 1.6, False, 1.0),
    ('Lamp_Status_1', 1.4, False, 1.0),
    ('Lamp_Status_2', 1.4, False, 1.0),
    ('Lamp_Status_3', 1.4, False, 1.0),
)
for _n, _i, _fl, _p in LAMPS:
    _o = bpy.data.objects.get(_n)
    if _o is None:
        raise RuntimeError('lamp node missing: %s' % _n)
    rv(_o, 'Lamp', {'Intensity': _i, 'Flashing': _fl, 'Period': _p,
                    'LampOn': False})

# Every ComponentReference must resolve against the hierarchy that is actually
# exported. A path that does not exist is dropped silently - the GLB loads, the
# component is there, and it simply never finds its master. Four of the five
# references here pointed at AGV_Stacker/Steer/... while Steer really sits
# under Chassis, and nothing complained.
_paths = {}


def _walk(ob, pre):
    p = (pre + '/' if pre else '') + ob.name
    _paths[p] = ob
    for c in ob.children:
        _walk(c, p)


for _o in bpy.context.scene.objects:
    if _o.parent is None:
        _walk(_o, '')

_bad = []
for _o in bpy.context.scene.objects:
    _rv = _o.get('realvirtual')
    if not _rv:
        continue
    for _ck, _cv in (_rv.to_dict() if hasattr(_rv, 'to_dict') else _rv).items():
        if not isinstance(_cv, dict):
            continue
        for _f, _val in _cv.items():
            if isinstance(_val, dict) and _val.get('type') == 'ComponentReference':
                if _val.get('path') not in _paths:
                    _bad.append('%s.%s.%s -> %r' % (_o.name, _ck, _f,
                                                    _val.get('path')))
if _bad:
    raise RuntimeError('ComponentReference points at a node that does not '
                       'exist: ' + '; '.join(_bad))

_wired = sum(1 for o in bpy.context.scene.objects if 'realvirtual' in o.keys())
_refs = sum(1 for o in bpy.context.scene.objects
            for c in ((o.get('realvirtual').to_dict()
                       if hasattr(o.get('realvirtual'), 'to_dict')
                       else (o.get('realvirtual') or {})) or {}).values()
            if isinstance(c, dict)
            for v in c.values()
            if isinstance(v, dict) and v.get('type') == 'ComponentReference')
print('components written on %d nodes, %d references all resolve'
      % (_wired, _refs))

# -------------------------------------------------------------------------- shade
for ob in bpy.context.scene.objects:
    if ob.type == 'MESH':
        bpy.context.view_layer.objects.active = ob
        ob.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(32))
        ob.select_set(False)

HAVE_AO = bake_vertex_ao()

# ------------------------------------------- geometry self-check (fail loudly)
# The pallet must clear the mast. Getting this wrong once was enough.
# Only parts that reach down into the pallet's own height band can hit it; the
# mast head sits at 1.75 m and would otherwise dominate this number and report a
# clearance that belongs to the wrong component.
PALLET_TOP_Z = 0.144
front_parts = [o for o in bpy.context.scene.objects
               if o.type == 'MESH'
               and (o.name.startswith('Mast_') or o.name.startswith('Carriage'))
               and (o.matrix_world.translation.z - o.dimensions.z / 2.0) < PALLET_TOP_Z]
if not front_parts:
    raise RuntimeError('clearance check found no mast/carriage parts at pallet '
                       'height - did the naming change?')
mast_front = max(o.matrix_world.translation.y + o.dimensions.y / 2.0
                 for o in front_parts)
carr_front = mast_front
print('governing part: %s' % max(front_parts,
      key=lambda o: o.matrix_world.translation.y + o.dimensions.y / 2.0).name)
pallet_rear = 0.010
obstruction = max(mast_front, carr_front)
print('mast/carriage front face: y = %+.4f' % obstruction)
print('pallet rear face        : y = %+.4f' % pallet_rear)
if pallet_rear < obstruction - 1e-6:
    print('ERROR: pallet intersects the mast by %.1f mm'
          % ((obstruction - pallet_rear) * 1000))
else:
    print('OK: %.1f mm clearance between pallet and mast'
          % ((pallet_rear - obstruction) * 1000))

# ------------------------------------------------- lift mechanism self-check
print()
print('--- lift mechanism (2:1 chain reeving) ---')
print('  carriage travel %.3f m  =  2 x ram stroke %.3f m' % (LIFT_TRAVEL,
                                                              RAM_STROKE))
head_bottom = (MAST_HEIGHT - 0.052) - 0.105 / 2.0
_fail = []
for h in (0.0, LIFT_TRAVEL):
    z_spr = SPROCKET_Z0 + h / 2.0
    z_car = CARRIAGE_TOP + h
    run = z_spr - z_car
    rod_bottom = (SPROCKET_Z0 - CYL_ROD_LEN) + h / 2.0
    print('  lift %4.0f mm | sprocket %.3f | carriage top %.3f | chain run %.3f'
          ' | rod bottom %.3f' % (h * 1000, z_spr, z_car, run, rod_bottom))
    if run < 0.060:
        _fail.append('chain run only %.0f mm at %.0f mm lift' % (run * 1000,
                                                                 h * 1000))
    if z_spr + SPROCKET_R > head_bottom:
        _fail.append('sprocket hits the mast head at %.0f mm lift' % (h * 1000))
    if rod_bottom > CYL_BARREL_Z0 + CYL_BARREL_LEN:
        _fail.append('rod leaves the barrel at %.0f mm lift' % (h * 1000))
    if rod_bottom < CYL_BARREL_Z0:
        _fail.append('rod punches through the barrel base at %.0f mm lift'
                     % (h * 1000))
print('  chain length check: fixed %.3f->%.3f, carriage %.3f->%.3f, sum %.3f/%.3f'
      % (SPROCKET_Z0 - CHAIN_ANCHOR_Z,
         SPROCKET_Z0 + RAM_STROKE - CHAIN_ANCHOR_Z,
         SPROCKET_Z0 - CARRIAGE_TOP,
         (SPROCKET_Z0 + RAM_STROKE) - (CARRIAGE_TOP + LIFT_TRAVEL),
         (SPROCKET_Z0 - CHAIN_ANCHOR_Z) + (SPROCKET_Z0 - CARRIAGE_TOP),
         (SPROCKET_Z0 + RAM_STROKE - CHAIN_ANCHOR_Z)
         + ((SPROCKET_Z0 + RAM_STROKE) - (CARRIAGE_TOP + LIFT_TRAVEL))))
if _fail:
    for f in _fail:
        print('  ERROR: %s' % f)
else:
    print('  OK: mechanism consistent over the full stroke')

# ------------------------------------------- running-gear report for the sim
# Contact points are what the motion model consumes, so print them explicitly
# rather than leaving them to be measured off the mesh later.
print()
print('--- running gear (contact points, metres) ---')
print('  drive wheel   x  0.000   y %+.3f   r %.3f   steered, axis through its centre'
      % (Y_DRIVE_WHEEL, DRIVE_WHEEL_R))
print('  load roller L x %+.3f   y %+.3f   r %.3f   fixed, in the chassis wheel arm'
      % (-FORK_CC / 2.0, Y_LOAD_WHEEL, LOAD_WHEEL_R))
print('  load roller R x %+.3f   y %+.3f   r %.3f   fixed, in the chassis wheel arm'
      % (+FORK_CC / 2.0, Y_LOAD_WHEEL, LOAD_WHEEL_R))
for sx, tag in ((-1, 'L'), (1, 'R')):
    print('  caster %s      x %+.3f   y %+.3f   r %.3f   passive'
          % (tag, sx * (WIDTH / 2.0 - 0.090), Y_CASTER, CASTER_R))
wheelbase = Y_LOAD_WHEEL - Y_DRIVE_WHEEL
r_check = math.hypot(Y_LOAD_WHEEL - Y_REAR, WIDTH / 2.0)
print('  wheelbase (drive -> load axle): %.3f m' % wheelbase)
print('  pivot at full lock            : (0.000, %+.3f)' % Y_LOAD_WHEEL)
print('  turning radius to rear corner : %.3f m  (datasheet 1.310 m)' % r_check)
if abs(r_check - 1.310) > 0.005:
    print('  WARNING: turning radius is off the datasheet by %.0f mm'
          % (abs(r_check - 1.310) * 1000))

# ------------------------------------------------------------------------- report
tris = tri_count()
print('--- AGV stacker v2 ---')
print('objects  : %d meshes' % len([o for o in bpy.context.scene.objects
                                    if o.type == 'MESH']))
print('triangles: %d  (budget %d)' % (tris, TRI_BUDGET))
print('materials: %d' % len(bpy.data.materials))
if tris > TRI_BUDGET:
    print('WARNING: over triangle budget')

# ------------------------------------------- wheel arms vs fork (fail loudly)
# At lift 0 the blades must clear the arms, and the arms must stay inside the
# pallet windows and under the 100 mm deck opening of a Europallet.
_arm_top = max((o.matrix_world @ Vector(c)).z for o in bpy.context.scene.objects
               if o.type == 'MESH' and o.name.startswith('Chassis_WheelArm_')
               for c in o.bound_box)
_blade_bot = min((o.matrix_world @ Vector(c)).z for o in bpy.context.scene.objects
                 if o.type == 'MESH' and o.name in ('Fork_L', 'Fork_R')
                 for c in o.bound_box)
_arm_x = [abs((o.matrix_world @ Vector(c)).x) for o in bpy.context.scene.objects
          if o.type == 'MESH' and o.name.startswith('Chassis_WheelArm_')
          for c in o.bound_box]
print()
print('--- wheel arms ---')
print('  arm top %.3f m, blade bottom at lift 0 %.3f m, fork top %.3f m'
      % (_arm_top, _blade_bot, Z_BLADE_TOP))
print('  arm |x| %.3f .. %.3f m' % (min(_arm_x), max(_arm_x)))
if _blade_bot <= _arm_top:
    raise RuntimeError('fork blades rest IN the wheel arms (%.1f mm overlap)'
                       % ((_arm_top - _blade_bot) * 1000))
if min(_arm_x) < 0.055 or max(_arm_x) > 0.300:
    raise RuntimeError('wheel arms leave the Europallet fork windows (|x| 0.055..0.300)')
if Z_BLADE_TOP >= 0.100:
    raise RuntimeError('fork top %.3f m does not fit under the 100 mm deck opening'
                       % Z_BLADE_TOP)
for _n in ('Wheel_LoadL', 'Wheel_LoadR'):
    if bpy.data.objects[_n].parent.name != 'Chassis':
        raise RuntimeError('%s must hang on Chassis, not %s'
                           % (_n, bpy.data.objects[_n].parent.name))

# ------------------------------------------------------------------- RECENTRE
# Move everything under the root by -Y_ROOT, so the root is the middle of the
# vehicle including a carried pallet. Only the root's DIRECT children move; the
# rest follows through the hierarchy. Drive axes are unaffected (pure shift).
_shift = Matrix.Translation((0.0, -Y_ROOT, 0.0))
for _c in list(root.children):
    _c.matrix_world = _shift @ _c.matrix_world
bpy.context.view_layer.update()
_fa = bpy.data.objects['ForkAnchor'].matrix_world.translation
print()
print('--- root ---')
print('  root = vehicle middle, heel frame y %+.4f m (body %.3f m incl. pallet)'
      % (Y_ROOT, PALLET_Y0 + PALLET_LEN - Y_REAR))
print('  ForkAnchor (Blender, root frame): x %+.4f  y %+.4f  z %+.4f'
      % (_fa.x, _fa.y, _fa.z))
for _o in bpy.context.scene.objects:
    _s = _o.matrix_world.to_scale()
    if max(abs(_s.x - _s.y), abs(_s.y - _s.z)) > 1e-6 and (_o.type == 'EMPTY'):
        raise RuntimeError('non-uniform scale on empty %s: %r' % (_o.name, tuple(_s)))

# ------------------------------------------------------------------------- export
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_apply=True,
                          export_yup=True, export_cameras=False, export_lights=False,
                          use_selection=False, export_extras=True, export_vertex_color='ACTIVE',
                          export_all_vertex_colors=False)
print('wrote %s  (vertex AO: %s)' % (OUT_GLB, 'yes' if HAVE_AO else 'NO'))
