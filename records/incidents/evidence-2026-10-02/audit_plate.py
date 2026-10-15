"""Independent geometry and verifier audit, operating on isolated owned copies."""
import json
import math
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(sys.argv[1]).resolve()
svg = (root / 'plate.svg').read_bytes()
claims = (root / 'geometry.json').read_bytes()
tree = ET.fromstring(svg)
local = lambda node: node.tag.rsplit('}', 1)[-1]
assert local(tree) == 'svg'
assert tree.attrib['width'] == '120mm' and tree.attrib['height'] == '80mm'
assert [float(x) for x in tree.attrib['viewBox'].split()] == [0, 0, 120, 80]
assert all(local(n) in {'svg', 'title', 'desc', 'rect', 'circle'} for n in tree.iter())
assert all('transform' not in n.attrib for n in tree.iter())
assert any(local(n) == 'title' and ''.join(n.itertext()).strip() for n in tree)
assert any(local(n) == 'desc' and ''.join(n.itertext()).strip() for n in tree)
expected = {
    'outline': ('rect', {'x': 10, 'y': 10, 'width': 100, 'height': 60}),
    'hole-nw': ('circle', {'cx': 20, 'cy': 20, 'r': 3}),
    'hole-ne': ('circle', {'cx': 100, 'cy': 20, 'r': 3}),
    'hole-sw': ('circle', {'cx': 20, 'cy': 60, 'r': 3}),
    'hole-se': ('circle', {'cx': 100, 'cy': 60, 'r': 3}),
    'slot': ('rect', {'x': 42, 'y': 36, 'width': 36, 'height': 8, 'rx': 4, 'ry': 4}),
}
shapes = [n for n in tree.iter() if local(n) in {'rect', 'circle'}]
assert len(shapes) == 6
assert {n.attrib['id'] for n in shapes} == set(expected)
for node in shapes:
    tag, attrs = expected[node.attrib['id']]
    assert local(node) == tag
    for key, value in attrs.items():
        assert float(node.attrib[key]) == value
    assert node.attrib['fill'] == 'none' and node.attrib['stroke'] == '#000000'
    assert float(node.attrib['stroke-width']) == 0.2
    if node.attrib['id'] == 'outline':
        assert float(node.attrib.get('rx', 0)) == float(node.attrib.get('ry', 0)) == 0
oracle = {'material_area_mm2': 5776 - 52 * math.pi,
          'cut_perimeter_mm': 376 + 32 * math.pi,
          'centroid_mm': [60, 40], 'minimum_clearance_mm': 7}
parsed_claims = json.loads(claims)
assert parsed_claims['units'] == 'mm'
calc = parsed_claims['calculations']
assert calc['material_area']['symbolic'] == '5776-52*pi'
assert calc['total_perimeter']['symbolic'] == '376+32*pi'
assert abs(calc['material_area']['value_mm2'] - oracle['material_area_mm2']) < 1e-6
assert abs(calc['total_perimeter']['value_mm'] - oracle['cut_perimeter_mm']) < 1e-6
assert calc['remaining_material_centroid']['value_mm'] == [60, 40]
assert calc['minimum_cutout_to_boundary_clearance']['value_mm'] == 7
results = []
def check(label, svg_bytes, json_bytes, should_pass):
    with tempfile.TemporaryDirectory(prefix='case-', dir=root) as folder:
        p = Path(folder)
        for name, data in [('plate.svg', svg_bytes), ('geometry.json', json_bytes),
                           ('verify_geometry.py', (root / 'verify_geometry.py').read_bytes())]:
            (p / name).write_bytes(data)
        r = subprocess.run([sys.executable, str(p / 'verify_geometry.py')], cwd=p,
                           capture_output=True, text=True, timeout=15)
        results.append({'case': label, 'expected_pass': should_pass, 'exit_code': r.returncode,
                        'matched': (r.returncode == 0) == should_pass,
                        'output': (r.stdout + r.stderr)[:1500]})

check('valid', svg, claims, True)
for label, shape_id, attribute, value in [
    ('hole_radius_4', 'hole-nw', 'r', '4'),
    ('slot_wrong_radius', 'slot', 'rx', '3'),
    ('hidden_transform', 'hole-nw', 'transform', 'translate(1 0)'),
    ('wrong_style', 'outline', 'stroke-width', '1')]:
    changed = ET.fromstring(svg)
    next(n for n in changed.iter() if n.attrib.get('id') == shape_id).set(attribute, value)
    check(label, ET.tostring(changed), claims, False)
changed = ET.fromstring(svg)
changed.set('width', '120px')
check('wrong_units', ET.tostring(changed), claims, False)
changed = ET.fromstring(svg)
ET.SubElement(changed, '{http://www.w3.org/2000/svg}path', {'d': 'M0 0 L1 1'})
check('extra_path', ET.tostring(changed), claims, False)
changed = ET.fromstring(svg)
group = ET.SubElement(changed, '{http://www.w3.org/2000/svg}g')
ET.SubElement(group, '{http://www.w3.org/2000/svg}circle',
              {'id': 'extra-hole', 'cx': '60', 'cy': '20', 'r': '2',
               'fill': 'none', 'stroke': '#000000', 'stroke-width': '0.2'})
check('nested_extra_geometry', ET.tostring(changed), claims, False)
changed_claims = json.loads(claims)
changed_claims['calculations']['material_area']['value_mm2'] += 1
check('incorrect_numeric_area', svg, json.dumps(changed_claims).encode(), False)
changed_claims['calculations']['material_area']['value_mm2'] = float('nan')
check('nonfinite_numeric_area', svg, json.dumps(changed_claims).encode(), False)
changed_claims = json.loads(claims)
changed_claims['units'] = 'cm'
check('incorrect_json_units', svg, json.dumps(changed_claims).encode(), False)
check('malformed_json', svg, b'{', False)
report = {'svg_primitives_valid': True, 'independent_expected': oracle,
          'delivered_claims': json.loads(claims), 'verifier_cases': results}
(root / 'independent-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
