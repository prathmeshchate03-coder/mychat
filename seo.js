// Server-rendered public pages: topics, blog, sitemap.xml, robots.txt, and the <head> tags for static pages.
// Text lives in content.js. Set SITE_URL (for example https://jenchat.example) once you have your own domain.
const { topics, articles } = require('./content');

const BRAND = 'JenChat';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const envClean = s => String(s || '').trim().replace(/^["']+|["']+$/g, '').trim();
const SITE_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(envClean(process.env.SITE_URL).replace(/\/+$/, '')) ? envClean(process.env.SITE_URL).replace(/\/+$/, '') : '';
const GSC = envClean(process.env.GSC_VERIFICATION).replace(/[^A-Za-z0-9_-]/g, '');   // Google Search Console HTML-tag token

// Which guides to show on a topic page, and which rooms on a guide page.
const TOPIC_GUIDES = {
  english: ['practice-english-by-chatting-online', 'chat-safely-with-strangers-online'],
  lobby: ['how-to-make-a-private-chat-room', 'conversation-starters-for-chat-rooms'],
  friends: ['conversation-starters-for-chat-rooms', 'chat-safely-with-strangers-online'],
};
const DEFAULT_GUIDES = ['conversation-starters-for-chat-rooms', 'chat-safely-with-strangers-online'];
const GUIDE_TOPICS = {
  'chat-safely-with-strangers-online': ['friends', 'lobby'],
  'conversation-starters-for-chat-rooms': ['friends', 'movies', 'music'],
  'practice-english-by-chatting-online': ['english', 'food', 'movies'],
  'how-to-make-a-private-chat-room': ['lobby', 'friends'],
};
const topicBySlug = new Map(topics.map(t => [t.slug, t]));
const articleBySlug = new Map(articles.map(a => [a.slug, a]));

// Origin used for canonical links and the sitemap. SITE_URL wins; otherwise the (validated) Host header.
function siteBase(req) {
  if (SITE_URL) return SITE_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return 'http://localhost';
  return (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host;
}

const ld = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const longDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function metaTags({ base, path, title, desc, type = 'website' }) {
  return [
    `<link rel="canonical" href="${esc(base + path)}">`,
    `<meta property="og:site_name" content="${BRAND}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(base + path)}">`,
    `<meta property="og:image" content="${esc(base)}/og.png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    GSC ? `<meta name="google-site-verification" content="${GSC}">` : '',
  ].filter(Boolean).join('\n');
}

const header = () => `<header class="top"><a class="brand" href="/"><img src="/logo.svg" alt="">Jen<span>Chat</span></a>
<nav aria-label="Main"><a href="/topics">Topics</a> <a href="/blog">Blog</a> <a href="/chat">Chat</a></nav></header>`;
const footer = () => `<footer><a href="/topics">Topics</a> <a href="/blog">Blog</a> <a href="/legal#about">About</a> <a href="/legal#privacy">Privacy</a> <a href="/legal#terms">Terms</a> <a href="/legal#contact">Contact</a><br>${BRAND}. All rights reserved.</footer>`;
const crumbs = items => `<nav class="crumbs" aria-label="Breadcrumb">${items.map((c, i) => i === items.length - 1 ? `<span aria-current="page">${esc(c[0])}</span>` : `<a href="${c[1]}">${esc(c[0])}</a>`).join(' / ')}</nav>`;
const crumbLd = (base, items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: base + c[1] })) });

function layout({ base, path, title, desc, body, extra = [], type, robots = 'index,follow' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${robots}">
${metaTags({ base, path, title, desc, type })}
<link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/style.css">
${extra.join('\n')}
</head><body><div class="wrap doc">
${header()}
${body}
${footer()}
</div></body></html>`;
}

function guideLinks(slugs) {
  return `<ul>${slugs.map(s => articleBySlug.get(s)).filter(Boolean).map(a => `<li><a href="/blog/${a.slug}">${esc(a.title)}</a></li>`).join('')}</ul>`;
}
const roomChips = list => `<ul class="cats">${list.map(t => `<li><a href="/topic/${t.slug}">${esc(t.name)}</a></li>`).join('')}</ul>`;

function topicPage(t, base) {
  const path = '/topic/' + t.slug, crumb = [['Home', '/'], ['Topics', '/topics'], [t.name, path]];
  const i = topics.indexOf(t), others = [];
  for (let k = 1; others.length < 6 && k < topics.length; k++) others.push(topics[(i + k) % topics.length]);
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: t.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
  const body = `${crumbs(crumb)}
<h1>${esc(t.h1)}</h1>
<p class="lead">${esc(t.intro)}</p>
<p><a class="btn" href="/chat#${t.slug}">Join the #${t.slug} room</a> <span id="live" class="mut" aria-live="polite"></span></p>
<h2>What people talk about</h2>
<ul>${t.talk.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>Good to know</h2>
<ul>${t.tips.map(x => `<li>${esc(x)}</li>`).join('')}<li>You must be 18 or older. Never share personal information with people you meet in chat.</li></ul>
<h2>Questions</h2>
${t.faq.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n')}
<h2>Related guides</h2>
${guideLinks(TOPIC_GUIDES[t.slug] || DEFAULT_GUIDES)}
<h2>More rooms</h2>
${roomChips(others)}
<script>fetch('/rooms?q=${t.slug}').then(function(r){return r.json()}).then(function(l){var x=l.filter(function(r){return r.name==='${t.slug}'})[0];document.getElementById('live').textContent=x?x.count+' online now':'No one is here right now. Be the first to say hello.'}).catch(function(){})</script>`;
  return layout({ base, path, title: t.title, desc: t.desc, body, extra: [ld(faq), ld(crumbLd(base, crumb))] });
}

function topicsIndex(base) {
  const title = 'Chat room topics: music, gaming, anime and more | JenChat', path = '/topics',
    desc = 'Browse JenChat chat rooms by topic: music, gaming, anime, movies, news, English practice, food, friends, memes, science and history. Free, no sign-up.';
  const body = `${crumbs([['Home', '/'], ['Topics', path]])}
<h1>Chat room topics</h1>
<p class="lead">Pick a topic and join people who want to talk about the same thing. Every room is free, and you only need a nickname.</p>
<ul class="cards">${topics.map(t => `<li><a href="/topic/${t.slug}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></a></li>`).join('')}</ul>
<p>Can't find your topic? Open the <a href="/chat">chat page</a> and type any name in "Join or create room" to start a new one.</p>`;
  return layout({ base, path, title, desc, body, extra: [ld(crumbLd(base, [['Home', '/'], ['Topics', path]]))] });
}

function blogIndex(base) {
  const title = 'JenChat blog: chat tips, safety and English practice', path = '/blog',
    desc = 'Practical guides for chatting online: staying safe with strangers, starting conversations, practising English and making private rooms.';
  const body = `${crumbs([['Home', '/'], ['Blog', path]])}
<h1>JenChat blog</h1>
<p class="lead">Short, practical guides for getting more out of online chat.</p>
<ul class="cards">${articles.map(a => `<li><a href="/blog/${a.slug}"><b>${esc(a.title)}</b><span>${esc(a.desc)}</span><small>${longDate(a.date)}</small></a></li>`).join('')}</ul>`;
  return layout({ base, path, title, desc, body, extra: [ld(crumbLd(base, [['Home', '/'], ['Blog', path]]))] });
}

function articlePage(a, base) {
  const path = '/blog/' + a.slug, crumb = [['Home', '/'], ['Blog', '/blog'], [a.title, path]];
  const art = { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.desc,
    datePublished: a.date, dateModified: a.date, image: base + '/og.png', mainEntityOfPage: base + path,
    author: { '@type': 'Organization', name: BRAND }, publisher: { '@type': 'Organization', name: BRAND } };
  const rooms = (GUIDE_TOPICS[a.slug] || []).map(s => topicBySlug.get(s)).filter(Boolean);
  const body = `${crumbs(crumb)}
<article><h1>${esc(a.title)}</h1>
<p class="mut">By the ${BRAND} team. Published <time datetime="${a.date}">${longDate(a.date)}</time></p>
${a.body}</article>
<p><a class="btn" href="/chat">Open the chat</a></p>
${rooms.length ? `<h2>Rooms to try</h2>${roomChips(rooms)}` : ''}
<h2>More guides</h2>
${guideLinks(articles.filter(x => x !== a).map(x => x.slug))}`;
  return layout({ base, path, title: a.title + ' | ' + BRAND, desc: a.desc, body, type: 'article', extra: [ld(art), ld(crumbLd(base, crumb))] });
}

function notFound(base) {
  const body = `<h1>Page not found</h1><p class="lead">We could not find that page.</p>
<p><a class="btn" href="/topics">Browse topics</a> <a class="btn" href="/blog">Read the blog</a></p>`;
  return layout({ base, path: '/', title: 'Page not found | ' + BRAND, desc: 'This page does not exist.', body, robots: 'noindex,follow' });
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function sitemap(base) {
  const urls = [['/'], ['/topics'], ['/blog'], ...topics.map(t => ['/topic/' + t.slug]), ...articles.map(a => ['/blog/' + a.slug, a.date]), ['/legal']];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(([p, d]) => `<url><loc>${xml(base + p)}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n') + `\n</urlset>\n`;
}
const robots = base => `User-agent: *\nAllow: /\nDisallow: /events\nDisallow: /send\nDisallow: /typing\nDisallow: /kick\nDisallow: /report\nDisallow: /rooms\n\nSitemap: ${base}/sitemap.xml\n`;

// Extra <head> tags for the static pages (index.html, legal.html). Everything else gets none.
function headFor(file, base, html) {
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || BRAND;
  const desc = ((html.match(/<meta name="description" content="([^"]*)"/) || [])[1]) || '';
  const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  if (file === 'index.html') {
    const site = { '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: base + '/', description: decode(desc) };
    return metaTags({ base, path: '/', title: decode(title), desc: decode(desc) }) + '\n' + ld(site);
  }
  if (file === 'legal.html') return metaTags({ base, path: '/legal', title: decode(title), desc: decode(desc) || 'About, privacy and terms of use for ' + BRAND + '.' });
  return '';
}
function injectHead(file, html, base) {
  const extra = headFor(file, base, html);
  return extra ? html.replace('</head>', extra + '\n</head>') : html;
}

// Returns { status, type, body } or { status: 301, location } for a seo path, or null if it is not ours.
const cache = new Map();
function route(pathname, base) {
  let m;
  if ((m = pathname.match(/^(\/(?:topics|blog|topic\/[^/]+|blog\/[^/]+))\/$/))) return { status: 301, location: m[1] };
  const key = base + '|' + pathname;
  if (cache.has(key)) return cache.get(key);
  let r = null;
  const html = body => ({ status: 200, type: 'text/html; charset=utf-8', body });
  if (pathname === '/topics') r = html(topicsIndex(base));
  else if (pathname === '/blog') r = html(blogIndex(base));
  else if ((m = pathname.match(/^\/topic\/([^/]+)$/))) {
    const t = topicBySlug.get(m[1]);
    r = t ? html(topicPage(t, base)) : { status: 404, type: 'text/html; charset=utf-8', body: notFound(base) };
  } else if ((m = pathname.match(/^\/blog\/([^/]+)$/))) {
    const a = articleBySlug.get(m[1]);
    r = a ? html(articlePage(a, base)) : { status: 404, type: 'text/html; charset=utf-8', body: notFound(base) };
  } else if (pathname === '/sitemap.xml') r = { status: 200, type: 'application/xml; charset=utf-8', body: sitemap(base) };
  else if (pathname === '/robots.txt') r = { status: 200, type: 'text/plain; charset=utf-8', body: robots(base) };
  if (r && cache.size < 300) cache.set(key, r);
  return r;
}

module.exports = { route, siteBase, injectHead };
