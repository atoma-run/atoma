/**
 * The arrival gate's legal links, in order: the operator's pages that
 * `src/viz/legalPages.ts` serves. Renderer-free, so the DOM bridge and GpuApp
 * read it without pulling Pixi out of the lazy renderer chunk.
 */
export const WELCOME_LEGAL_LINKS = [
  { id: 'welcome.legal.privacy', href: '/privacy' },
  { id: 'welcome.legal.terms', href: '/terms' },
  { id: 'welcome.legal.support', href: '/support' },
] as const;
