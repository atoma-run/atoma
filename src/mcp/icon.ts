/**
 * The mark every MCP client may show beside this server (`serverInfo.icons`,
 * protocol 2025-11-25). A data URI rather than a URL: an ungated host has no
 * public origin to point at, and a client never has to fetch anything to draw
 * it. The bytes are `src/viz/public/favicon.svg`; `tests/mcp-server-json.test.ts`
 * fails when they drift.
 */
export const ATOMA_MARK_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\" width=\"512\" height=\"512\" role=\"img\" aria-label=\"Atoma\">\n  <!-- one crystal, three ranks: molecule / cell / tissue meet at the atom.\n       The octahedron silhouette follows the GPU brand mark; the facets are\n       flat and strokeless so the mark still reads at 16 px, where the old\n       hairline outline collapsed into a grey blur. -->\n  <g>\n    <path d=\"M256 52 452 256 60 256Z\" fill=\"#f59e0b\"/>\n    <path d=\"M60 256 256 256 256 460Z\" fill=\"#0f766e\"/>\n    <path d=\"M452 256 256 460 256 256Z\" fill=\"#7c3aed\"/>\n    <path d=\"M256 200 316 256 256 312 196 256Z\" fill=\"#f8fbff\"/>\n  </g>\n</svg>\n";

export const ATOMA_ICONS = [
  { src: `data:image/svg+xml;base64,${Buffer.from(ATOMA_MARK_SVG, 'utf8').toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] },
];
