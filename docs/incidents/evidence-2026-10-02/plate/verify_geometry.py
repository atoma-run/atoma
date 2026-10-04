#!/usr/bin/env python3
"""Independently verify the museum display plate SVG and its geometry report."""
import json
import math
import sys
import xml.etree.ElementTree as ET

TOL = 1e-6
NS = "http://www.w3.org/2000/svg"
EXPECTED = {
    "outline": ("rect", {"x": 10.0, "y": 10.0, "width": 100.0, "height": 60.0}),
    "hole-nw": ("circle", {"cx": 20.0, "cy": 20.0, "r": 3.0}),
    "hole-ne": ("circle", {"cx": 100.0, "cy": 20.0, "r": 3.0}),
    "hole-sw": ("circle", {"cx": 20.0, "cy": 60.0, "r": 3.0}),
    "hole-se": ("circle", {"cx": 100.0, "cy": 60.0, "r": 3.0}),
    "slot": ("rect", {"x": 42.0, "y": 36.0, "width": 36.0, "height": 8.0, "rx": 4.0, "ry": 4.0}),
}
STYLE = {"fill": "none", "stroke": "#000000", "stroke-width": "0.2"}

def fail(message):
    raise ValueError(message)

def number(value, label):
    try:
        return float(value)
    except (TypeError, ValueError):
        fail("non-numeric " + label)

def close(actual, expected, label):
    if not math.isfinite(actual) or abs(actual - expected) > TOL:
        fail("{}: {} != {}".format(label, actual, expected))

def local_name(tag):
    return tag.rsplit("}", 1)[-1]

def verify(svg_path, json_path):
    root = ET.parse(svg_path).getroot()
    if local_name(root.tag) != "svg" or root.tag != "{" + NS + "}svg":
        fail("root is not an SVG element")
    if root.attrib.get("width") != "120mm" or root.attrib.get("height") != "80mm":
        fail("incorrect physical dimensions")
    if root.attrib.get("viewBox") != "0 0 120 80":
        fail("incorrect viewBox")
    if any(k == "transform" for element in root.iter() for k in element.attrib):
        fail("transform is prohibited")
    prohibited = {"path", "image", "script", "foreignObject", "text", "line", "polyline", "polygon", "ellipse", "use", "symbol", "marker", "metadata"}
    for element in root.iter():
        if local_name(element.tag) in prohibited:
            fail("prohibited element: " + local_name(element.tag))
        if any(k.lower() in {"display", "visibility", "opacity"} for k in element.attrib):
            fail("hidden or visibility styling is prohibited")
    titles = [e for e in root if local_name(e.tag) == "title"]
    descs = [e for e in root if local_name(e.tag) == "desc"]
    if len(titles) != 1 or not "".join(titles[0].itertext()).strip():
        fail("accessible title missing")
    if len(descs) != 1 or not "".join(descs[0].itertext()).strip():
        fail("accessible description missing")
    geometric = [e for e in root if local_name(e.tag) in {"rect", "circle"}]
    if len(geometric) != 6:
        fail("expected exactly six geometric elements")
    if {e.attrib.get("id") for e in geometric} != set(EXPECTED):
        fail("unexpected geometric ids")
    for element in geometric:
        ident = element.attrib["id"]
        kind, dimensions = EXPECTED[ident]
        if local_name(element.tag) != kind:
            fail(ident + " has wrong element type")
        for attr, expected in dimensions.items():
            close(number(element.attrib.get(attr), ident + "." + attr), expected, ident + "." + attr)
        if {k: element.attrib.get(k) for k in STYLE} != STYLE:
            fail(ident + " has incorrect style")
        allowed = {"id"} | set(dimensions) | set(STYLE)
        if set(element.attrib) != allowed:
            fail(ident + " has unexpected attributes")
    with open(json_path, encoding="utf-8") as stream:
        report = json.load(stream)
    shape = report.get("shape", {})
    outer = shape.get("outer_boundary", {})
    if outer.get("id") != "outline" or outer.get("type") != "rect":
        fail("JSON outer shape mismatch")
    for key, expected in {"x": 10, "y": 10, "width": 100, "height": 60}.items():
        close(number(outer.get(key), "JSON outer." + key), expected, "JSON outer." + key)
    cutouts = {item.get("id"): item for item in shape.get("cutouts", [])}
    if set(cutouts) != {"hole-nw", "hole-ne", "hole-sw", "hole-se", "slot"}:
        fail("JSON cutout ids mismatch")
    for ident, (kind, dimensions) in EXPECTED.items():
        if ident == "outline":
            continue
        item = cutouts[ident]
        if ident == "slot":
            if item.get("type") != "capsule":
                fail("JSON slot type mismatch")
            for key, expected in {"x": 42, "y": 36, "overall_width": 36, "height": 8, "radius": 4, "straight_length": 28}.items():
                close(number(item.get(key), "JSON slot." + key), expected, "JSON slot." + key)
        else:
            if item.get("type") != "circle" or item.get("center") != [dimensions[k] for k in ("cx", "cy")]:
                fail("JSON " + ident + " mismatch")
            close(number(item.get("radius"), "JSON " + ident + ".radius"), 3, "JSON " + ident + ".radius")
    pi = math.pi
    area = 100 * 60 - 4 * pi * 3**2 - (28 * 8 + pi * 4**2)
    perimeter = 2 * (100 + 60) + 4 * (2 * pi * 3) + 2 * 28 + 2 * pi * 4
    calculations = report.get("calculations", {})
    close(number(calculations["material_area"]["value_mm2"], "area"), area, "area")
    close(number(calculations["total_perimeter"]["value_mm"], "perimeter"), perimeter, "perimeter")
    centroid = calculations["remaining_material_centroid"]["value_mm"]
    if len(centroid) != 2:
        fail("centroid must have two coordinates")
    close(number(centroid[0], "centroid x"), 60, "centroid x")
    close(number(centroid[1], "centroid y"), 40, "centroid y")
    close(number(calculations["minimum_cutout_to_boundary_clearance"]["value_mm"], "clearance"), 7, "clearance")
    if calculations["material_area"].get("symbolic") != "5776-52*pi":
        fail("area symbolic expression mismatch")
    if calculations["total_perimeter"].get("symbolic") != "376+32*pi":
        fail("perimeter symbolic expression mismatch")
    print("geometry verification passed")

if __name__ == "__main__":
    svg = sys.argv[1] if len(sys.argv) > 1 else "plate.svg"
    report = sys.argv[2] if len(sys.argv) > 2 else "geometry.json"
    try:
        verify(svg, report)
    except (OSError, ET.ParseError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print("geometry verification failed: {}".format(error))
        sys.exit(1)
