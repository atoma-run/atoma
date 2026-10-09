import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const renderer = new Renderer();
// Model prose is content: raw HTML stays visible text and images never fetch.
renderer.html = ({ text }) => escapeHtml(text);
renderer.image = ({ text }) => escapeHtml(text);
renderer.checkbox = ({ checked }) => checked ? '☑ ' : '☐ ';

/** Render saved assistant prose without changing the recorded message. */
export function AssistantMarkdown({ text }: { text: string }) {
  const markup = useMemo(() => {
    const parsed = marked.parse(text, { renderer, async: false, gfm: true, breaks: true });
    const fragment = DOMPurify.sanitize(parsed, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
      ALLOWED_ATTR: ['href', 'title', 'start'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    });
    for (const link of fragment.querySelectorAll('a')) {
      if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    const content = document.createElement('div');
    content.append(fragment);
    return { __html: content.innerHTML };
  }, [text]);
  return <div className="gpu-assistant-markdown" dangerouslySetInnerHTML={markup} />;
}
