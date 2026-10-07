// @vitest-environment jsdom
import { expect, it } from 'vitest';
import * as library from '@open-file-viewer/core';
import { filePreviewPlugins } from '../src/viz/client-gl/file-preview-plugins.js';

const plugins = filePreviewPlugins(library, { modern: '/worker.mjs', legacy: '/legacy.mjs' });
const formats: Record<string, string> = {
  image: 'jpg jpeg jfif pjpe pjpeg png gif webp avif jxl svg bmp ico cur tif tiff apng heic heif',
  audio: 'mp3 wav aif aiff aifc aac m4a flac opus oga ogg weba amr mid midi caf au snd wma',
  video: 'mp4 mpg mpeg mpe mpv webm ogv mov m4v avi mkv flv wmv 3gp 3g2 m2ts m3u8',
  pdf: 'pdf',
  office: 'docx docm doc dotx dotm dot rtf odt fodt wps xlsx xls xlsm xlsb xlt xltx xltm csv tsv ods fods numbers et pptx pptm ppt pps ppsx ppsm potx potm odp fodp key dps',
  epub: 'epub', xps: 'xps oxps', ofd: 'ofd', email: 'eml msg mbox',
  drawing: 'drawio dio excalidraw tldraw', xmind: 'xmind',
  cad: 'dxf dwg dwf step stp iges igs ifc sat sab x_t x_b 3dm skp sldprt sldasm gds gdsii oas oasis',
  model3d: 'gltf glb obj stl fbx dae ply 3mf 3ds usd usda usdc usdz wrl vrml',
  gis: 'geojson topojson kml kmz gpx shp',
  asset: 'ttf otf woff woff2 eot psd psb ai eps ps webarchive sqlite sqlite3 db wasm parquet avro',
  archive: 'zip rar 7z tar gz tgz bz2 xz',
  text: 'txt md markdown log json jsonc json5 jsonl ndjson xml yaml yml js ts jsx tsx html css py rb rs go java c cpp sh sql ipynb lrc',
};

it('registers every upstream plugin, with the unsupported fallback last', () => {
  const upstream = Object.keys(library).filter(name => name.endsWith('Plugin')).map(name => name.slice(0, -6)).sort();
  expect(plugins.map(plugin => plugin.name).sort()).toEqual(upstream);
  expect(plugins.at(-1)?.name).toBe('fallback');
});

// Exercise the real matchers in production order, including extension casing.
// CSV, CAD/XML, GIS/JSON and font/image conflicts must not fall into plain text.
it.each(Object.entries(formats).flatMap(([plugin, extensions]) =>
  extensions.split(' ').map(extension => ({ plugin, extension }))))('routes .$extension to $plugin', async ({ plugin, extension }) => {
  for (const ext of [extension, extension.toUpperCase()]) {
    const file: library.PreviewFile = {
      source: new ArrayBuffer(0), name: `sample.${ext}`, extension: ext.toLowerCase(), mimeType: '', size: 0,
    };
    let selected: string | undefined;
    for (const candidate of plugins) {
      if (await candidate.match(file)) { selected = candidate.name; break; }
    }
    expect(selected).toBe(plugin);
    expect(await library.isPreviewSupported(new ArrayBuffer(0), plugins, { fileName: file.name })).toBe(true);
  }
});

it('does not advertise an unknown binary as supported merely because fallback exists', async () => {
  expect(await library.isPreviewSupported(new ArrayBuffer(0), plugins, { fileName: 'unknown.unrecognized' })).toBe(false);
});
