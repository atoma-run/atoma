/**
 * Public discovery metadata for the unauthenticated arrival page.
 *
 * The deployment origin is deliberately injected by the server at request
 * time. Builds are portable artefacts, while ATOMA_VIZ_PUBLIC_ORIGIN is the
 * operator-owned canonical identity already used by authentication.
 */
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '../contracts/locales.js';

export const SEO_TITLE = 'Atoma — Inspectable AI Agent Orchestration';
export const SEO_DESCRIPTION =
  'Atoma orchestrates specialized AI agents across planning, execution, and verification for cost-aware, inspectable software delivery.';
export const SEO_SOCIAL_IMAGE_PATH = '/og-card.png';

const SEO_SLOT = '<!-- ATOMA_DEPLOYMENT_SEO -->';
const SEO_BLOCK = /\s*<!-- ATOMA_SEO_START -->[\s\S]*?<!-- ATOMA_SEO_END -->/;

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function replaceTitle(html: string, title: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttribute(title)}</title>`);
}

/** Social-card and structured-data lines shared by the app arrival and showcase home pages. */
export function homeSocialMeta(
  publicOrigin: URL,
  copy: { readonly title: string; readonly description: string } = { title: SEO_TITLE, description: SEO_DESCRIPTION },
  options: { readonly canonical?: string; readonly locale?: Locale } = {}
): string[] {
  const canonical = options.canonical ?? new URL('/', publicOrigin).href;
  const socialImage = new URL(SEO_SOCIAL_IMAGE_PATH, publicOrigin).href;
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': ['SoftwareApplication', 'WebApplication'],
    name: 'Atoma',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    description: copy.description,
    url: canonical,
    image: socialImage,
    sameAs: ['https://github.com/atoma-run/atoma'],
  }).replaceAll('<', '\\u003c');
  return [
    '  <meta property="og:type" content="website" />',
    '  <meta property="og:site_name" content="Atoma" />',
    ...(options.locale && options.locale !== DEFAULT_LOCALE ? [] : ['  <meta property="og:locale" content="en_US" />']),
    `  <meta property="og:title" content="${escapeAttribute(copy.title)}" />`,
    `  <meta property="og:description" content="${escapeAttribute(copy.description)}" />`,
    `  <meta property="og:url" content="${escapeAttribute(canonical)}" />`,
    `  <meta property="og:image" content="${escapeAttribute(socialImage)}" />`,
    '  <meta property="og:image:type" content="image/png" />',
    '  <meta property="og:image:width" content="1200" />',
    '  <meta property="og:image:height" content="630" />',
    '  <meta property="og:image:alt" content="Atoma — frontier reasoning once per task" />',
    '  <meta name="twitter:card" content="summary_large_image" />',
    `  <meta name="twitter:title" content="${escapeAttribute(copy.title)}" />`,
    `  <meta name="twitter:description" content="${escapeAttribute(copy.description)}" />`,
    `  <meta name="twitter:image" content="${escapeAttribute(socialImage)}" />`,
    '  <meta name="twitter:image:alt" content="Atoma — frontier reasoning once per task" />',
    `  <script type="application/ld+json">${structuredData}</script>`,
  ];
}

/** The showcase owns `/` when published; its English page is not a translation of the app. */
function appLocaleUrl(publicOrigin: URL, locale: Locale, showcaseHome: boolean): string {
  const url = new URL('/', publicOrigin);
  if (showcaseHome || locale !== DEFAULT_LOCALE) url.searchParams.set('lang', locale);
  return url.href;
}

function appAlternates(publicOrigin: URL, showcaseHome: boolean): { readonly locale: string; readonly href: string }[] {
  return [
    ...SUPPORTED_LOCALES.map((locale) => ({ locale, href: appLocaleUrl(publicOrigin, locale, showcaseHome) })),
    { locale: 'x-default', href: appLocaleUrl(publicOrigin, DEFAULT_LOCALE, showcaseHome) },
  ];
}

function seoBlock(publicOrigin: URL | null, locale: Locale, showcaseHome: boolean): string {
  if (!publicOrigin) {
    return [
      '<!-- ATOMA_SEO_START -->',
      '  <meta name="robots" content="noindex, nofollow" />',
      '<!-- ATOMA_SEO_END -->',
    ].join('\n');
  }

  const canonical = appLocaleUrl(publicOrigin, locale, showcaseHome);
  return [
    '<!-- ATOMA_SEO_START -->',
    `  <meta name="description" content="${escapeAttribute(SEO_DESCRIPTION)}" />`,
    '  <meta name="author" content="Atoma" />',
    '  <meta name="robots" content="index, follow, max-image-preview:large" />',
    `  <link rel="canonical" href="${escapeAttribute(canonical)}" />`,
    ...appAlternates(publicOrigin, showcaseHome).map(({ locale: language, href }) =>
      `  <link rel="alternate" hreflang="${language}" href="${escapeAttribute(href)}" />`
    ),
    ...homeSocialMeta(publicOrigin, { title: SEO_TITLE, description: SEO_DESCRIPTION }, { canonical, locale }),
    '<!-- ATOMA_SEO_END -->',
  ].join('\n');
}

/** Inject one idempotent metadata block into either source or built HTML. */
export function injectAppShellSeo(
  html: string,
  publicOrigin: URL | null,
  options: { readonly locale?: Locale; readonly showcaseHome?: boolean } = {}
): string {
  const withoutPreviousBlock = html.replace(SEO_BLOCK, '');
  const locale = options.locale ?? DEFAULT_LOCALE;
  const block = seoBlock(publicOrigin, locale, options.showcaseHome ?? false);
  const withMetadata = withoutPreviousBlock.includes(SEO_SLOT)
    ? withoutPreviousBlock.replace(SEO_SLOT, block)
    : withoutPreviousBlock.replace(/<\/head>/i, `${block}\n</head>`);
  return publicOrigin
    ? replaceTitle(withMetadata.replace(/<html lang="[^"]*"/i, `<html lang="${locale}"`), SEO_TITLE)
    : withMetadata;
}

export function robotsTxt(publicOrigin: URL | null): string {
  if (!publicOrigin) return 'User-agent: *\nDisallow: /\n';
  const sitemap = new URL('/sitemap.xml', publicOrigin).href;
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /webhooks/',
    `Sitemap: ${sitemap}`,
    '',
  ].join('\n');
}

export function sitemapXml(publicOrigin: URL, options: { readonly paths?: readonly string[]; readonly showcaseHome?: boolean } = {}): string {
  // Extra paths are the showcase's story pages, passed only while it is
  // published: a sitemap naming a 404 would teach crawlers to distrust the rest.
  const showcaseHome = options.showcaseHome ?? false;
  const alternates = appAlternates(publicOrigin, showcaseHome);
  const appLocations = SUPPORTED_LOCALES.map((locale) => appLocaleUrl(publicOrigin, locale, showcaseHome));
  const locations = [
    ...(showcaseHome ? [{ href: new URL('/', publicOrigin).href, app: false }] : []),
    ...appLocations.map((href) => ({ href, app: true })),
    ...(options.paths ?? []).map((path) => ({ href: new URL(path, publicOrigin).href, app: false })),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...locations.flatMap(({ href, app }) => [
      '  <url>',
      `    <loc>${escapeAttribute(href)}</loc>`,
      ...(app ? alternates.map(({ locale, href: alternate }) =>
        `    <xhtml:link rel="alternate" hreflang="${locale}" href="${escapeAttribute(alternate)}" />`
      ) : []),
      '  </url>',
    ]),
    '</urlset>',
    '',
  ].join('\n');
}
