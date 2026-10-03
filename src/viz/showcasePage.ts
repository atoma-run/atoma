import { createHash } from 'node:crypto';
import { homeSocialMeta } from './seo.js';
import {
  SHOWCASE_KINDS,
  type ShowcaseEntry,
  type ShowcaseEpisode,
  type ShowcaseKind,
} from './showcase.js';

/**
 * THE PUBLIC SHOWCASE PAGES, rendered on the server.
 * ===================================================
 *
 * Server-rendered on purpose: the page works without JavaScript, is readable
 * by a crawler, and has no client code that could turn tenant- or
 * model-authored text into markup. EVERY dynamic value goes through `esc`;
 * nothing else writes into the HTML. The one script is a filter bar and is
 * pinned by hash in the page's own Content-Security-Policy, which otherwise
 * allows no network at all.
 *
 * Plain words only: no agents, tiers or other internal vocabulary. The page
 * is for people deciding whether Atoma is worth trying, not for operators.
 */

const FILTER_SCRIPT = `(function(){var bar=document.getElementById('filters');if(!bar)return;bar.hidden=false;var cards=[].slice.call(document.querySelectorAll('[data-kind]'));bar.addEventListener('click',function(e){var b=e.target.closest('button[data-filter]');if(!b)return;var f=b.getAttribute('data-filter');[].forEach.call(bar.querySelectorAll('button'),function(x){x.setAttribute('aria-pressed',String(x===b));});cards.forEach(function(c){c.hidden=f!=='all'&&c.getAttribute('data-kind')!==f;});});})();`;

const scriptHash = `'sha256-${createHash('sha256').update(FILTER_SCRIPT).digest('base64')}'`;

