import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';

Prism.manual = true;
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const markdownRenderer = new Renderer();
// Documents cannot inject HTML, fetch embedded images, or create interactive controls.
markdownRenderer.html = ({ text }) => escapeHtml(text);
markdownRenderer.image = ({ text }) => escapeHtml(text);
const languages: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  json: 'json', jsonc: 'javascript', css: 'css', html: 'markup', htm: 'markup', xml: 'markup',
  py: 'python', sh: 'bash', bash: 'bash',
};

/** A bounded, read-only view of the current MCP text page. Original bytes stay available as source. */
export function fileViewer(options: {
  t: (key: string) => string;
  openLink: (url: string) => Promise<void>;
  error: (error: unknown) => void;
}) {
  const el = (id: string) => document.getElementById(id)!;
  const toolbar = el('file-viewer-toolbar');
  const rendered = el('file-rendered');
  const source = el('text');
  const previewButton = el('file-viewer-preview') as HTMLButtonElement;
  const sourceButton = el('file-viewer-source') as HTMLButtonElement;
  let mode: 'preview' | 'source' = 'preview';
  let active = false;
  let partial = false;
  let malformedJson = false;

  function labels() {
    previewButton.textContent = options.t('fileViewerPreview');
    sourceButton.textContent = options.t('fileViewerSource');
    previewButton.setAttribute('aria-pressed', String(mode === 'preview'));
    sourceButton.setAttribute('aria-pressed', String(mode === 'source'));
    toolbar.hidden = !active;
    rendered.hidden = !active || mode !== 'preview';
    if (active) source.hidden = mode !== 'source';
    el('file-viewer-note').textContent = active && partial ? options.t('fileViewerPartial')
      : active && malformedJson ? options.t('fileViewerInvalidJson') : '';
  }
  previewButton.onclick = () => { mode = 'preview'; labels(); };
  sourceButton.onclick = () => { mode = 'source'; labels(); };
  rendered.addEventListener('click', event => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    const url = link.getAttribute('href');
    if (url && /^https?:\/\//i.test(url)) void options.openLink(url).catch(options.error);
  });

  function show(path: string, text: string, incomplete: boolean) {
    active = true; partial = incomplete; malformedJson = false;
    source.textContent = text;
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    rendered.replaceChildren();
    if (['md', 'markdown'].includes(extension)) {
      const html = marked.parse(text, { async: false, renderer: markdownRenderer });
      const fragment = DOMPurify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
          'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
        ALLOWED_ATTR: ['href', 'title'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
      });
      for (const link of fragment.querySelectorAll('a')) {
        // Relative resources cannot escape through the host or masquerade as a project file link.
        if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
        link.setAttribute('rel', 'noreferrer noopener');
      }
      rendered.append(fragment);
    } else {
      let display = text;
      if (extension === 'json' && !partial) {
        try { display = JSON.stringify(JSON.parse(text), null, 2); }
        catch { malformedJson = true; }
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const language = languages[extension];
      const grammar = language ? Prism.languages[language] : undefined;
      if (language && grammar) {
        code.append(DOMPurify.sanitize(Prism.highlight(display, grammar, language), {
          RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false,
        }));
      } else code.textContent = display;
      pre.append(code); rendered.append(pre);
    }
    labels();
  }
  return {
    show, labels,
    reset() { active = false; partial = false; mode = 'preview'; rendered.replaceChildren(); labels(); },
  };
}
