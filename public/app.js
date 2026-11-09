// Public pages: / (home), /f/<token> (private folder), /a/<slug> and /f/<token>/<slug> (album).

const ICON = {
	play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
	pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8.5 5.5v13M15.5 5.5v13"/></svg>',
	heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
	github: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
	download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
	close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M15 4l-8 8 8 8"/></svg>',
	next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M9 4l8 8-8 8"/></svg>',
	share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 15V4m0 0L8 8m4-4l4 4M6 11H5v9h14v-9h-1"/></svg>',
	shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M16 4h4v4M4 20L20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/></svg>',
	qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"/></svg>',
};

// Loads a script from this site once (the QR code maker is only needed by the slideshow).
function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = Object.assign(document.createElement('script'), { src });
		s.onload = resolve;
		s.onerror = () => reject(new Error(`Could not load ${src}`));
		document.head.appendChild(s);
	});
}

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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const img = (key, size) => `/img/${key}/${size}`;
const app = document.getElementById('app');
let photographer = '';
let repo = ''; // REPO_URL in wrangler.toml; empty hides the footer icon

const footer = () => `
	<footer class="footer">
		<span>© ${new Date().getFullYear()} ${esc(photographer)}</span>
		${repo ? `<a class="footer-repo" href="${esc(repo)}" target="_blank" rel="noopener" title="Source code">${ICON.github}</a>` : ''}
	</footer>`;

// Browser storage can be blocked (private mode, settings); everything still works, favourites just do not persist.
const store = {
	get: k => { try { return localStorage.getItem(k); } catch { return null; } },
	set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

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

// Returns the page data, { locked } or { expired } for a closed private folder, or null.
async function load(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok && res.status !== 401 && res.status !== 410) return null;
	const data = await res.json();
	if (data.photographer) photographer = data.photographer;
	if (data.repo) repo = data.repo;
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

function renderExpired() {
	document.title = photographer;
	app.innerHTML = `
		<main class="notice">
			<h1>Link expired</h1>
			<p>This gallery is no longer available.<br>Ask ${esc(photographer)} for a new link.</p>
		</main>`;
}

// Password page for a protected folder; a right password sets an unlock cookie and reloads.
function renderLocked(token) {
	document.title = photographer;
	app.innerHTML = `
		<main class="notice">
			<form class="login" id="unlock">
				<h1>Private gallery</h1>
				<p>Enter the password from ${esc(photographer)}.</p>
				<input class="field" type="password" id="folder-password" autocomplete="current-password" placeholder="Password" required autofocus>
				<button class="btn-outline" type="submit">Open</button>
				<p class="login-error" id="unlock-error"></p>
			</form>
		</main>`;
	document.getElementById('unlock').addEventListener('submit', async e => {
		e.preventDefault();
		const res = await fetch(`/api/f/${token}/unlock`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: document.getElementById('folder-password').value }),
		});
		if (res.ok) return location.reload();
		document.getElementById('unlock-error').textContent = (await res.json().catch(() => ({}))).error || 'Could not open';
	});
}

// Asks once for an optional name, so the photographer knows whose favourites these are.
function askName() {
	return new Promise(resolve => {
		const el = document.createElement('div');
		el.className = 'modal';
		el.innerHTML = `
			<form class="modal-box">
				<h2>Your name</h2>
				<p>So ${esc(photographer)} knows whose favourites these are. Optional.</p>
				<input class="field" maxlength="60" autocomplete="name" placeholder="Name">
				<div class="row-actions">
					<button type="button" class="btn-small" data-skip>Skip</button>
					<button class="btn-small primary">Save</button>
				</div>
			</form>`;
		document.body.appendChild(el);
		const input = el.querySelector('input');
		input.focus();
		const done = name => { el.remove(); resolve(name); };
		el.querySelector('[data-skip]').onclick = () => done('');
		el.querySelector('form').onsubmit = e => { e.preventDefault(); done(input.value.trim()); };
	});
}

