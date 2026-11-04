// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// Rule part of the part family "roller conveyor, straight" (reference example
// for plan-650, pilot module RM 8110). Rules only — no geometry. The geometry
// comes from the base parts under `_Parts` (one SolidCraft design, each part
// once). Pass the whole file as `code` and PARAMS as `paramsJson` to
// `web_editor_parametric_define`. Recipe: web_help("parametric").
//
// Frame: part-local millimetres, SolidCraft axes — X = conveying direction,
// Y = across, Z = up. The module starts at x = 0 and is centred on y = 0.
// Heights stay as authored in the base design (feet on z = 0).
//
// Base parts (direct children of `_Parts`, names exact):
//   Profile — side frame profile, straight, along +X, starting at x = 0
//   Roller  — roller for BF 420, axis along Y, length = BF (stretched to BF)
//   Guide   — side guide, straight, along +X, starting at x = 0
//   Strip   — thin transport plate on top of the rollers, along +X, width 420
//   Holder  — optional: leg / support under one profile (placed per side)
// Every part is positioned from its bounds, so the design may place it anywhere.

var PARAMS = [
  { Name: 'BF', Label: 'Nominal width BF', Type: 'enum', Unit: 'mm', Enum: [420, 620, 840], Default: 420 },
  { Name: 'ML', Label: 'Module length ML', Type: 'number', Unit: 'mm', Min: 500, Max: 4320, Step: 10, Default: 2160 },
  { Name: 'P', Label: 'Roller pitch P', Type: 'enum', Unit: 'mm', Enum: [60, 90, 120, 150], Default: 90 },
  { Name: 'HSG', Label: 'Side guide height HSG', Type: 'number', Unit: 'mm', Min: 35, Max: 80, Step: 1, Default: 68 },
];

/** Conveying speed of the generated drive in mm/s. */
var SPEED_MM_S = 300;
/** Largest distance between two supports in mm. */
var SUPPORT_SPACING_MM = 1500;

function generate(v, parts) {
  var byName = {};
  for (var i = 0; i < parts.length; i++) byName[parts[i].name] = parts[i].boundsMm;
  function need(name) {
    if (!byName[name]) throw new Error('base part "' + name + '" is missing under _Parts');
    return byName[name];
  }
  var profile = need('Profile');
  var roller = need('Roller');
  var guide = need('Guide');
  var strip = need('Strip');
  var holder = byName.Holder || null;

  var ML = v.ML, BF = v.BF, P = v.P;
  var half = BF / 2;
  var FW = profile.max[1] - profile.min[1];
  var GW = guide.max[1] - guide.min[1];
  var rollerTop = roller.max[2];
  var instances = [];

  // Stretch a straight part along X from its own length to `len` (plane in the middle).
  function stretchX(b, len) {
    var l0 = b.max[0] - b.min[0];
    return len === l0 ? [] : [{ axis: 'x', atMm: (b.min[0] + b.max[0]) / 2, byMm: len - l0 }];
  }
  function stretchY(b, width) {
    var w0 = b.max[1] - b.min[1];
    return width === w0 ? [] : [{ axis: 'y', atMm: (b.min[1] + b.max[1]) / 2, byMm: width - w0 }];
  }

  // Side profiles outside the conveying width, guides on top flush with the inner edge.
  var sides = [{ s: 'L', y0: half }, { s: 'R', y0: -half - FW }];
  for (var k = 0; k < 2; k++) {
    var side = sides[k];
    instances.push({ part: 'Profile', name: 'Profile_' + side.s,
      positionMm: [-profile.min[0], side.y0 - profile.min[1], 0], stretch: stretchX(profile, ML) });
    var gy0 = side.s === 'L' ? half : -half - GW;
    instances.push({ part: 'Guide', name: 'Guide_' + side.s,
      positionMm: [-guide.min[0], gy0 - guide.min[1], rollerTop + v.HSG - guide.max[2]], stretch: stretchX(guide, ML) });
  }

  // Rollers: floor(ML / P), centred over the module length.
  var n = Math.max(1, Math.floor(ML / P));
  var x0 = (ML - (n - 1) * P) / 2;
  var rxc = (roller.min[0] + roller.max[0]) / 2;
  var rollerStretch = stretchY(roller, BF);
  for (var r = 0; r < n; r++) {
    instances.push({ part: 'Roller', name: 'Roller_' + r,
      positionMm: [x0 + r * P - rxc, -half - roller.min[1], 0], stretch: rollerStretch });
  }

  // Transport plate on top of the rollers, carries Drive + TransportSurface.
  instances.push({ part: 'Strip', name: 'Transport-Surface',
    positionMm: [-strip.min[0], -half - strip.min[1], rollerTop - strip.min[2]],
    stretch: stretchX(strip, ML).concat(stretchY(strip, BF)) });

  // Supports: both ends and every SUPPORT_SPACING_MM, under each profile.
  if (holder) {
    var hw = holder.max[0] - holder.min[0];
    var bays = Math.max(1, Math.ceil((ML - hw) / SUPPORT_SPACING_MM));
    for (var h = 0; h <= bays; h++) {
      var hx = (ML - hw) * h / bays;
      instances.push({ part: 'Holder', name: 'Holder_L_' + h, positionMm: [hx - holder.min[0], half - holder.min[1], 0] });
      instances.push({ part: 'Holder', name: 'Holder_R_' + h, positionMm: [hx - holder.min[0], -half - FW - holder.min[1], 0] });
    }
  }

  return {
    instances: instances,
    nodes: [
      { name: 'Snap-XN-convroll', positionMm: [0, 0, rollerTop] },
      { name: 'Snap-XP-convroll', positionMm: [ML, 0, rollerTop] },
    ],
    components: [
      // TransportDirection is in Unity coordinates (X negated): (-1,0,0) = local +X.
      { node: 'Transport-Surface', type: 'Drive', fields: { Direction: 'LinearX', TargetSpeed: SPEED_MM_S, JogForward: true } },
      { node: 'Transport-Surface', type: 'TransportSurface', fields: { TransportDirection: { x: -1, y: 0, z: 0 }, Radial: false } },
    ],
    messages: [{ level: 'info', text: n + ' rollers, BF ' + BF + ', ML ' + ML + ', P ' + P }],
  };
}
