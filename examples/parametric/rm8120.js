// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// Rule part of the part family "roller conveyor, curve" (second pilot of
// plan-650, module RM 8120). Rules only — no geometry. Shows the fourth
// operation, bend: straight profiles become arcs, conical rollers are set
// radially. Pass the whole file as `code` and PARAMS as `paramsJson` to
// `web_editor_parametric_define`. Recipe: web_help("parametric").
//
// Frame: part-local millimetres, SolidCraft axes, Z up. The CURVE CENTRE is the
// origin (a Radial TransportSurface turns about its node origin). The material
// enters at (0, r) heading +X and the curve turns clockwise seen from above
// (towards -Y) by `Angle`. Heights stay as authored (feet on z = 0).
//
// Base parts (direct children of `_Parts`, names exact):
//   Profile              — straight side frame profile along +X
//   Guide                — straight side guide along +X
//   Strip                — thin straight transport plate along +X, width 420
//   Roller420/620/840    — one conical roller per BF (not stretchable), axis
//                          along +Y, small end at the smallest y (inner side)
// Profiles, guides and the strip are stretched to the arc length, then bent.
// Make them SHORTER than the shortest arc (the inner profile at 30° is about
// 430 mm; 300 mm is a good base length): the plane-cut stretch shortens only
// up to the nearest vertex beyond the middle plane, lengthening has no limit.
//
// Catalogue values: inner radius r_i 825 mm (inner face of the inner profile),
// inner pitch P_i ≈ 72 mm, outer pitch P_a ≈ 0.087 · BF + P_i (reported).

var PARAMS = [
  { Name: 'Angle', Label: 'Curve angle', Type: 'enum', Unit: 'deg', Enum: [30, 45, 60, 90], Default: 90 },
  { Name: 'BF', Label: 'Nominal width BF', Type: 'enum', Unit: 'mm', Enum: [420, 620, 840], Default: 620 },
  { Name: 'HSG', Label: 'Side guide height HSG', Type: 'number', Unit: 'mm', Min: 35, Max: 80, Step: 1, Default: 68 },
];

/** Inner radius (inner face of the inner profile) in mm. */
var R_INNER_MM = 825;
/** Roller pitch on the inner conveying edge in mm. */
var PITCH_INNER_MM = 72;
/** Conveying speed on the centre line in mm/s. */
var SPEED_MM_S = 300;

function generate(v, parts) {
  var byName = {};
  for (var i = 0; i < parts.length; i++) byName[parts[i].name] = parts[i].boundsMm;
  function need(name) {
    if (!byName[name]) throw new Error('base part "' + name + '" is missing under _Parts');
    return byName[name];
  }
  var profile = need('Profile');
  var guide = need('Guide');
  var strip = need('Strip');
  var rollerName = 'Roller' + v.BF;
  var roller = need(rollerName);

  var BF = v.BF;
  var W = v.Angle * Math.PI / 180;
  var FW = profile.max[1] - profile.min[1];
  var GW = guide.max[1] - guide.min[1];
  var rEdge = R_INNER_MM + FW;          // inner conveying edge
  var rMid = rEdge + BF / 2;            // centre line
  var rollerTop = roller.max[2];
  var instances = [];

  // A straight part along +X, stretched to the arc length at radius R and bent
  // clockwise about the origin. Its y range [y0, y1] lands on radii [R + y0, R + y1];
  // `inner` is the wanted radius of y0. A part that does not start at x = 0 is
  // turned back by its start angle so every arc starts at angle 0.
  function arc(part, b, name, inner, z, widthY) {
    var R = inner - b.min[1];
    var l0 = b.max[0] - b.min[0];
    var stretch = [];
    if (widthY !== undefined && widthY !== b.max[1] - b.min[1]) {
      stretch.push({ axis: 'y', atMm: (b.min[1] + b.max[1]) / 2, byMm: widthY - (b.max[1] - b.min[1]) });
    }
    var len = R * W;
    if (len !== l0) stretch.push({ axis: 'x', atMm: (b.min[0] + b.max[0]) / 2, byMm: len - l0 });
    instances.push({ part: part, name: name, positionMm: [0, 0, z],
      rotationDeg: [0, 0, (b.min[0] / R) * 180 / Math.PI],
      stretch: stretch, bend: { axis: 'x', radiusMm: R, centerSide: '-', pivot: 'center' } });
  }

  arc('Profile', profile, 'Profile_In', R_INNER_MM, 0);
  arc('Profile', profile, 'Profile_Out', rEdge + BF, 0);
  var gz = rollerTop + v.HSG - guide.max[2];
  arc('Guide', guide, 'Guide_In', rEdge - GW, gz);
  arc('Guide', guide, 'Guide_Out', rEdge + BF, gz);
  arc('Strip', strip, 'Transport-Surface', rEdge, rollerTop - strip.min[2], BF);

  // Conical rollers, radial: local +Y points outwards, small end on the inner edge.
  var n = Math.max(2, Math.round(rEdge * W / PITCH_INNER_MM));
  var xc = (roller.min[0] + roller.max[0]) / 2;
  var y0 = roller.min[1];
  for (var k = 0; k < n; k++) {
    var t = (k + 0.5) * W / n;
    var s = Math.sin(t), c = Math.cos(t);
    instances.push({ part: rollerName, name: 'Roller_' + k,
      positionMm: [rEdge * s - (xc * c + y0 * s), rEdge * c - (-xc * s + y0 * c), 0],
      rotationDeg: [0, 0, -t * 180 / Math.PI] });
  }

  // Snaps: entry at angle 0, exit at `Angle`. Snap outward directions are
  // cardinal (axis letter + sign from the position) — exact at 90°, an
  // approximation for 30/45/60°.
  var exitName = v.Angle === 90 ? 'Snap-ZP-convroll' : 'Snap-XP-convroll';
  var degPerS = SPEED_MM_S / rMid * 180 / Math.PI;
  return {
    instances: instances,
    nodes: [
      { name: 'Snap-XN-convroll', positionMm: [0, rMid, rollerTop] },
      { name: exitName, positionMm: [rMid * Math.sin(W), rMid * Math.cos(W), rollerTop], rotationDeg: [0, 0, -v.Angle] },
    ],
    components: [
      // Radial surface turning about the node origin (= curve centre), axis -Z (clockwise).
      { node: 'Transport-Surface', type: 'Drive', fields: { Direction: 'RotationZ', TargetSpeed: degPerS, JogForward: true } },
      { node: 'Transport-Surface', type: 'TransportSurface', fields: { TransportDirection: { x: 0, y: 0, z: -1 }, Radial: true } },
    ],
    messages: [{ level: 'info', text: n + ' rollers, ' + v.Angle + ' deg, BF ' + BF +
      ', P_i ' + (rEdge * W / n).toFixed(1) + ' mm, P_a ' + ((rEdge + BF) * W / n).toFixed(1) + ' mm' }],
  };
}
