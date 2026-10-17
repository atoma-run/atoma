import { Filter, type WebGLRenderer } from 'pixi.js';

export { VIZ_WIREFRAME, VIZ_WIREFRAME_MODE, type VizWireframeMode } from '../wireframe-mode.js';

const WIRE_UNIFORM = 'uAtomaWire';

/**
 * Wraps the program's `main` so a line draw can recolour its output:
 * 1 keeps the shaded colour but forces it opaque (a transparent texel — the
 * padding around a glyph — becomes a pale blue edge instead of nothing);
 * 2 paints a fixed cyan, readable over the filled frame in overlay mode.
 */
function patchFragment(source: string): string {
  const output =
    /\bout\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+(\w+)\s*;/.exec(source)?.[1] ??
    (source.includes('gl_FragColor') ? 'gl_FragColor' : null);
  const main = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/;
  if (!output || !main.test(source)) return source;
  return `${source.replace(main, 'void atomaWireMain()')}
uniform float ${WIRE_UNIFORM};
void main() {
  atomaWireMain();
  if (${WIRE_UNIFORM} > 1.5) {
    ${output} = vec4(0.25, 0.9, 1.0, 1.0) * 0.85;
  } else if (${WIRE_UNIFORM} > 0.5) {
    vec4 atomaWireColor = ${output};
    vec3 atomaWireRgb = atomaWireColor.a > 0.001 ? atomaWireColor.rgb / atomaWireColor.a : vec3(0.0);
    float atomaWireA = clamp(atomaWireColor.a, 0.0, 1.0);
    ${output} = vec4(mix(vec3(0.45, 0.72, 1.0), clamp(atomaWireRgb, 0.0, 1.0), atomaWireA), 1.0);
  }
}
`;
}

interface PixiGlInternals {
  geometry: { _activeGeometry: { indexBuffer?: { data: ArrayLike<number> } } | null };
  buffer: { getGlBuffer(buffer: unknown): { buffer: WebGLBuffer } };
  colorMask: { _colorMaskCache: number };
  encoder: { draw(options: { shader: unknown }): void };
}

/**
 * Install on a freshly initialised WebGL renderer, before its first frame:
 * programs are compiled lazily, so every program the scene uses gets the
 * recolouring wrapper. Filter passes and stencil (mask) writes are left as
 * triangles — a filter quad drawn as edges would erase the frame it shades,
 * and a mask drawn as edges would clip its content to hairlines.
 */
export function installGlWireframe(renderer: WebGLRenderer, mode: 'lines' | 'overlay'): void {
  const gl = renderer.gl;
  const pixi = renderer as unknown as PixiGlInternals;

  const shaderSource = gl.shaderSource.bind(gl);
  gl.shaderSource = (shader: WebGLShader, source: string) => {
    const fragment = gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER;
    shaderSource(shader, fragment ? patchFragment(source) : source);
  };

  let filterDepth = 0;
  const encoderDraw = pixi.encoder.draw.bind(pixi.encoder);
  pixi.encoder.draw = (options) => {
    if (!(options.shader instanceof Filter)) return encoderDraw(options);
    filterDepth += 1;
    try {
      encoderDraw(options);
    } finally {
      filterDepth -= 1;
    }
  };

  const locations = new WeakMap<WebGLProgram, WebGLUniformLocation | null>();
  const setWire = (value: number) => {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    if (!program) return;
    let location = locations.get(program);
    if (location === undefined) {
      location = gl.getUniformLocation(program, WIRE_UNIFORM);
      locations.set(program, location);
    }
    if (location) gl.uniform1f(location, value);
  };

  const scratch = gl.createBuffer();
  let lines = new Uint32Array(1 << 16);
  /** Triangle (list or strip) → three edges each, as a LINES index list. */
  const edges = (mode: number, count: number, index: (i: number) => number): number => {
    const triangles = mode === gl.TRIANGLES ? Math.floor(count / 3) : Math.max(0, count - 2);
    const needed = triangles * 6;
    if (lines.length < needed) lines = new Uint32Array(needed * 2);
    for (let t = 0; t < triangles; t += 1) {
      const base = mode === gl.TRIANGLES ? t * 3 : t;
      const a = index(base);
      const b = index(base + 1);
      const c = index(base + 2);
      const o = t * 6;
      lines[o] = a; lines[o + 1] = b;
      lines[o + 2] = b; lines[o + 3] = c;
      lines[o + 4] = c; lines[o + 5] = a;
    }
    return needed;
  };
  const convertible = (mode: number) =>
    (mode === gl.TRIANGLES || mode === gl.TRIANGLE_STRIP) &&
    filterDepth === 0 &&
    pixi.colorMask._colorMaskCache !== 0;

  const drawElements = gl.drawElements.bind(gl);
  const drawElementsInstanced = gl.drawElementsInstanced.bind(gl);
  const drawArrays = gl.drawArrays.bind(gl);
  const drawArraysInstanced = gl.drawArraysInstanced.bind(gl);

  /**
   * Draw the edges through a scratch element buffer, then put back the
   * element binding the bound VAO had: binding ELEMENT_ARRAY_BUFFER while a
   * VAO is bound rewrites that VAO.
   */
  const drawEdges = (
    count: number,
    restore: WebGLBuffer | null,
    instances: number | null,
    original: () => void
  ) => {
    if (mode === 'overlay') original();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scratch);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines.subarray(0, count), gl.STREAM_DRAW);
    setWire(mode === 'overlay' ? 2 : 1);
    if (instances === null) drawElements(gl.LINES, count, gl.UNSIGNED_INT, 0);
    else drawElementsInstanced(gl.LINES, count, gl.UNSIGNED_INT, 0, instances);
    setWire(0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, restore);
  };

  const indexed = (
    mode: number,
    count: number,
    type: number,
    offset: number,
    instances: number | null
  ): boolean => {
    if (!convertible(mode)) return false;
    const indexBuffer = pixi.geometry._activeGeometry?.indexBuffer;
    if (!indexBuffer) return false;
    const data = indexBuffer.data;
    const start = offset / (type === gl.UNSIGNED_SHORT ? 2 : type === gl.UNSIGNED_BYTE ? 1 : 4);
    const n = edges(mode, count, (i) => data[start + i]!);
    drawEdges(n, pixi.buffer.getGlBuffer(indexBuffer).buffer, instances, () =>
      instances === null
        ? drawElements(mode, count, type, offset)
        : drawElementsInstanced(mode, count, type, offset, instances));
    return true;
  };
  const sequential = (mode: number, first: number, count: number, instances: number | null): boolean => {
    if (!convertible(mode)) return false;
    const n = edges(mode, count, (i) => first + i);
    drawEdges(n, null, instances, () =>
      instances === null
        ? drawArrays(mode, first, count)
        : drawArraysInstanced(mode, first, count, instances));
    return true;
  };

  gl.drawElements = (mode, count, type, offset) => {
    if (!indexed(mode, count, type, offset, null)) drawElements(mode, count, type, offset);
  };
  gl.drawElementsInstanced = (mode, count, type, offset, instances) => {
    if (!indexed(mode, count, type, offset, instances)) {
      drawElementsInstanced(mode, count, type, offset, instances);
    }
  };
  gl.drawArrays = (mode, first, count) => {
    if (!sequential(mode, first, count, null)) drawArrays(mode, first, count);
  };
  gl.drawArraysInstanced = (mode, first, count, instances) => {
    if (!sequential(mode, first, count, instances)) drawArraysInstanced(mode, first, count, instances);
  };
}
