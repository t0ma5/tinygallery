// Public pages: / (home), /f/<token> (private folder), /a/<slug> and /f/<token>/<slug> (album).

// Source code link in the footer. Set to '' to hide it.
const REPO_URL = 'https://github.com/t0ma5/tinygallery';

const ICON = {
	github: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
	download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
	close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M15 4l-8 8 8 8"/></svg>',
	next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M9 4l8 8-8 8"/></svg>',
	share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 15V4m0 0L8 8m4-4l4 4M6 11H5v9h14v-9h-1"/></svg>',
};

function toast(message) {
	const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: message });
	document.body.appendChild(el);
	setTimeout(() => el.remove(), 2500);
}

// The device's own share sheet where the browser has one (phones, Safari, Chrome and Edge on desktop),
// otherwise the link is copied (for example Firefox on desktop).
async function shareLink(title, url) {
	if (navigator.share) {
		try {
			await navigator.share({ title, url });
		} catch (e) {
			if (e.name !== 'AbortError') toast('Could not share');
		}
		return;
	}
	try {
		await navigator.clipboard.writeText(url);
		toast('Link copied');
	} catch {
		prompt('Copy this link', url);
	}
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (key, size) => `/img/${key}/${size}`;
const app = document.getElementById('app');
let photographer = '';

const footer = () => `
	<footer class="footer">
		<span>© ${new Date().getFullYear()} ${esc(photographer)}</span>
		${REPO_URL ? `<a class="footer-repo" href="${REPO_URL}" target="_blank" rel="noopener" title="Source code on GitHub">${ICON.github}</a>` : ''}
	</footer>`;

function formatDate(iso) {
	if (!iso) return '';
	const d = new Date(iso + 'T12:00:00');
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fadeIn(root) {
	root.querySelectorAll('.tile img').forEach(el => {
		if (el.complete) el.classList.add('loaded');
		else el.addEventListener('load', () => el.classList.add('loaded'), { once: true });
	});
}

async function load(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) return null;
	const data = await res.json();
	if (data.photographer) photographer = data.photographer;
	return data;
}

function noindex() {
	document.head.insertAdjacentHTML('beforeend', '<meta name="robots" content="noindex">');
}

function renderNotFound() {
	document.title = photographer;
	noindex();
	app.innerHTML = `
		<main class="notice">
			<h1>Not available</h1>
			<p>This link is not valid or has been changed.<br>Ask ${esc(photographer)} for a new link.</p>
		</main>`;
}

// Full-screen cover: optional title in the middle, the photographer's name at the bottom.
// back: where "All albums" in the top corner leads (album pages only).
function coverHtml(key, title = '', sub = '', button = true, back = '') {
	return `
		<section class="cover">
			${key ? `<img src="${img(key, 'd')}" alt="">` : ''}
			${back ? `<a class="cover-back" href="${back}">${ICON.prev}<span>All albums</span></a>` : ''}
			<div class="cover-center">
				${title ? `<h1>${esc(title)}</h1>` : ''}
				${sub ? `<p>${esc(sub)}</p>` : ''}
				${button ? '<a class="btn-outline" href="#gallery">View gallery</a>' : ''}
			</div>
			<div class="cover-name">${esc(photographer)}</div>
		</section>`;
}

/* Home and private folders: cover, then album cards. A folder shows its name on the cover. */

function renderCollection(data, token) {
	document.title = data.title ? `${data.title} · ${photographer}` : photographer;
	const base = token ? `/f/${token}/` : '/a/';
	app.innerHTML = `
		${coverHtml(data.cover, data.title || '', '', data.albums.length > 0)}
		<main class="albums collection" id="gallery">
			${data.albums.map(a => `
				<a class="album-card" href="${base}${a.slug}">
					<div class="tile">${a.cover ? `<img src="${img(a.cover, 't')}" alt="" loading="lazy">` : ''}</div>
					<h2>${esc(a.title)}</h2>
					<span>${a.date ? `${esc(formatDate(a.date))} · ` : ''}${a.count} photo${a.count === 1 ? '' : 's'}</span>
				</a>`).join('')}
		</main>
		${footer()}`;
	fadeIn(app);
}

/* Album: cover, masonry grid, lightbox */

function renderAlbum(data) {
	const { album, photos, back } = data;
	document.title = `${album.title} · ${photographer}`;

	app.innerHTML = `
		${coverHtml(album.cover, album.title, formatDate(album.date), photos.length > 0, back)}
		<header class="header" id="gallery">
			<a class="header-back" href="${back}" title="All albums">${ICON.prev}<span class="brand-title">${esc(album.title)}</span></a>
		</header>
		<main class="grid" id="grid"></main>
		${footer()}
		<div class="lightbox" id="lightbox" aria-hidden="true">
			<div class="lightbox-bar">
				<span class="lightbox-count" id="lb-count"></span>
				<div>
					<button class="download-btn" id="lb-share" type="button">${ICON.share}<span class="download-label">Share</span></button>
					<a class="download-btn" id="lb-download" href="#" download>${ICON.download}<span class="download-label">Download</span></a>
					<button class="icon-btn" id="lb-close" title="Close">${ICON.close}</button>
				</div>
			</div>
			<div class="lightbox-stage" id="lb-stage">
				<button class="lightbox-nav prev" id="lb-prev" title="Previous">${ICON.prev}</button>
				<img id="lb-img" alt="">
				<button class="lightbox-nav next" id="lb-next" title="Next">${ICON.next}</button>
			</div>
		</div>`;

	const download = p => `${img(p.key, 'o')}?dl`;

	// Masonry: put each photo in the currently shortest column, so reading order stays left to right.
	const grid = document.getElementById('grid');
	let cols = 0;
	function layout() {
		const w = window.innerWidth;
		const n = w < 700 ? 2 : w < 1500 ? 3 : 4;
		if (n === cols) return;
		cols = n;
		const columns = Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'grid-col' }));
		const heights = new Array(n).fill(0);
		photos.forEach((p, i) => {
			const c = heights.indexOf(Math.min(...heights));
			heights[c] += p.h / p.w;
			const tile = document.createElement('a');
			tile.className = 'tile';
			tile.href = `#p${i + 1}`;
			tile.style.aspectRatio = `${p.w} / ${p.h}`;
			tile.innerHTML = `<img src="${img(p.key, 't')}" alt="" loading="lazy">
				<span class="tile-actions"><span class="icon-btn" data-download="${i}" title="Download">${ICON.download}</span></span>`;
			columns[c].appendChild(tile);
		});
		grid.replaceChildren(...columns);
		fadeIn(grid);
	}
	layout();
	window.addEventListener('resize', layout);

	// The tile is a link itself, so the download icon cannot be a nested link.
	grid.addEventListener('click', e => {
		const dl = e.target.closest('[data-download]');
		if (!dl) return;
		e.preventDefault();
		Object.assign(document.createElement('a'), { href: download(photos[dl.dataset.download]), download: '' }).click();
	});

	// Lightbox, driven by the URL hash (#p12) so the phone back button closes it.
	const lb = document.getElementById('lightbox');
	const view = document.getElementById('lb-img');
	const stage = document.getElementById('lb-stage');
	let current = -1;
	let original = null; // key whose original is loading or shown in the viewer

	// Past the display copy's resolution, swap in the original so zoomed detail stays sharp.
	const zoom = createZoom(stage, view, {
		onSwipe: d => go(d),
		onZoom: shownWidth => {
			const p = photos[current];
			if (!p || original === p.key || shownWidth * devicePixelRatio <= view.naturalWidth * 1.05) return;
			original = p.key;
			const full = new Image();
			full.onload = () => { if (photos[current] === p) view.src = full.src; };
			full.src = img(p.key, 'o');
		},
	});
	window.addEventListener('resize', () => zoom.reset());

	function show(i) {
		current = (i + photos.length) % photos.length;
		const p = photos[current];
		const src = img(p.key, 'd');
		zoom.reset();
		original = null;
		view.classList.add('fading');
		const next = new Image();
		next.onload = () => { view.src = src; view.classList.remove('fading'); };
		next.src = src;
		document.getElementById('lb-count').textContent = `${current + 1} / ${photos.length}`;
		document.getElementById('lb-download').href = download(p);
		[current - 1, current + 1].forEach(j => { new Image().src = img(photos[(j + photos.length) % photos.length].key, 'd'); });
	}

	function onHash() {
		const m = location.hash.match(/^#p(\d+)$/);
		if (m && photos.length) {
			if (!lb.classList.contains('open')) {
				lb.classList.add('open');
				lb.setAttribute('aria-hidden', 'false');
				document.body.style.overflow = 'hidden';
			}
			show(Number(m[1]) - 1);
		} else if (lb.classList.contains('open')) {
			zoom.reset();
			lb.classList.remove('open');
			lb.setAttribute('aria-hidden', 'true');
			document.body.style.overflow = '';
		}
	}

	function go(d) {
		history.replaceState(null, '', `#p${((current + d + photos.length) % photos.length) + 1}`);
		onHash();
	}

	window.addEventListener('hashchange', onHash);
	document.getElementById('lb-prev').onclick = () => go(-1);
	document.getElementById('lb-next').onclick = () => go(1);
	document.getElementById('lb-close').onclick = () => { location.hash = 'gallery'; };
	// Shares the link to this photo (the #p number opens it straight in the viewer).
	document.getElementById('lb-share').onclick = () => shareLink(document.title, location.href);
	document.addEventListener('keydown', e => {
		if (!lb.classList.contains('open')) return;
		if (e.key === 'ArrowLeft') go(-1);
		if (e.key === 'ArrowRight') go(1);
		if (e.key === 'Escape') location.hash = 'gallery';
	});

	onHash();
}

