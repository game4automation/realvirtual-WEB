// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// Rule part of the simplest part family: an aluminium profile cut to length
// (plan-650, acceptance A6). One base part, one rule: L → one stretch. Shows
// that the family mechanism carries without any conveyor special case.
//
// Base part (direct child of `_Parts`):
//   Profile — 40 x 40 slot profile, 100 mm long along +X, starting at x = 0.
// The stretch plane sits in the middle (x = 50), so slots and end faces stay
// undistorted. Shortening must stop before the nearest vertex beyond the plane:
// the shortest length is 50 mm + the end region (chamfer, thread, ...) of the
// base part. Min 60 allows end regions up to 10 mm.

var PARAMS = [
  { Name: 'L', Label: 'Length L', Type: 'number', Unit: 'mm', Min: 60, Max: 6000, Step: 1, Default: 100 },
];

function generate(v, parts) {
  var profile = null;
  for (var i = 0; i < parts.length; i++) if (parts[i].name === 'Profile') profile = parts[i].boundsMm;
  if (!profile) throw new Error('base part "Profile" is missing under _Parts');
  var l0 = profile.max[0] - profile.min[0];
  var stretch = v.L === l0 ? [] : [{ axis: 'x', atMm: (profile.min[0] + profile.max[0]) / 2, byMm: v.L - l0 }];
  return {
    instances: [{ part: 'Profile', name: 'Profile', positionMm: [-profile.min[0], 0, 0], stretch: stretch }],
    messages: [{ level: 'info', text: 'L ' + v.L + ' mm' }],
  };
}