// Favourites of this browser in one folder: a random client id, the chosen photo keys and the name.
function favoritesFor(token) {
	let client = store.get('tg-client');
	if (!client) {
		client = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
		store.set('tg-client', client);
	}
	const keys = new Set();
	return {
		keys,
		async load() {
			const r = await fetch(`/api/f/${token}/favorites?client=${client}`).then(x => x.json()).catch(() => ({ keys: [] }));
			(r.keys || []).forEach(k => keys.add(k));
		},
		async toggle(key) {
			let name = store.get('tg-name');
			if (name === null && !keys.has(key)) {
				name = await askName();
				store.set('tg-name', name);
			}
			const on = !keys.has(key);
			if (on) keys.add(key); else keys.delete(key);
			const res = await fetch(`/api/f/${token}/favorites`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ client, key, on, name: name || null }),
			}).catch(() => null);
			if (!res || !res.ok) {
				if (on) keys.delete(key); else keys.add(key);
				toast('Could not save the favourite');
			}
			return keys.has(key);
		},
	};
}

// Full-screen cover: optional title in the middle, the photographer's name at the bottom.
// back: where "All albums" in the top corner leads (album pages only).
function coverHtml(key, title = '', sub = '', button = true, back = '') {
	return `
		<section class="cover">
			${key ? `<img src="${img(key, 'd')}" alt="" fetchpriority="high">` : ''}
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
	// A folder link is often shared before its photos are uploaded.
	if (!data.albums.length) {
		app.innerHTML = `
			<main class="notice">
				<h1>${esc(data.title || photographer)}</h1>
				<p>No photos here yet.<br>Check back soon.</p>
			</main>
			${footer()}`;
		fadeIn(app);
		return;
	}
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

function renderAlbum(data, token) {
	const { album, photos, back } = data;
	const canDownload = data.downloads !== false;
	const fav = data.favorites && token ? favoritesFor(token) : null;
	document.title = `${album.title} · ${photographer}`;

	app.innerHTML = `
		${coverHtml(album.cover, album.title, formatDate(album.date), photos.length > 0, back)}
		<header class="header" id="gallery">
			<a class="header-back" href="${back}" title="All albums">${ICON.prev}<span class="brand-title">${esc(album.title)}</span></a>
			<div class="header-actions">
				${fav ? `<button class="fav-filter" id="fav-filter" type="button" title="Show favourites" hidden>${ICON.heart}<span id="fav-count">0</span></button>` : ''}
				${canDownload && photos.length > 1 ? `<button class="fav-filter dl-all" id="dl-all" type="button" title="Download all photos as one ZIP file">${ICON.download}<span id="dl-all-label">Download all</span></button>` : ''}
			</div>
		</header>
		<main class="grid" id="grid"></main>
		<div id="more"></div>
		${footer()}
		<div class="lightbox" id="lightbox" aria-hidden="true">
			<div class="lightbox-bar">
				<span class="lightbox-count" id="lb-count"></span>
				<div>
					${fav ? `<button class="download-btn fav-btn" id="lb-fav" type="button">${ICON.heart}<span class="download-label">Favourite</span></button>` : ''}
					<button class="download-btn slide-only" id="lb-speed" type="button" title="Seconds per photo"><span class="slide-speed" id="lb-speed-label"></span></button>
					<button class="download-btn slide-only" id="lb-shuffle" type="button" title="Shuffle">${ICON.shuffle}<span class="download-label">Shuffle</span></button>
					<button class="download-btn slide-only" id="lb-qr" type="button" title="Show a QR code so guests can open this album on their phones">${ICON.qr}<span class="download-label">QR</span></button>
					<button class="download-btn" id="lb-play" type="button" title="Slideshow">${ICON.play}<span class="download-label">Slideshow</span></button>
					<button class="download-btn" id="lb-share" type="button">${ICON.share}<span class="download-label">Share</span></button>
					${canDownload ? `<a class="download-btn" id="lb-download" href="#" download>${ICON.download}<span class="download-label">Download</span></a>` : ''}
					<button class="icon-btn" id="lb-close" title="Close">${ICON.close}</button>
				</div>
			</div>
			<div class="lightbox-stage" id="lb-stage">
				<button class="lightbox-nav prev" id="lb-prev" title="Previous">${ICON.prev}</button>
				<img id="lb-img" alt="">
				<button class="lightbox-nav next" id="lb-next" title="Next">${ICON.next}</button>
			</div>
			<div class="slide-qr" id="lb-qrcode" hidden></div>
		</div>`;

	const download = p => `${img(p.key, 'o')}?dl`;
	const grid = document.getElementById('grid');
	const more = document.getElementById('more');

	// visible: all photos, or only the favourites while that filter is on. Grid and viewer both use it.
	let visible = photos;
	let onlyFavs = false;

	// Masonry: each photo goes into the currently shortest column, so reading order stays left to right.
	// Big albums render 100 tiles at a time; more are added as the visitor scrolls near the end.
	const PAGE = 100;
	let cols = 0;
	let columns = [];
	let heights = [];
	let shown = 0;

	function tile(p, i) {
		const t = document.createElement('a');
		t.className = 'tile' + (fav?.keys.has(p.key) ? ' is-fav' : '');
		t.href = `#p${i + 1}`;
		t.style.aspectRatio = `${p.w} / ${p.h}`;
		t.innerHTML = `<img src="${img(p.key, 't')}" alt="" loading="lazy">
			<span class="tile-actions">
				${fav ? `<span class="icon-btn tile-fav" data-fav="${i}" title="Favourite">${ICON.heart}</span>` : ''}
				${canDownload ? `<span class="icon-btn" data-download="${i}" title="Download">${ICON.download}</span>` : ''}
			</span>`;
		return t;
	}

	function addTiles(upTo) {
		for (let i = shown; i < upTo; i++) {
			const c = heights.indexOf(Math.min(...heights));
			heights[c] += visible[i].h / visible[i].w;
			columns[c].appendChild(tile(visible[i], i));
		}
		shown = upTo;
		fadeIn(grid);
	}

	function layout(restart = false) {
		const w = window.innerWidth;
		const n = w < 700 ? 2 : w < 1500 ? 3 : 4;
		if (n === cols && !restart) return;
		cols = n;
		columns = Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'grid-col' }));
		heights = new Array(n).fill(0);
		grid.replaceChildren(...columns);
		const target = restart ? PAGE : Math.max(shown, PAGE);
		shown = 0;
		addTiles(Math.min(target, visible.length));
	}
	layout();
	window.addEventListener('resize', () => layout());

	new IntersectionObserver(entries => {
		if (entries[0].isIntersecting && shown < visible.length) addTiles(Math.min(shown + PAGE, visible.length));
	}, { rootMargin: '1500px' }).observe(more);

	// Favourites: hearts on tiles and in the viewer, and a header button that shows only the picked photos.
	function refreshFavs() {
		if (!fav) return;
		const n = photos.filter(p => fav.keys.has(p.key)).length;
		const filter = document.getElementById('fav-filter');
		document.getElementById('fav-count').textContent = n;
		filter.hidden = n === 0 && !onlyFavs;
		filter.classList.toggle('active', onlyFavs);
		grid.querySelectorAll('.tile').forEach(t => {
			const i = Number(t.getAttribute('href').slice(2)) - 1;
			t.classList.toggle('is-fav', fav.keys.has(visible[i]?.key));
		});
		const p = visible[current];
		document.getElementById('lb-fav')?.classList.toggle('on', !!p && fav.keys.has(p.key));
	}

	async function toggleFav(p) {
		await fav.toggle(p.key);
		refreshFavs();
	}

	if (fav) {
		fav.load().then(refreshFavs);
		document.getElementById('fav-filter').onclick = () => {
			onlyFavs = !onlyFavs;
			visible = onlyFavs ? photos.filter(p => fav.keys.has(p.key)) : photos;
			order = [];
			const dl = document.getElementById('dl-all-label');
			if (dl) dl.textContent = onlyFavs ? 'Download favourites' : 'Download all';
			layout(true);
			refreshFavs();
			document.getElementById('gallery').scrollIntoView();
		};
		document.getElementById('lb-fav').onclick = () => toggleFav(visible[current]);
	}

	// All photos shown (or only the favourites while that filter is on) as one ZIP of the originals, made in the
	// browser. Chrome and Edge on a computer write it straight to disk; other browsers build it in memory first,
	// which can fail for very large albums on phones. JPEGs do not shrink in a ZIP, so nothing is compressed.
	const dlAll = document.getElementById('dl-all');
	if (dlAll) dlAll.onclick = async () => {
		const list = visible.slice();
		const label = document.getElementById('dl-all-label');
		const idle = label.textContent;
		const zipName = `${album.title}${onlyFavs ? ' - favourites' : ''}.zip`.replace(/[\\/:*?"<>|]+/g, '-');
		let file = null;
		if (window.showSaveFilePicker) {
			try {
				file = await (await showSaveFilePicker({ suggestedName: zipName, types: [{ description: 'ZIP file', accept: { 'application/zip': ['.zip'] } }] })).createWritable();
			} catch (e) {
				if (e.name === 'AbortError') return;
			}
		}
		dlAll.disabled = true;
		try {
			const { downloadZip } = await import('/vendor/client-zip.js');
			const names = new Map();
			// Two photos with the same file name get "name (2).jpg" inside the ZIP.
			const unique = name => {
				const n = (names.get(name) || 0) + 1;
				names.set(name, n);
				return n === 1 ? name : name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
			};
			let done = 0;
			async function* files() {
				for (const p of list) {
					label.textContent = `${done + 1} / ${list.length}`;
					// Only the first file goes through the download counter: one ZIP counts as one download.
					const res = await fetch(done ? img(p.key, 'o') : download(p));
					if (!res.ok) throw new Error(`could not get ${p.name}`);
					done++;
					yield { name: unique(p.name || `${p.key}.jpg`), input: res };
				}
			}
			const zip = downloadZip(files());
			if (file) {
				await zip.body.pipeTo(file);
			} else {
				const url = URL.createObjectURL(await zip.blob());
				Object.assign(document.createElement('a'), { href: url, download: zipName }).click();
				setTimeout(() => URL.revokeObjectURL(url), 60000);
			}
			toast(`${plural(list.length, 'photo')} saved as ${zipName}`);
		} catch (e) {
			toast(`Download stopped: ${e.message}`);
		} finally {
			dlAll.disabled = false;
			label.textContent = idle;
		}
	};

	// The tile is a link itself, so its icons cannot be nested links.
	grid.addEventListener('click', e => {
		const dl = e.target.closest('[data-download]');
		const heart = e.target.closest('[data-fav]');
		if (!dl && !heart) return;
		e.preventDefault();
		if (heart) return toggleFav(visible[heart.dataset.fav]);
		Object.assign(document.createElement('a'), { href: download(visible[dl.dataset.download]), download: '' }).click();
	});

	// Lightbox, driven by the URL hash (#p12) so the phone back button closes it.
	const lb = document.getElementById('lightbox');
	const view = document.getElementById('lb-img');
	const stage = document.getElementById('lb-stage');
	let current = -1;
	let original = null; // key whose original is loading or shown in the viewer

	// Well past the display copy's resolution, swap in the original so zoomed detail stays sharp.
	// The margin keeps a phone's double-tap zoom on the display copy: originals can be tens of MB on mobile data.
	// Without downloads the original is not served, so zoom stays on the display copy.
	const zoom = createZoom(stage, view, {
		onSwipe: d => go(d),
		onZoom: shownWidth => {
			const p = visible[current];
			if (!canDownload || !p || original === p.key || shownWidth * devicePixelRatio <= view.naturalWidth * 1.5) return;
			original = p.key;
			const full = new Image();
			full.onload = () => { if (visible[current] === p) view.src = full.src; };
			full.src = img(p.key, 'o');
		},
	});
	window.addEventListener('resize', () => zoom.reset());

	function show(i) {
		current = (i + visible.length) % visible.length;
		const p = visible[current];
		const src = img(p.key, 'd');
		zoom.reset();
		original = null;
		view.classList.add('fading');
		// Only the photo still selected may take the screen: after quick swipes an older one can finish last.
		// A failed photo still shows (as broken) rather than leaving the viewer blank.
		const next = new Image();
		next.onload = next.onerror = () => {
			if (visible[current] !== p) return;
			view.src = src;
			view.classList.remove('fading');
			if (playing) nextSlide();
		};
		next.src = src;
		document.getElementById('lb-count').textContent = `${current + 1} / ${visible.length}`;
		const dl = document.getElementById('lb-download');
		if (dl) dl.href = download(p);
		refreshFavs();
		[current - 1, current + 1].forEach(j => { new Image().src = img(visible[(j + visible.length) % visible.length].key, 'd'); });
	}

	function onHash() {
		const m = location.hash.match(/^#p(\d+)$/);
		if (m && visible.length) {
			if (!lb.classList.contains('open')) {
				lb.classList.add('open');
				lb.setAttribute('aria-hidden', 'false');
				document.body.style.overflow = 'hidden';
			}
			show(Number(m[1]) - 1);
		} else if (lb.classList.contains('open')) {
			stopShow();
			zoom.reset();
			lb.classList.remove('open');
			lb.setAttribute('aria-hidden', 'true');
			document.body.style.overflow = '';
		}
	}

	function go(d) {
		history.replaceState(null, '', `#p${((current + d + visible.length) % visible.length) + 1}`);
		onHash();
	}

	// Opened from the grid, closing steps back in history, so the phone's back button does not reopen the photo.
	// Opened from a shared #p link, closing just drops the hash.
	let fromGrid = false;
	function closeViewer() {
		if (fromGrid) return history.back();
		history.replaceState(null, '', location.pathname + location.search);
		onHash();
	}

	window.addEventListener('hashchange', () => {
		const opening = !lb.classList.contains('open');
		onHash();
		if (opening) fromGrid = lb.classList.contains('open');
	});
	document.getElementById('lb-prev').onclick = () => go(-1);
	document.getElementById('lb-next').onclick = () => go(1);
	document.getElementById('lb-close').onclick = closeViewer;
	// Shares the link to this photo; the number counts in the whole album, so it also works while filtered.
	document.getElementById('lb-share').onclick = () =>
		shareLink(document.title, `${location.origin}${location.pathname}#p${photos.indexOf(visible[current]) + 1}`);
	document.addEventListener('keydown', e => {
		if (!lb.classList.contains('open')) return;
		if (playing && (e.key === 'Escape' || e.key === ' ')) {
			e.preventDefault();
			return stopShow();
		}
		if (e.key === 'ArrowLeft') go(-1);
		if (e.key === 'ArrowRight') go(1);
		if (e.key === 'Escape') closeViewer();
		if (e.key === ' ') { e.preventDefault(); startShow(); }
	});

	// Slideshow: full screen, a new photo every few seconds, looping until stopped, screen kept awake.
	// Meant to run unattended, for example on a TV at a party. Follows the favourites filter.
	// Speed, shuffle and the QR code are remembered in this browser.
	const SPEEDS = [3, 5, 10];
	let slideSeconds = SPEEDS.includes(Number(store.get('tg-slide-seconds'))) ? Number(store.get('tg-slide-seconds')) : 5;
	let shuffle = store.get('tg-slide-shuffle') === '1';
	let showQr = store.get('tg-slide-qr') === '1';
	let order = []; // shuffled photo positions still to show in this round
	const playBtn = document.getElementById('lb-play');
	let playing = false;
	let timer = null;
	let wakeLock = null;
	let hideUi = null;

	function slideButtons() {
		document.getElementById('lb-speed-label').textContent = `${slideSeconds} s`;
		document.getElementById('lb-shuffle').classList.toggle('on', shuffle);
		document.getElementById('lb-qr').classList.toggle('on', showQr);
	}
	slideButtons();
	document.getElementById('lb-speed').onclick = () => {
		slideSeconds = SPEEDS[(SPEEDS.indexOf(slideSeconds) + 1) % SPEEDS.length];
		store.set('tg-slide-seconds', slideSeconds);
		slideButtons();
		if (playing) nextSlide();
	};
	document.getElementById('lb-shuffle').onclick = () => {
		shuffle = !shuffle;
		order = [];
		store.set('tg-slide-shuffle', shuffle ? '1' : '0');
		slideButtons();
	};
	document.getElementById('lb-qr').onclick = () => {
		showQr = !showQr;
		store.set('tg-slide-qr', showQr ? '1' : '0');
		slideButtons();
		drawQr();
	};

	// A QR code in the corner so guests can open the album on their own phones (the link of this page).
	const qrBox = document.getElementById('lb-qrcode');
	async function drawQr() {
		qrBox.hidden = !(playing && showQr);
		if (qrBox.hidden || qrBox.firstChild) return;
		try {
			if (!window.qrcode) await loadScript('/vendor/qrcode.js');
			const qr = qrcode(0, 'M');
			qr.addData(location.origin + location.pathname);
			qr.make();
			qrBox.innerHTML = `${qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true })}<span>Scan for the album</span>`;
		} catch {
			qrBox.hidden = true;
		}
	}

	// Next photo: in order, or in a shuffled order that shows every photo once before repeating.
	function advance() {
		if (!shuffle || visible.length < 3) return go(1);
		if (!order.length) {
			order = visible.map((_, i) => i).filter(i => i !== current);
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[order[i], order[j]] = [order[j], order[i]];
			}
		}
		const i = order.pop();
		if (i >= visible.length) { order = []; return go(1); }
		history.replaceState(null, '', `#p${i + 1}`);
		onHash();
	}

	function revealUi() {
		lb.classList.add('show-ui');
		clearTimeout(hideUi);
		hideUi = setTimeout(() => lb.classList.remove('show-ui'), 3000);
	}

	async function keepAwake() {
		try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
	}

	function startShow() {
		if (playing || !visible.length) return;
		playing = true;
		if (!lb.classList.contains('open')) location.hash = `p${current >= 0 ? current + 1 : 1}`;
		lb.classList.add('slideshow');
		playBtn.innerHTML = `${ICON.pause}<span class="download-label">Pause</span>`;
		// Full screen where the browser allows it (not on iPhone); the slideshow runs either way.
		if (!document.fullscreenElement) lb.requestFullscreen?.().catch(() => {});
		keepAwake();
		drawQr();
		if (lb.classList.contains('open')) nextSlide();
	}

	// Each photo stays the full time after it has loaded, so slow wifi never skips photos.
	function nextSlide() {
		clearTimeout(timer);
		timer = setTimeout(advance, slideSeconds * 1000);
	}

	function stopShow() {
		if (!playing) return;
		playing = false;
		clearTimeout(timer);
		lb.classList.remove('slideshow', 'show-ui');
		qrBox.hidden = true;
		playBtn.innerHTML = `${ICON.play}<span class="download-label">Slideshow</span>`;
		wakeLock?.release().catch(() => {});
		wakeLock = null;
		if (document.fullscreenElement === lb) document.exitFullscreen().catch(() => {});
	}

	playBtn.onclick = () => (playing ? stopShow() : startShow());
	// The controls stay hidden while it plays. A tap on the photo shows them (phones have no mouse to move);
	// a tap while they show stops the slideshow. The buttons keep their own action.
	lb.addEventListener('pointerdown', e => {
		if (!playing || e.target.closest('button, a')) return;
		e.stopPropagation();
		if (lb.classList.contains('show-ui')) stopShow();
		else revealUi();
	}, true);
	lb.addEventListener('mousemove', () => { if (playing) revealUi(); });
	document.addEventListener('fullscreenchange', () => {
		if (playing && !document.fullscreenElement) stopShow();
	});
	// The browser drops the wake lock when the tab is hidden; take it again on return.
	document.addEventListener('visibilitychange', () => {
		if (playing && document.visibilityState === 'visible') keepAwake();
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
		if (data?.locked) return renderLocked(m[1]);
		if (data?.expired) return renderExpired();
		return data ? renderCollection(data, m[1]) : renderNotFound();
	}
	if ((m = path.match(/^\/f\/([A-Za-z0-9]{12})\/([a-z0-9-]+)$/))) {
		noindex();
		const data = await load(`/api/album/${m[2]}?f=${m[1]}`);
		if (data?.locked) return renderLocked(m[1]);
		if (data?.expired) return renderExpired();
		return data ? renderAlbum(data, m[1]) : renderNotFound();
	}
	if ((m = path.match(/^\/a\/([a-z0-9-]+)$/))) {
		const data = await load(`/api/album/${m[1]}`);
		return data ? renderAlbum(data) : renderNotFound();
	}
	renderNotFound();
}

route();
