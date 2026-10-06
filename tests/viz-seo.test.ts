import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/contracts/locales.js';
import {
  SEO_DESCRIPTION,
  SEO_TITLE,
  injectAppShellSeo,
  robotsTxt,
  sitemapXml,
} from '../src/viz/seo.js';

const html = '<!doctype html><html lang="en"><head><title>Old title</title><!-- ATOMA_DEPLOYMENT_SEO --></head><body></body></html>';

describe('public arrival SEO', () => {
  it('binds canonical, social and structured metadata to the operator-owned origin', () => {
    const rendered = injectAppShellSeo(html, new URL('https://atoma.example.com'));
    expect(rendered).toContain(`<title>${SEO_TITLE}</title>`);
    expect(rendered).toContain(`name="description" content="${SEO_DESCRIPTION}"`);
    expect(rendered).toContain('name="robots" content="index, follow, max-image-preview:large"');
    expect(rendered).toContain('rel="canonical" href="https://atoma.example.com/"');
    expect(rendered).toContain('property="og:url" content="https://atoma.example.com/"');
    expect(rendered).toContain('name="twitter:card" content="summary_large_image"');
    expect(rendered).toContain('content="https://atoma.example.com/og-card.png"');

    const json = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(rendered)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toMatchObject({
      '@context': 'https://schema.org',
      name: 'Atoma',
      url: 'https://atoma.example.com/',
      image: 'https://atoma.example.com/og-card.png',
    });
    expect(rendered).not.toContain('ATOMA_DEPLOYMENT_SEO');
  });

  it('fails closed for a build served without a canonical deployment origin', () => {
    const rendered = injectAppShellSeo(html, null);
    expect(rendered).toContain('name="robots" content="noindex, nofollow"');
    expect(rendered).not.toContain('rel="canonical"');
    expect(rendered).not.toContain('application/ld+json');
  });

  it('also enriches the server-side fallback shell, which has no build marker', () => {
    const fallback = '<html><head><title>Fallback</title></head><body></body></html>';
    const once = injectAppShellSeo(fallback, new URL('https://atoma.example.com'));
    const twice = injectAppShellSeo(once, new URL('https://atoma.example.com'));
    expect(twice.match(/rel="canonical"/g)).toHaveLength(1);
    expect(twice.match(/ATOMA_SEO_START/g)).toHaveLength(1);
    expect(twice).toContain(`<title>${SEO_TITLE}</title>`);
  });

  it('publishes reciprocal alternatives for every supported app language', () => {
    const origin = new URL('https://atoma.example.com');
    const sitemap = sitemapXml(origin);
    for (const locale of SUPPORTED_LOCALES) {
      const href = locale === 'en' ? `${origin.href}` : `${origin.href}?lang=${locale}`;
      const rendered = injectAppShellSeo(html, origin, { locale });
      expect(rendered).toContain(`<html lang="${locale}">`);
      expect(rendered).toContain(`rel="canonical" href="${href}"`);
      expect(rendered).toContain(`property="og:url" content="${href}"`);
      const sitemapEntry = sitemap.split('  <url>').find((entry) => entry.includes(`<loc>${href}</loc>`));
      expect(sitemapEntry).toBeDefined();
      for (const alternate of SUPPORTED_LOCALES) {
        const target = alternate === 'en' ? origin.href : `${origin.href}?lang=${alternate}`;
        expect(rendered).toContain(`rel="alternate" hreflang="${alternate}" href="${target}"`);
        expect(sitemapEntry).toContain(`rel="alternate" hreflang="${alternate}" href="${target}"`);
      }
      expect(rendered).toContain(`hreflang="x-default" href="${origin.href}"`);
      expect(sitemapEntry).toContain(`hreflang="x-default" href="${origin.href}"`);
    }
    expect(sitemap.match(/<loc>/g)).toHaveLength(SUPPORTED_LOCALES.length);
  });

  it('keeps the English-only showcase outside the app language group', () => {
    const origin = new URL('https://atoma.example.com');
    const sitemap = sitemapXml(origin, { showcaseHome: true, paths: ['/showcase/story'] });
    const rendered = injectAppShellSeo(html, origin, { locale: 'fr', showcaseHome: true });
    expect(rendered).toContain('rel="canonical" href="https://atoma.example.com/?lang=fr"');
    expect(rendered).toContain('hreflang="en" href="https://atoma.example.com/?lang=en"');
    expect(rendered).toContain('hreflang="x-default" href="https://atoma.example.com/?lang=en"');
    expect(sitemap).toContain('<loc>https://atoma.example.com/</loc>');
    expect(sitemap).toContain('<loc>https://atoma.example.com/?lang=en</loc>');
    expect(sitemap).toContain('<loc>https://atoma.example.com/showcase/story</loc>');
    expect(sitemap.match(/<loc>/g)).toHaveLength(SUPPORTED_LOCALES.length + 2);
    const showcaseEntry = sitemap.match(/<url>\s*<loc>https:\/\/atoma\.example\.com\/<\/loc>([\s\S]*?)<\/url>/)?.[1];
    expect(showcaseEntry).not.toContain('xhtml:link');
  });

  it('publishes only the public root and keeps control-plane routes out of discovery', () => {
    const origin = new URL('https://atoma.example.com');
    expect(robotsTxt(origin)).toBe([
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /auth/',
      'Disallow: /webhooks/',
      'Sitemap: https://atoma.example.com/sitemap.xml',
      '',
    ].join('\n'));
    expect(sitemapXml(origin)).toContain('<loc>https://atoma.example.com/</loc>');
    expect(robotsTxt(null)).toBe('User-agent: *\nDisallow: /\n');
  });

  it('shows a static brand until the app mounts and keeps the no-script fallback', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/viz/client-gl/index.html', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('<div id="root"><main class="atoma-boot">');
    expect(source).toContain('<h1>Atoma</h1></main></div>');
    const fallback = /<noscript>([\s\S]*?)<\/noscript>/.exec(source)?.[1];
    expect(fallback).toContain('#root { display: none !important; }');
    expect(fallback).toContain('<h1>Atoma</h1>');
    expect(fallback).toContain('frontier model once per task, not once per step');
    expect(fallback).toContain('<a href="/auth/login">Sign in to Atoma</a>');
  });
});
