# Museum Display Plate Geometry

This is a fictional geometric study for a museum display plate, not manufacturing certification. It is a standalone, dimensioned SVG exercise with a machine-readable report and an independent Python 3 verifier.

## Files and geometry

- `plate.svg` is 120 mm by 80 mm (`viewBox=\"0 0 120 80\"`) and contains exactly six geometric primitives: one unrounded outer rectangle (`outline`), four circles (`hole-nw`, `hole-ne`, `hole-sw`, `hole-se`), and one rounded rectangle capsule (`slot`).
- `geometry.json` records the dimensions and calculations in millimetres.
- `verify_geometry.py` parses the actual SVG and JSON using only Python standard-library XML, JSON, and math facilities.

The outer rectangle is the material boundary. The four circles and the capsule slot are cutouts; their outlines are represented with `fill=\"none\"`, `stroke=\"#000000\"`, and `stroke-width=\"0.2\"`. The corner-hole centres are (20,20), (100,20), (20,60), and (100,60) mm, each with radius 3 mm. The capsule is at x=42, y=36 with overall width 36 mm, height 8 mm, and radius 4 mm. Its 28 mm straight length is the overall width minus the two 4 mm radii; it is not the 36 mm overall width.

## Derivations

The outer material rectangle has area 100·60 = 6000 mm². The four-hole cutout area is 4·π·3² = 36π mm², and its four-hole perimeter is 4·(2π·3) = 24π mm. The capsule area is the central rectangle plus its two semicircles (one full radius-4 circle): 28·8 + π·4² = 224 + 16π mm². Therefore:

    material area = 6000 - 36π - (224 + 16π) = 5776 - 52π mm²
                    ≈ 5612.6371820133 mm²

The outer boundary perimeter is 2(100+60) = 320 mm. The four-hole perimeter is 4·(2π·3) = 24π mm. The capsule perimeter is two 28 mm straight segments plus a full radius-4 circle, 2·28 + 2π·4 = 56 + 8π mm. Thus the total perimeter, including the outer boundary and every cutout, is:

    total perimeter = 320 + 24π + 56 + 8π = 376 + 32π mm
                   ≈ 476.5309649149 mm

The outer rectangle is symmetric about x=60 and y=40. The four holes occur in reflected pairs and the centred capsule preserves both axes, so the remaining-material centroid is (60,40) mm. Each hole centre is 10 mm from its nearest outer edge and has radius 3 mm, giving a minimum cutout-to-boundary clearance of 10-3 = 7 mm; the capsule is farther from every boundary.

## `geometry.json` shape

The top level contains `units`, `shape`, `calculations`, and `symmetry_reasoning`. `shape` contains an `outer_boundary` rectangle and a `cutouts` array: four circle objects with `center` and `radius`, plus a capsule object with `x`, `y`, `overall_width`, `height`, `radius`, and `straight_length`. `calculations` contains symbolic expressions, numeric values, and derivations or reasoning for `material_area`, `total_perimeter`, `remaining_material_centroid`, and `minimum_cutout_to_boundary_clearance`.

## Verification

Run exactly:

    python3 verify_geometry.py

The verifier independently checks the SVG dimensions, units, six-element geometry, positions, styles, accessibility metadata, prohibited content, JSON shape, and numerical claims within 1e-6. It also accepts optional SVG and JSON paths.

The recorded probes include a passing invocation of `python3 verify_geometry.py` and an intentional rejection of `python3 verify_geometry.py plate-radius4.svg`, where changing `hole-nw` radius to 4 is rejected. The temporary altered copy is not part of the delivered files.