/** No network, no frames, no forms: the filter script above and this site's own crystal module. */
export const SHOWCASE_SECURITY_HEADERS = {
  'content-security-policy':
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' ${scriptHash}; img-src 'self' data: blob:; ` +
    `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/** Built files a page may load; `null` when this build has none (tests, a source checkout). */
export interface ShowcaseAssets {
  /** `/showcase-assets/atoma-mark.js?v=<hash>`: the real Pixi crystal. */
  readonly markScript: string | null;
}

const NO_ASSETS: ShowcaseAssets = { markScript: null };

export function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const KIND_LABEL: Record<ShowcaseKind, string> = {
  answers: 'Answers',
  reports: 'Reports & data',
  media: 'Drawings & sound',
  software: 'Software',
};
const KIND_NOUN: Record<ShowcaseKind, string> = {
  answers: 'Written answer',
  reports: 'Report & data',
  media: 'Drawing & sound',
  software: 'Software',
};
const KIND_COLOR: Record<ShowcaseKind, string> = {
  answers: '#fbbf24',
  reports: '#c084fc',
  media: '#22d3ee',
  software: '#6ea8ff',
};
const KIND_GLYPH: Record<ShowcaseKind, string> = {
  answers: '<path d="M5 6h14M5 11h14M5 16h9"/>',
  reports: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  media: '<path d="M3 12h2M7 7v10M11 4v16M15 8v8M19 10v4M21 12h0"/>',
  software: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h0M10 7h0"/>',
};

function glyph(kind: ShowcaseKind, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_GLYPH[kind]}</svg>`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—';
  return costUsd > 0 && costUsd < 0.005 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function day(iso: string | null): string {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

const CSS = `
:root{color-scheme:dark;--bg:#070b13;--panel:#0f1b2e;--raised:#142238;--line:#223754;--text:#e6edf7;--muted:#a8b4cc;--primary:#6ea8ff;--ok:#4ade80;--warn:#f87171}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
a{color:#9cc4ff}a:hover{color:#d1f5ff}
h1,h2,h3,p{margin:0}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.display{font-weight:800;letter-spacing:-.035em;color:#f8fbff}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;max-width:1240px;margin:0 auto;position:relative;z-index:2}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:#f8fbff;font-weight:800;font-size:22px;letter-spacing:-.04em}
.pill{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#9cc4ff;border:1px solid #2b4668;border-radius:999px;padding:5px 10px}
nav.top{display:flex;align-items:center;gap:8px}
nav.top a{color:#c9d4e6;text-decoration:none;font-size:15px;padding:12px 14px;min-height:44px;display:inline-flex;align-items:center}
.btn{display:inline-flex;align-items:center;min-height:48px;padding:0 22px;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none}
.btn.primary,nav.top a.primary{background:var(--primary);color:#07111f}
.btn.ghost{border:1px solid #426386;color:var(--text)}
.hero{position:relative;overflow:hidden;margin-top:-76px;padding:140px 0 72px;background-color:#050913;background-image:radial-gradient(520px 380px at 30% 18%,rgba(14,66,148,.75),transparent 70%),radial-gradient(500px 420px at 88% 34%,rgba(97,31,184,.55),transparent 70%),linear-gradient(rgba(71,133,230,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(71,133,230,.07) 1px,transparent 1px);background-size:100% 100%,100% 100%,56px 56px,56px 56px;animation:aurora 24s ease-in-out infinite alternate}
.hero .in{position:relative;z-index:1;isolation:isolate;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr));gap:40px;align-items:center}
.hero h1{font-size:clamp(42px,6vw,80px);line-height:.98;text-wrap:balance}
.hero p.lead{font-size:19px;color:#b9c5da;max-width:560px;margin-top:22px;text-wrap:pretty}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.stage{position:relative;height:420px;display:flex;align-items:center;justify-content:center;background:radial-gradient(closest-side,rgba(53,184,240,.30),transparent)}
.mark{position:relative;display:inline-block;flex:none}
.mark>.mark-canvas{position:absolute;inset:0;width:100%!important;height:100%!important}
.mark.mark-live>:not(.mark-canvas){visibility:hidden}
.marks-pending .mark:not(.mark-live):not(.mark-failed)>*{visibility:hidden;animation:mark-reveal 0s 4s forwards}
@keyframes mark-reveal{to{visibility:visible}}
.mark-receiver-live>.mark-canvas{position:absolute;left:0;top:0;z-index:0;pointer-events:none}
.mark-receiver-live .stage{background:none}
main.story{position:relative}main.story>.wrap{position:relative;z-index:1}
.mark-logo{width:40px;height:40px}.mark-logo svg{width:100%;height:100%}
.mark-hero{width:300px;height:380px}
.mark-story{width:150px;height:180px}
.mark-band{width:150px;height:180px}
.story .titlerow{display:flex;align-items:center;justify-content:space-between;gap:24px}
.cta-band .row{display:flex;align-items:center;gap:28px}
@media (max-width:640px){.mark-story,.mark-band{display:none}}
.crystal{animation:turn 15s ease-in-out infinite;transform-style:preserve-3d}
.bob{animation:bob 1.8s ease-in-out infinite alternate;perspective:900px}
section.feed{padding:64px 0 88px;background:#0b1424}
.feedhead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:28px}
.feedhead h2{font-size:38px;letter-spacing:-.03em;color:#f8fbff}
.feedhead p{color:var(--muted);max-width:640px;margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips button{cursor:pointer;font:inherit;font-size:14px;font-weight:600;min-height:44px;padding:0 16px;border-radius:999px;background:transparent;color:#c9d4e6;border:1px solid #426386}
.chips button[aria-pressed=true]{background:#e6edf7;color:#07111f;border-color:#e6edf7}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:22px}
.card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:var(--panel);color:var(--text);text-decoration:none}
.card:hover{border-color:#426386}
.card .vis{position:relative;height:150px;display:flex;align-items:center;justify-content:center;gap:16px;padding:18px;background:linear-gradient(135deg,#102640,#0d1a2e)}
.card .vis .g{width:64px;height:64px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:rgba(5,9,19,.45)}
.badge{position:absolute;left:14px;top:14px;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(5,9,19,.7);font-size:12px;font-weight:700}
.badge i{width:7px;height:7px;border-radius:2px;display:inline-block}
.files{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.files span{padding:4px 8px;border-radius:7px;background:rgba(5,9,19,.55);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d4e6}
.card .body{padding:20px 22px 22px;display:flex;flex-direction:column;gap:14px;flex-grow:1}
.card h3{font-size:21px;line-height:1.25;letter-spacing:-.01em;color:#f8fbff;text-wrap:pretty}
.meta{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#8a99b4}
.foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;margin-top:auto;padding-top:14px;border-top:1px solid #1f3350;font-size:14px;color:#c9d4e6}
.foot b{color:#9cc4ff}
.empty{border:1px dashed #426386;border-radius:18px;padding:40px;text-align:center;color:var(--muted)}
.cta-band{padding:80px 0;background:#050913}
.cta-band .box{max-width:720px;margin:0 auto;padding:32px;border-radius:20px;border:1px solid #2b4668;background:rgba(15,27,46,.8);display:flex;flex-direction:column;gap:16px}
.cta-band h2{font-size:32px;letter-spacing:-.03em;color:#f8fbff}
.cta-band p{color:#b9c5da}
footer.bottom{padding:24px;background:#050913;border-top:1px solid #142238;color:#8a99b4;font-size:14px;text-align:center}
main.story{padding:24px 0 80px;background:#0b1424;min-height:70vh}
.crumb{display:inline-flex;align-items:center;min-height:44px;color:#c9d4e6;text-decoration:none;font-size:15px}
.story h1{font-size:clamp(30px,4vw,48px);line-height:1.05;margin-top:8px;text-wrap:balance}
.facts{display:flex;flex-wrap:wrap;gap:8px 22px;color:var(--muted);font-size:14px;margin-top:14px}
.episode{margin-top:36px;border:1px solid #2b4668;border-radius:20px;background:var(--panel);overflow:hidden}
.episode>h2{padding:18px 24px;border-bottom:1px solid #1f3350;font-size:15px;color:#9cc4ff;letter-spacing:.04em;text-transform:uppercase}
.acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))}
.act{padding:24px;display:flex;flex-direction:column;gap:14px;border-right:1px solid #1f3350}
.act:last-child{border-right:0}
.act h3{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.act .req{font-size:22px;line-height:1.25;color:#f8fbff;font-weight:600;text-wrap:pretty}
details{color:#b9c5da;font-size:14px}summary{cursor:pointer;min-height:32px;color:#9cc4ff}
details p{margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}
ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;position:relative}
ol.steps li{display:flex;gap:14px;align-items:flex-start}
ol.steps .dot{flex:0 0 18px;height:18px;border-radius:50%;margin-top:3px;background:var(--ok)}
ol.steps li.back .dot{background:var(--warn)}
ol.steps b{display:block;color:#f8fbff;font-weight:650}
ol.steps span{font-size:14px;color:#b9c5da}
.answer{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b1424;border:1px solid var(--line);border-radius:12px;padding:16px;max-height:420px;overflow:auto;color:#dbe6f6}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:10px}
.stats div{background:var(--raised);border-radius:12px;padding:12px}
.stats small{display:block;font-size:12px;color:#8a99b4}.stats strong{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flist{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.flist li{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-radius:8px;background:var(--raised);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.flist em{font-style:normal;color:#8a99b4;white-space:nowrap}
@keyframes aurora{from{background-position:0 0,0 0,0 0,0 0}to{background-position:6% 4%,-5% -3%,0 0,0 0}}
@keyframes turn{0%,100%{transform:rotateY(-26deg) rotateX(6deg)}50%{transform:rotateY(26deg) rotateX(-4deg)}}
@keyframes bob{from{transform:translateY(-6px)}to{transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.hero,.crystal,.bob{animation:none}}
@media (max-width:640px){.act{border-right:0;border-bottom:1px solid #1f3350}}
`;

const LOGO =
  '<svg width="30" height="30" viewBox="0 0 512 512" aria-hidden="true"><path d="M256 52 452 256 60 256Z" fill="#f59e0b"/><path d="M60 256 256 256 256 460Z" fill="#0f766e"/><path d="M452 256 256 460 256 256Z" fill="#7c3aed"/><path d="M256 200 316 256 256 312 196 256Z" fill="#f8fbff"/></svg>';

const CRYSTAL =
  '<svg width="260" height="330" viewBox="0 0 400 480" role="img" aria-label="The Atoma crystal"><path d="M200 20 20 240 140 262Z" fill="#efc14a" fill-opacity=".92"/><path d="M200 20 140 262 268 258Z" fill="#f59e0b" fill-opacity=".9"/><path d="M200 20 268 258 380 240Z" fill="#8b5cf6" fill-opacity=".9"/><path d="M200 460 20 240 140 262Z" fill="#0f9f92" fill-opacity=".92"/><path d="M200 460 140 262 268 258Z" fill="#2563eb" fill-opacity=".9"/><path d="M200 460 268 258 380 240Z" fill="#db2777" fill-opacity=".88"/><path d="M200 20 20 240 200 460 380 240Z" fill="none" stroke="#f8fbff" stroke-opacity=".25" stroke-width="2"/><circle cx="200" cy="240" r="30" fill="#dff1ff"/></svg>';

function socialFallback(title: string, description: string, canonical: string | null): string {
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Atoma">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    ...(canonical ? [`<meta property="og:url" content="${esc(canonical)}">`] : []),
  ].join('\n');
}

function page(input: {
  readonly title: string;
  readonly description: string;
  readonly origin: URL | null;
  readonly pathname: string;
  readonly body: string;
  readonly script?: boolean;
  /** The page served at `/`: it carries the product's social card and structured data. */
  readonly home?: boolean;
  readonly assets: ShowcaseAssets;
}): string {
  const canonical = input.origin ? new URL(input.pathname, input.origin).href : null;
  const robots = canonical
    ? '<meta name="robots" content="index, follow, max-image-preview:large">'
    : '<meta name="robots" content="noindex, nofollow">';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<meta name="description" content="${esc(input.description)}">
${robots}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${input.home && input.origin ? homeSocialMeta(input.origin, { title: input.title, description: input.description }).join('\n') : socialFallback(input.title, input.description, canonical)}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
${input.assets.markScript ? '<noscript><style>.marks-pending .mark>*{visibility:visible!important}</style></noscript>' : ''}
</head>
<body${input.assets.markScript ? ' class="marks-pending"' : ''}>
${input.body}
${input.script ? `<script>${FILTER_SCRIPT}</script>` : ''}
${input.assets.markScript ? `<script type="module" src="${esc(input.assets.markScript)}"></script>` : ''}
</body>
</html>
`;
}

function header(): string {
  return `<header class="top"><a class="brand" href="/"><span class="mark mark-logo" data-atoma-mark="logo">${LOGO}</span><span>Atoma</span><span class="pill">Live showcase</span></a>
<nav class="top" aria-label="Site"><a href="/#feed">Finished work</a><a href="/app">Sign in</a><a class="primary" href="/app">Start your own</a></nav></header>`;
}

function closing(): string {
  return `<section class="cta-band"><div class="wrap"><div class="box"><div class="row">
<div class="mark mark-band" data-atoma-mark="band">${CRYSTAL}</div><div style="display:flex;flex-direction:column;gap:16px">
<h2 class="display">Have a request of your own?</h2>
<p>Describe the outcome you want. Atoma works on it in a private project and gives you the same story: every step, every check, and the finished result.</p>
<a class="btn primary" style="align-self:flex-start" href="/app">Start your own</a></div></div></div></div></section>
<footer class="bottom">atoma.run · Every story on this page is real work, shown as it was delivered.</footer>`;
}

function card(entry: ShowcaseEntry): string {
  const first = entry.episodes[0]!;
  const color = KIND_COLOR[entry.kind];
  const more = entry.episodes.slice(1);
  const files = entry.episodes[entry.episodes.length - 1]!.files.slice(0, 4);
  const deliveries = entry.episodes.length;
  return `<a class="card" href="/showcase/${esc(entry.id)}" data-kind="${esc(entry.kind)}">
<div class="vis"><span class="badge" style="color:${color}"><i style="background:${color}"></i>${esc(KIND_NOUN[entry.kind])}</span>
<div class="g" style="color:${color}">${glyph(entry.kind, 34)}</div>
${files.length ? `<div class="files">${files.map((file) => `<span>${esc(file.path)}</span>`).join('')}</div>` : ''}</div>
<div class="body">
<div class="meta"><time datetime="${esc(day(entry.endedAt))}">${esc(day(entry.endedAt))}</time><span>${deliveries > 1 ? `${deliveries} deliveries` : 'Delivered'}</span></div>
<h3>${esc(first.title)}</h3>
${more.length ? `<p class="meta" style="display:block">Then: ${more.map((episode) => esc(episode.title)).join(' · ')}</p>` : ''}
<div class="foot"><span>${esc(formatDuration(entry.totalDurationS))} · ${esc(formatCost(entry.totalCostUsd))}</span><b>${deliveries > 1 ? 'Follow every step →' : 'Watch the story →'}</b></div>
</div></a>`;
}

export function renderShowcaseIndex(
  entries: readonly ShowcaseEntry[],
  origin: URL | null,
  assets: ShowcaseAssets = NO_ASSETS
): string {
  const counts = new Map<ShowcaseKind, number>(SHOWCASE_KINDS.map((kind) => [kind, 0]));
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const chips = [
    `<button type="button" data-filter="all" aria-pressed="true">Everything <small>${entries.length}</small></button>`,
    ...SHOWCASE_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0).map(
      (kind) =>
        `<button type="button" data-filter="${kind}" aria-pressed="false">${esc(KIND_LABEL[kind])} <small>${counts.get(kind)}</small></button>`
    ),
  ].join('');
  const body = `${header()}
<section class="hero" data-atoma-receiver>
<div class="wrap in"><div>
<h1 class="display">Watch a request turn into finished work.</h1>
<p class="lead">A drawing, a sound, a report, a data study, a proof, a piece of software. Atoma takes on requests and works on them in the open. Only work that was delivered and passed its checks is shown here.</p>
<div class="cta"><a class="btn primary" href="#feed">See finished work</a><a class="btn ghost" href="/app">Start your own</a></div></div>
<div class="stage"><div class="mark mark-hero" data-atoma-mark="hero"><div class="bob"><div class="crystal">${CRYSTAL}</div></div></div></div></div></section>
<section class="feed" id="feed"><div class="wrap">
<div class="feedhead"><div><h2>Finished and checked</h2><p>Every piece of work here was delivered. Some grew over several requests: each step is shown, and each one kept what already worked.</p></div>
<div class="chips" id="filters" role="group" aria-label="Filter by kind of work" hidden>${chips}</div></div>
${entries.length ? `<div class="cards">${entries.map(card).join('')}</div>` : '<div class="empty">Nothing to show yet. Finished work appears here as it is delivered.</div>'}
</div></section>
${closing()}`;
  return page({
    // Plain words, like the page: the product's technical SEO line names
    // agents, and this home is written for people who have never heard of them.
    title: 'Atoma — Watch a request turn into finished work',
    description:
      'Watch requests turn into finished, checked work: drawings, sounds, reports, data studies, proofs and software.',
    origin,
    pathname: '/',
    body,
    script: true,
    home: true,
    assets,
  });
}

function episodeSection(episode: ShowcaseEpisode, index: number, count: number, answer: string | null, kind: ShowcaseKind): string {
  const steps = [
    ['Read the request', 'Turned it into a list of things it would have to prove before calling the work done.', false],
    ['Did the work', 'Planned the pieces, built them and checked the result as it went.', false],
    ...(episode.sentBack > 0
      ? [
          [
            `Sent back by the final review${episode.sentBack > 1 ? ` (${episode.sentBack} times)` : ''}`,
            'The last check did not accept the first result, and said what was missing.',
            true,
          ],
          ['Corrected', 'The missing parts were fixed and the work was checked again.', false],
        ]
      : []),
    ['Delivered', episode.textDelivery ? 'The answer is written below.' : `${episode.files.length} file${episode.files.length === 1 ? '' : 's'} handed over.`, false],
  ] as const;
  const result = answer
    ? `<div class="answer">${esc(answer)}</div>`
    : episode.files.length
      ? `<ul class="flist">${episode.files.map((file) => `<li><span>${esc(file.path)}</span><em>${esc(formatSize(file.size))}</em></li>`).join('')}</ul>`
      : '<p style="color:var(--muted)">Delivered.</p>';
  return `<article class="episode" id="step-${index + 1}">
${count > 1 ? `<h2>Step ${index + 1} of ${count}</h2>` : ''}
<div class="acts">
<div class="act"><h3 style="color:#fbbf24">The request</h3><p class="req">${esc(episode.title)}</p>
<details><summary>Read the full request</summary><p>${esc(episode.request)}</p></details></div>
<div class="act"><h3 style="color:#22d3ee">The journey</h3><ol class="steps">${steps
    .map(([title, text, back]) => `<li${back ? ' class="back"' : ''}><span class="dot"></span><div><b>${esc(title)}</b><span>${esc(text)}</span></div></li>`)
    .join('')}</ol></div>
<div class="act"><h3 style="color:${KIND_COLOR[kind]}">The result</h3>${result}
<div class="stats"><div><small>Time</small><strong>${esc(formatDuration(episode.durationS))}</strong></div><div><small>Cost</small><strong>${esc(formatCost(episode.costUsd))}</strong></div><div><small>Finished</small><strong>${esc(day(episode.endedAt) || '—')}</strong></div></div></div>
</div></article>`;
}

export function renderShowcaseEntry(
  entry: ShowcaseEntry,
  answers: ReadonlyMap<string, string | null>,
  origin: URL | null,
  assets: ShowcaseAssets = NO_ASSETS
): string {
  const first = entry.episodes[0]!;
  const body = `${header()}
<main class="story" data-atoma-receiver><div class="wrap">
<a class="crumb" href="/">← All finished work</a>
<div class="titlerow"><h1 class="display">${esc(first.title)}</h1><div class="mark mark-story" data-atoma-mark="story">${CRYSTAL}</div></div>
<div class="facts"><span style="color:${KIND_COLOR[entry.kind]}">${esc(KIND_NOUN[entry.kind])}</span><span>${entry.episodes.length > 1 ? `${entry.episodes.length} deliveries` : '1 delivery'}</span><span>${esc(formatDuration(entry.totalDurationS))} in total</span><span>${esc(formatCost(entry.totalCostUsd))} in total</span></div>
${entry.episodes.map((episode, index) => episodeSection(episode, index, entry.episodes.length, answers.get(episode.id) ?? null, entry.kind)).join('\n')}
</div></main>
${closing()}`;
  return page({
    title: `${first.title} — Atoma`,
    description: `How Atoma worked on: ${first.title}`,
    origin,
    pathname: `/showcase/${entry.id}`,
    body,
    assets,
  });
}

export function renderShowcaseNotFound(assets: ShowcaseAssets = NO_ASSETS): string {
  return page({
    title: 'Not found — Atoma',
    description: 'This story is not available.',
    origin: null,
    pathname: '/',
    body: `${header()}<main class="story"><div class="wrap"><a class="crumb" href="/">← All finished work</a><h1 class="display">This story is not available.</h1></div></main>${closing()}`,
    assets,
  });
}