// Viewer zoom: pinch, double-tap or double-click, drag to pan, mouse wheel.
// Not zoomed in, a horizontal swipe changes the photo instead.
function createZoom(stage, view, { onSwipe, onZoom }) {
	const MAX = 6;
	let s = 1;
	let tx = 0;
	let ty = 0;
	let base = null; // image box at scale 1, measured when a zoom starts
	let gesture = null;
	let lastTap = null;
	const pointers = new Map();

	function measure() {
		const r = view.getBoundingClientRect();
		base = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
	}

	// Keep the zoomed image covering the stage: no empty gap at an edge while there is more image beyond it.
	function clamp() {
		const r = stage.getBoundingClientRect();
		const fit = (t, size, start, length, center) => {
			const extra = (size - length) / 2;
			if (extra <= 0) return 0;
			const mid = start + length / 2 - center;
			return Math.min(mid + extra, Math.max(mid - extra, t));
		};
		tx = fit(tx, base.w * s, r.left, r.width, base.cx);
		ty = fit(ty, base.h * s, r.top, r.height, base.cy);
	}

	function apply(animate) {
		view.classList.toggle('zoom-anim', animate);
		view.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
		stage.classList.toggle('zoomed', s > 1);
		if (s > 1) onZoom(base.w * s);
	}

	// Zoom to scale next, keeping the screen point (x, y) over the same spot of the photo.
	function zoomAt(next, x, y, animate = false) {
		if (!base || s === 1) measure();
		next = Math.min(MAX, Math.max(1, next));
		const k = next / s;
		tx = x - base.cx - (x - base.cx - tx) * k;
		ty = y - base.cy - (y - base.cy - ty) * k;
		s = next;
		if (s < 1.02) {
			s = 1;
			tx = ty = 0;
		}
		clamp();
		apply(animate);
	}

	function reset() {
		s = 1;
		tx = ty = 0;
		gesture = null;
		pointers.clear();
		apply(false);
	}

	function tap(x, y) {
		const now = Date.now();
		if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
			lastTap = null;
			zoomAt(s > 1 ? 1 : 2.5, x, y, true);
		} else {
			lastTap = { t: now, x, y };
		}
	}

	const pair = () => {
		const [a, b] = [...pointers.values()];
		return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	};

	stage.addEventListener('pointerdown', e => {
		if (e.target.closest('.lightbox-nav')) return;
		try { stage.setPointerCapture(e.pointerId); } catch {}
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			gesture = { type: s > 1 ? 'pan' : 'swipe', x: e.clientX, y: e.clientY, tx, ty };
		} else if (pointers.size === 2) {
			if (s === 1) measure();
			const p = pair();
			gesture = { type: 'pinch', d: p.d, x: p.x, y: p.y, s, tx, ty };
		}
	});

	stage.addEventListener('pointermove', e => {
		if (!pointers.has(e.pointerId) || !gesture) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (gesture.type === 'pan') {
			tx = gesture.tx + e.clientX - gesture.x;
			ty = gesture.ty + e.clientY - gesture.y;
			clamp();
			apply(false);
		} else if (gesture.type === 'pinch' && pointers.size >= 2) {
			const p = pair();
			const next = Math.min(MAX, Math.max(1, (gesture.s * p.d) / gesture.d));
			// The photo point that was under the fingers' midpoint stays under it while it moves.
			tx = p.x - base.cx - ((gesture.x - base.cx - gesture.tx) * next) / gesture.s;
			ty = p.y - base.cy - ((gesture.y - base.cy - gesture.ty) * next) / gesture.s;
			s = next;
			clamp();
			apply(false);
		}
	});

	function end(e) {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		if (!gesture) return;
		const dx = e.clientX - gesture.x;
		const dy = e.clientY - gesture.y;
		const still = Math.abs(dx) < 10 && Math.abs(dy) < 10;
		if (gesture.type === 'pinch') {
			if (s < 1.02) zoomAt(1, e.clientX, e.clientY, true);
			// One finger left on the screen carries on as a pan.
			const rest = [...pointers.values()][0];
			gesture = rest ? { type: 'pan', x: rest.x, y: rest.y, tx, ty } : null;
			lastTap = null;
			return;
		}
		gesture = null;
		if (e.type === 'pointercancel') return;
		if (still) tap(e.clientX, e.clientY);
		else if (s === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
	}
	stage.addEventListener('pointerup', end);
	stage.addEventListener('pointercancel', end);

	stage.addEventListener('wheel', e => {
		e.preventDefault();
		zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
	}, { passive: false });

	return { reset };
}

async function route() {
	const path = location.pathname.replace(/\/+$/, '') || '/';
	let m;
	if (path === '/') {
		const data = await load('/api/home');
		return data ? renderCollection(data) : renderNotFound();
	}
	if ((m = path.match(/^\/f\/([A-Za-z0-9]{12})$/))) {
		noindex();
		const data = await load(`/api/f/${m[1]}`);
		return data ? renderCollection(data, m[1]) : renderNotFound();
	}
	if ((m = path.match(/^\/f\/([A-Za-z0-9]{12})\/([a-z0-9-]+)$/))) {
		noindex();
		const data = await load(`/api/album/${m[2]}?f=${m[1]}`);
		return data ? renderAlbum(data) : renderNotFound();
	}
	if ((m = path.match(/^\/a\/([a-z0-9-]+)$/))) {
		const data = await load(`/api/album/${m[1]}`);
		return data ? renderAlbum(data) : renderNotFound();
	}
	renderNotFound();
}

route();
