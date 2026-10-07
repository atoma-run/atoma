import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

/** Small real files: smoke assertions check decoded content, not fallback panels. */
export async function fileViewerFixtures() {
  const zip = async entries => {
    const archive = new JSZip();
    for (const [path, text] of Object.entries(entries)) archive.file(path, text);
    return await archive.generateAsync({ type: 'nodebuffer' });
  };
  return {
    'documents/mail.eml': {
      bytes: 'From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Preview email\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA decoded email body.',
      selector: '.ofv-email', text: 'A decoded email body.',
    },
    'documents/book.epub': {
      bytes: await zip({
        mimetype: 'application/epub+zip',
        'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        'book.opf': '<package><metadata><title>Sample book</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        'chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>A decoded chapter</h1></body></html>',
      }), selector: '.ofv-epub-reader', text: 'A decoded chapter',
    },
    'documents/page.xps': {
      bytes: await zip({ 'Documents/1/Pages/1.fpage': '<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="400" Height="300"><Glyphs OriginX="20" OriginY="40" FontRenderingEmSize="20" UnicodeString="A decoded XPS page"/></FixedPage>' }),
      selector: '.ofv-xps-page', text: 'A decoded XPS page',
    },
    'documents/page.ofd': {
      bytes: await zip({ 'Doc_0/Pages/Page_0/Content.xml': '<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area><ofd:Content><ofd:Layer><ofd:TextObject Boundary="10 10 100 20" Size="5"><ofd:TextCode X="0" Y="5">A decoded OFD page</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>' }),
      selector: '.ofv-ofd-page', text: 'A decoded OFD page',
    },
    'engineering/diagram.drawio': {
      bytes: '<mxfile><diagram name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A decoded drawing" vertex="1" parent="1"><mxGeometry x="20" y="20" width="160" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
      selector: '.ofv-drawing', text: 'A decoded drawing',
    },
    'engineering/map.xmind': {
      bytes: await zip({ 'content.json': JSON.stringify([{ id: 'sheet', title: 'Sheet', rootTopic: { id: 'root', title: 'A decoded mind map', children: { attached: [{ id: 'child', title: 'Child topic' }] } } }]) }),
      selector: '.ofv-xmind', text: 'A decoded mind map',
    },
    'engineering/lines.dxf': {
      bytes: '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n100\n21\n100\n0\nENDSEC\n0\nEOF\n',
      selector: '.ofv-cad svg', text: '',
    },
    'engineering/triangle.obj': {
      bytes: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
      selector: '.ofv-model-stage canvas', text: '',
    },
    'data/archive.zip': {
      bytes: await zip({ 'decoded-entry.txt': 'A decoded archive entry' }),
      selector: '.ofv-archive', text: 'decoded-entry.txt',
    },
    'data/points.geojson': {
      bytes: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Point' }, geometry: { type: 'Point', coordinates: [2.3, 48.8] } }] }),
      selector: '.leaflet-overlay-pane path', text: '',
    },
    'data/font.ttf': {
      bytes: await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)),
      selector: '.ofv-font-preview', text: '',
    },
  };
}
