/**
 * Where `JSON.parse` stopped, in terms a model can act on: the characters
 * around the position the parser names, with raw control characters made
 * visible, and whether the character there is itself a raw control
 * character. Shared by the tool-argument hint (`codexToolLoop`) and the plan
 * reply parser (`atoms/json.ts`); it describes, it never repairs.
 */
export function jsonParseExcerpt(text: string, message: string, radius = 40): { near: string; controlAt: boolean } {
  // Anchored: V8's "Unexpected token" form carries no position but echoes
  // input, which may itself contain the words "position 12".
  const position = / in JSON at position (\d+)/.exec(message);
  const at = position ? Number(position[1]) : -1;
  if (at < 0) return { near: '', controlAt: false };
  // A raw control character shows as <U+000A>, never as `\n`: that spelling
  // is the correct escape the hint asks for, and would read as present.
  const visible = (part: string): string => [...part]
    .map((char) => (char.charCodeAt(0) < 0x20 ? `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>` : char)).join('');
  return {
    near: JSON.stringify(visible(text.slice(Math.max(0, at - radius), at + radius))),
    controlAt: at < text.length && text.charCodeAt(at) < 0x20,
  };
}
