"""Independent campaign oracle; never reads the author's audit as proof."""
import json
import re
import sys
from pathlib import Path

record = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
output = record['metadata']['result']['output']
assert isinstance(output, str)
blocks = output.strip().split('\n\n')
stanzas = [block.splitlines() for block in blocks[:4]]
assert [len(s) for s in stanzas] == [4, 4, 4, 4], 'Expected four four-line stanzas before the audit'
lines = [line for stanza in stanzas for line in stanza]
counts = [len(line.split()) for line in lines]
initials = ''.join(line[0] for line in lines)
endings = [stanza[-1].split()[-1].rstrip('.,;:!?') for stanza in stanzas]
observed = {'counts': counts, 'initials': initials, 'endings': endings}
print(json.dumps(observed))
assert counts == [6] * 16, 'Line word count mismatch'
assert initials == 'LIGHTHOUSEKEEPER', 'Acrostic mismatch'
assert endings == ['thaw', 'sun', 'leaves', 'snow'], 'Stanza ending mismatch'
assert not any(re.search(r"[-0-9'’]", line) for line in lines), 'Prohibited token form'
assert len(blocks) > 4, 'Missing separate audit'
assert output.count(lines[0]) == 1, 'Poem repeated in its audit'
