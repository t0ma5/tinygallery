// Link previews (WhatsApp, Messenger, Slack...): those apps do not run JavaScript, so the page HTML
// gets Open Graph tags filled in on the server. The page itself still renders in the browser.
import { homeData, folderData, albumData } from './data.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatDate(iso) {
	if (!iso) return '';
	return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Password-protected and expired folders show only the site name: chat apps have no unlock cookie.
const closed = d => ({ site: d.photographer, title: d.photographer, description: d.expired ? 'This link has expired' : 'Private gallery', cover: null });

async function metaFor(env, request, path) {
	let m;
	if (path === '/') {
		const d = await homeData(env);
		return { site: d.photographer, title: d.photographer, description: 'Photography', cover: d.cover };
	}
	if ((m = path.match(/^\/f\/([A-Za-z0-9]{12})$/))) {
		const d = await folderData(env, request, m[1]);
		if (d && (d.locked || d.expired)) return closed(d);
		return d && { site: d.photographer, title: d.title, description: `${plural(d.albums.length, 'album')} · Photos by ${d.photographer}`, cover: d.cover };
	}
	m = path.match(/^\/f\/([A-Za-z0-9]{12})\/([a-z0-9-]{1,80})$/) || path.match(/^\/a\/()([a-z0-9-]{1,80})$/);
	if (m) {
		const d = await albumData(env, request, m[2], m[1] || null, false, false);
		if (!d) return null;
		if (d.locked || d.expired) return closed(d);
		const parts = [formatDate(d.album.date), plural(d.album.count, 'photo'), `Photos by ${d.photographer}`].filter(Boolean);
		return { site: d.photographer, title: d.album.title, description: parts.join(' · '), cover: d.album.cover };
	}
	return null;
}

export async function renderPage({ request, env }) {
	const url = new URL(request.url);
	const page = await env.ASSETS.fetch(new URL('/', url));
	let meta = null;
	try {
		meta = await metaFor(env, request, url.pathname.replace(/\/+$/, '') || '/');
	} catch (e) {
		console.error(e);
	}
	if (!meta || !page.ok) return page;

	const image = meta.cover ? `${url.origin}/img/${meta.cover}/t` : '';
	const tags = [
		['og:type', 'website'],
		['og:site_name', meta.site],
		['og:title', meta.title],
		['og:description', meta.description],
		['og:url', url.origin + url.pathname],
		image && ['og:image', image],
		image && ['og:image:type', 'image/jpeg'],
	].filter(Boolean).map(([p, c]) => `<meta property="${p}" content="${esc(c)}">`);
	tags.push(`<meta name="description" content="${esc(meta.description)}">`);
	tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);

	const response = new HTMLRewriter()
		.on('title', { element: e => e.setInnerContent(meta.title) })
		.on('head', { element: e => e.append(tags.join('\n\t') + '\n', { html: true }) })
		.transform(page);
	const headers = new Headers(response.headers);
	headers.delete('etag');
	headers.set('cache-control', 'no-cache');
	return new Response(response.body, { status: response.status, headers });
}
