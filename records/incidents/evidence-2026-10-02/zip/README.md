# Museum capsule

This repository contains a reproducible ZIP capsule and its JSON manifest. The capsule has exactly three stored files in a fixed order:

1. `README.txt` — `Museum capsule v1\n`
2. `data/café.txt` — `Café — été\n`
3. `data/empty.bin` — empty

`manifest.json` has this shape:

```json
{"entries":[{"name":"string","size":0,"sha256":"lowercase hexadecimal SHA-256"}]}
```

The rows are in ZIP entry order. `size` is the UTF-8 byte count and `sha256` is the digest of the exact entry bytes.

## Regenerate

```sh
python3 build_capsule.py
```

This writes `capsule.zip` and `manifest.json` deterministically.

## Verify

```sh
python3 verify_capsule.py
```

The verifier independently checks the fixed entry names and bytes, ZIP metadata and order, stored payloads, CRCs, and every manifest row.
