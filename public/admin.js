// Admin panel: login, albums and uploads, private folders, cover photos.
const app = document.getElementById('app');
let S = null; // state from /api/admin/state

const ICON = {
	folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6.5h6l2 2h10V19H3z"/></svg>',
	grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

ICON.heart = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';

// One line under a folder name: albums, views, last opened, favourites, password and expiry at a glance.
function folderMeta(f, albums) {
	const today = new Date().toISOString().slice(0, 10);
	return [
		plural(albums.length, 'album'),
		plural(f.views, 'view'),
		// Stored in UTC as "YYYY-MM-DD HH:MM:SS".
		f.last_viewed_at ? `opened ${timeAgo(Date.parse(f.last_viewed_at.replace(' ', 'T') + 'Z'))}` : 'not opened yet',
		f.favorites && `♥ ${f.favorites}`,
		f.has_password && 'password',
		f.expires_at && (f.expires_at < today ? 'expired' : `until ${f.expires_at}`),
		f.downloads_off && 'downloads off',
	].filter(Boolean).join(' · ');
}

const gripHtml ='<span class="drag-handle" title="Drag to reorder">' + ICON.grip + '</span>';

// Drag to reorder the [data-id] children of a list or grid, by their .drag-handle; mouse and touch.
// onDrop gets the ids in their new order.
function makeSortable(container, onDrop) {
	let drag = null;
	container.addEventListener('pointerdown', e => {
		const handle = e.target.closest('.drag-handle');
		const item = handle?.closest('[data-id]');
		if (!item || item.parentElement !== container) return;
		e.preventDefault();
		try { container.setPointerCapture(e.pointerId); } catch {}
		drag = { item, x: e.clientX, y: e.clientY, moved: false };
	});
	container.addEventListener('pointermove', e => {
		if (!drag) return;
		if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
		drag.moved = true;
		drag.item.classList.add('dragging');
		const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]');
		if (!over || over === drag.item || over.parentElement !== container) return;
		const r = over.getBoundingClientRect();
		const after = getComputedStyle(container).display === 'grid'
			? e.clientX > r.left + r.width / 2
			: e.clientY > r.top + r.height / 2;
		container.insertBefore(drag.item, after ? over.nextSibling : over);
	});
	const end = () => {
		if (!drag) return;
		const moved = drag.moved;
		drag.item.classList.remove('dragging');
		drag = null;
		if (moved) onDrop([...container.children].filter(el => el.dataset.id).map(el => Number(el.dataset.id)));
	};
	container.addEventListener('pointerup', end);
	container.addEventListener('pointercancel', end);
}

/* JPEG metadata, read and edited in the browser before upload */

// Finds the EXIF block: date taken (DateTimeOriginal) and where the GPS block is. null if there is no EXIF.
function readExif(buf) {
	const v = new DataView(buf);
	if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
	for (let o = 2; o + 10 < v.byteLength;) {
		const marker = v.getUint16(o);
		const len = v.getUint16(o + 2);
		if (marker === 0xffda) break; // image data starts, no more metadata
		if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) { // "Exif"
			const t = o + 10; // TIFF header
			const le = v.getUint16(t) === 0x4949;
			const u16 = p => v.getUint16(t + p, le);
			const u32 = p => v.getUint32(t + p, le);
			// tag -> offset of its 12-byte entry, relative to the TIFF header
			const ifd = p => {
				const entries = {};
				for (let i = 0, n = u16(p); i < n; i++) entries[u16(p + 2 + i * 12)] = p + 2 + i * 12;
				return entries;
			};
			const ifd0 = ifd(u32(4));
			let taken = null;
			if (ifd0[0x8769] !== undefined) {
				const sub = ifd(u32(ifd0[0x8769] + 8));
				const e = sub[0x9003] ?? sub[0x9004];
				if (e !== undefined) {
					const off = u32(e + 8);
					const s = String.fromCharCode(...new Uint8Array(buf, t + off, 19));
					if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) taken = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
				}
			}
			return { v, t, le, u16, u32, gps: ifd0[0x8825] ?? null, taken };
		}
		o += 2 + len;
	}
	return null;
}

// Blanks the location in place: every GPS entry and its data in the EXIF block, and GPS fields in XMP
// (Lightroom and phones often write both). Sizes stay the same, so the rest of the file is untouched.
function stripGps(buf) {
	const x = readExif(buf);
	if (x && x.gps !== null) {
		const { v, t, le, u16, u32 } = x;
		const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
		const gps = u32(x.gps + 8);
		for (let i = 0, n = u16(gps); i < n; i++) {
			const e = gps + 2 + i * 12;
			const bytes = (SIZE[u16(e + 2)] || 1) * u32(e + 4);
			if (bytes > 4) new Uint8Array(buf, t + u32(e + 8), bytes).fill(0);
			new Uint8Array(buf, t + e, 12).fill(0);
		}
		v.setUint16(t + gps, 0, le);
	}
	const v = new DataView(buf);
	for (let o = 2; o + 4 < v.byteLength;) {
		const marker = v.getUint16(o);
		const len = v.getUint16(o + 2);
		if (marker === 0xffda) break;
		if (marker === 0xffe1) {
			const seg = new Uint8Array(buf, o + 4, len - 2);
			const text = new TextDecoder('latin1').decode(seg);
			if (text.startsWith('http://ns.adobe.com/xap/1.0/')) {
				const blanked = text
					.replace(/exif:GPS\w+="[^"]*"/g, m => ' '.repeat(m.length))
					.replace(/<exif:GPS(\w+)>[\s\S]*?<\/exif:GPS\1>/g, m => ' '.repeat(m.length));
				for (let i = 0; i < seg.length; i++) seg[i] = blanked.charCodeAt(i);
			}
		}
		o += 2 + len;
	}
}

// Search boxes for the album and folder lists; their text is kept while the admin page is open.
const queries = { albums: '', folders: '' };

// Lowercase without accents, so "seinajoki" finds "Seinäjoki".
const searchText = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Shows the list rows whose data-search contains every typed word.
function bindSearch(name) {
	const box = document.getElementById(`${name}-search`);
	if (!box) return;
	const filter = () => {
		const words = searchText(queries[name]).split(/\s+/).filter(Boolean);
		let shown = 0;
		app.querySelectorAll(`#${name}-list [data-search]`).forEach(li => {
			const match = words.every(w => li.dataset.search.includes(w));
			li.hidden = !match;
			if (match) shown++;
		});
		document.getElementById(`${name}-empty`).hidden = shown > 0;
	};
	box.addEventListener('input', () => {
		queries[name] = box.value;
		filter();
	});
	filter();
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (key, size) => `/img/${key}/${size}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

class LoginNeeded extends Error {}

async function api(path, { method = 'GET', body } = {}) {
	const headers = { 'x-admin': '1' };
	let payload;
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
		payload = JSON.stringify(body);
	}
	const res = await fetch(`/api/admin/${path}`, { method, headers, body: payload });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && path !== 'login') {
		renderLogin();
		throw new LoginNeeded();
	}
	if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
	return data;
}

function toast(message) {
	const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: message });
	document.body.appendChild(el);
	setTimeout(() => el.remove(), 3500);
}

// Runs an action and reports errors, so every button handler stays short.
async function run(fn) {
	try { await fn(); } catch (e) { if (!(e instanceof LoginNeeded)) toast(e.message); }
}

/* Login */

function renderLogin() {
	document.title = 'Admin';
	app.innerHTML = `
		<main class="notice">
			<form class="login" id="login">
				<h1>Admin</h1>
				<input class="field" type="password" id="password" autocomplete="current-password" placeholder="Password" required autofocus>
				<button class="btn-outline" type="submit">Log in</button>
				<p class="login-error" id="login-error"></p>
			</form>
		</main>`;
	document.getElementById('login').addEventListener('submit', async e => {
		e.preventDefault();
		try {
			await api('login', { method: 'POST', body: { password: document.getElementById('password').value } });
			await start();
		} catch (err) {
			document.getElementById('login-error').textContent = err.message;
		}
	});
}

/* Helpers for where an album lives */

const folderOf = id => S.folders.find(f => f.id === id);

function whereLabel(a) {
	if (a.folder_id) return `Folder: ${folderOf(a.folder_id)?.title || '?'}`;
	return a.hidden ? 'Hidden' : 'Home page';
}

function whereValue(a) {
	if (a.folder_id) return `folder:${a.folder_id}`;
	return a.hidden ? 'hidden' : 'home';
}

function whereSelect(id, selected) {
	return `
		<select class="field" id="${id}">
			<option value="home"${selected === 'home' ? ' selected' : ''}>Home page (public)</option>
			<option value="hidden"${selected === 'hidden' ? ' selected' : ''}>Hidden</option>
			${S.folders.map(f => `<option value="folder:${f.id}"${selected === `folder:${f.id}` ? ' selected' : ''}>Folder: ${esc(f.title)}</option>`).join('')}
		</select>`;
}

function parseWhere(v) {
	if (v.startsWith('folder:')) return { folder_id: Number(v.slice(7)), hidden: false };
	return { folder_id: null, hidden: v === 'hidden' };
}

function albumUrl(a) {
	const f = a.folder_id && folderOf(a.folder_id);
	return f ? `/f/${f.token}/${a.slug}` : `/a/${a.slug}`;
}

const header = () => `
	<header class="header">
		<a href="#"><span class="brand-title">Admin</span></a>
		<div class="row-actions">
			<a class="btn-small" href="/" target="_blank" rel="noopener">View site</a>
			<button class="btn-small" id="logout">Log out</button>
		</div>
	</header>`;

function bindHeader() {
	document.getElementById('logout').onclick = () => run(async () => {
		await api('logout', { method: 'POST' });
		renderLogin();
	});
}

/* Storage used in R2, counted only when the admin asks */

function formatBytes(bytes) {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function timeAgo(ms) {
	const min = Math.floor((Date.now() - ms) / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}min ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

// The photo count comes from the database and is always current; only the size needs a recount.
function storageLine(storage) {
	const recount = '<button type="button" class="link-btn" id="recount">Recount</button>';
	const size = storage ? `${formatBytes(storage.bytes)} · ` : '';
	const age = storage ? timeAgo(storage.checked) : 'not counted yet';
	return `Storage used: ${size}${plural(S.photoCount, 'photo')} · ${age} · ${recount}`;
}

/* Cover chooser for the home page or a folder */

// The home page takes up to this many covers and shows one at random on each visit.
const HOME_COVERS = 5;

const thumbHtml = (p, selected) => `
	<button type="button" class="cover-thumb${selected ? ' selected' : ''}" data-photo="${p.id}" data-key="${p.key}">
		<img src="${img(p.key, 't')}" alt="" loading="lazy">
	</button>`;

// Cover chooser for the home page (several covers) or a folder (one), over many albums. Nothing loads until
// it is opened; then one album's photos at a time, picked from a list, so any photo can be the cover.
function coverChooser(kind, id, selectedIds, shownKey, albums) {
	albums = albums.filter(a => a.count);
	if (!albums.length) return '<p class="admin-hint cover-picker">Add photos to choose a cover.</p>';
	const multi = kind === 'home';
	return `
		<details class="cover-picker" data-kind="${kind}" data-id="${id}" data-selected="${selectedIds.filter(Boolean).join(',')}">
			<summary><img src="${img(shownKey || albums.find(a => a.cover)?.cover, 't')}" alt="">
				<span>${multi ? 'Cover photos' : 'Cover photo'}</span>
				${multi ? `<em class="cover-count">${selectedIds.length} of ${HOME_COVERS}, one at random on each visit</em>` : ''}
				<small>Change</small></summary>
			${multi ? '<div class="cover-thumbs cover-chosen"></div>' : ''}
			<select class="field cover-album">
				${albums.map(a => `<option value="${a.id}">${esc(a.title)} (${plural(a.count, 'photo')})</option>`).join('')}
			</select>
			<div class="cover-thumbs cover-photos"><p class="admin-hint">Loading…</p></div>
		</details>`;
}

// Cover chooser for one album: its photos are already on the page.
function coverPicker(kind, id, selectedIds, picks) {
	if (!picks.length) return '<p class="admin-hint cover-picker">Add photos to choose a cover.</p>';
	const multi = kind === 'home';
	const selected = new Set(selectedIds.filter(Boolean));
	if (!multi && !selected.size) selected.add(picks[0].id);
	const shown = picks.find(p => selected.has(p.id)) || picks[0];
	return `
		<details class="cover-picker" data-kind="${kind}" data-id="${id}">
			<summary><img src="${img(shown.key, 't')}" alt="">
				<span>${multi ? 'Cover photos' : 'Cover photo'}</span>
				${multi ? `<em class="cover-count">${selected.size} of ${HOME_COVERS}, one at random on each visit</em>` : ''}
				<small>Change</small></summary>
			<div class="cover-thumbs">
				${picks.map(p => thumbHtml(p, selected.has(p.id))).join('')}
			</div>
		</details>`;
}

// onAlbumCover: lets the album editor update its photo grid when the cover changes.
function bindCoverPickers(onAlbumCover) {
	app.querySelectorAll('.cover-picker').forEach(picker => {
		const select = picker.querySelector('.cover-album');
		const selected = () => new Set((picker.dataset.selected || '').split(',').filter(Boolean).map(Number));
		// Home: the chosen covers in their own row, so ones from other albums can be removed too.
		const drawChosen = () => {
			const row = picker.querySelector('.cover-chosen');
			if (row) row.innerHTML = S.homeCovers.map(p => thumbHtml(p, true)).join('');
		};
		const loadAlbum = () => run(async () => {
			const box = picker.querySelector('.cover-photos');
			box.innerHTML = '<p class="admin-hint">Loading…</p>';
			const { photos } = await api(`albums/${select.value}`);
			const ids = selected();
			box.innerHTML = photos.map(p => thumbHtml(p, ids.has(p.id))).join('');
		});
		if (select) {
			picker.addEventListener('toggle', () => {
				if (!picker.open || picker.dataset.loaded) return;
				picker.dataset.loaded = '1';
				drawChosen();
				loadAlbum();
			});
			select.onchange = loadAlbum;
		}
		picker.addEventListener('click', e => {
			const thumb = e.target.closest('.cover-thumb');
			if (!thumb) return;
			run(async () => {
				const photoId = Number(thumb.dataset.photo);
				const kind = picker.dataset.kind;
				const mark = ids => {
					picker.dataset.selected = [...ids].join(',');
					picker.querySelectorAll('.cover-photos .cover-thumb').forEach(b => b.classList.toggle('selected', ids.has(Number(b.dataset.photo))));
				};
				if (kind === 'home') {
					// Toggle in or out of the set; the summary shows the first chosen one.
					const ids = new Set(S.homeCovers.map(c => c.id));
					if (ids.has(photoId)) ids.delete(photoId);
					else if (ids.size >= HOME_COVERS) return toast(`Up to ${HOME_COVERS} cover photos. Remove one first.`);
					else ids.add(photoId);
					await api('home-covers', { method: 'PUT', body: { ids: [...ids] } });
					S.homeCovers = [...ids].map(pid => S.homeCovers.find(c => c.id === pid) || { id: pid, key: thumb.dataset.key });
					mark(ids);
					drawChosen();
					picker.querySelector('.cover-count').textContent = `${ids.size} of ${HOME_COVERS}, one at random on each visit`;
					if (S.homeCovers[0]) picker.querySelector('summary img').src = img(S.homeCovers[0].key, 't');
					return toast(ids.size ? 'Home covers saved' : 'No cover chosen: the first album\'s cover is used');
				}
				if (kind === 'folder') {
					await api(`folders/${picker.dataset.id}`, { method: 'PATCH', body: { cover_photo_id: photoId } });
					Object.assign(folderOf(Number(picker.dataset.id)), { cover_photo_id: photoId, cover_key: thumb.dataset.key });
					mark(new Set([photoId]));
					picker.querySelector('summary img').src = img(thumb.dataset.key, 't');
					return toast('Cover saved');
				} else {
					await api(`albums/${picker.dataset.id}`, { method: 'PATCH', body: { cover_photo_id: photoId } });
					onAlbumCover?.(photoId);
				}
				picker.querySelectorAll('.cover-thumb').forEach(b => b.classList.toggle('selected', b === thumb));
				picker.querySelector('summary img').src = img(thumb.dataset.key, 't');
				toast('Cover saved');
			});
		});
	});
}

// Quick look at a photo (display size) from the album editor; arrow keys move, Esc or a click closes.
function previewPhotos(photos, start) {
	let i = start;
	const el = document.createElement('div');
	el.className = 'modal preview';
	const show = () => {
		const p = photos[i];
		el.innerHTML = `
			<figure>
				<img src="${img(p.key, 'd')}" alt="">
				<figcaption>${esc(p.name)} · ${i + 1} / ${photos.length}</figcaption>
			</figure>
			<button type="button" class="preview-nav prev" data-step="-1" title="Previous">‹</button>
			<button type="button" class="preview-nav next" data-step="1" title="Next">›</button>`;
	};
	const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
	const step = d => { i = (i + d + photos.length) % photos.length; show(); };
	const onKey = e => {
		if (e.key === 'Escape') close();
		if (e.key === 'ArrowLeft') step(-1);
		if (e.key === 'ArrowRight') step(1);
	};
	el.addEventListener('click', e => {
		const nav = e.target.closest('[data-step]');
		if (nav) step(Number(nav.dataset.step));
		else close();
	});
	document.addEventListener('keydown', onKey);
	show();
	document.body.appendChild(el);
}

/* QR codes for links: the library loads only when one is asked for */

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = Object.assign(document.createElement('script'), { src });
		s.onload = resolve;
		s.onerror = () => reject(new Error('Could not load the QR code maker'));
		document.head.appendChild(s);
	});
}

async function makeQr(url) {
	if (!window.qrcode) await loadScript('/vendor/qrcode.js');
	const qr = qrcode(0, 'M');
	qr.addData(url);
	qr.make();
	return qr;
}

// A big QR code for printing or showing on a screen, with a PNG to save.
async function showQr(url, title) {
	const qr = await makeQr(url);
	const n = qr.getModuleCount();
	const cell = Math.ceil(1200 / n);
	const canvas = Object.assign(document.createElement('canvas'), { width: (n + 8) * cell, height: (n + 8) * cell });
	const g = canvas.getContext('2d');
	g.fillStyle = '#fff';
	g.fillRect(0, 0, canvas.width, canvas.height);
	g.fillStyle = '#000';
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
	const el = document.createElement('div');
	el.className = 'modal';
	el.innerHTML = `
		<div class="modal-box qr-box">
			<h2>${esc(title)}</h2>
			<div class="qr-code">${qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })}</div>
			<p class="qr-url">${esc(url)}</p>
			<div class="row-actions">
				<a class="btn-small" download="${esc(slugText(title))}-qr.png" href="${canvas.toDataURL('image/png')}">Save PNG</a>
				<button type="button" class="btn-small primary" data-close>Close</button>
			</div>
		</div>`;
	const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
	const onKey = e => { if (e.key === 'Escape') close(); };
	el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) close(); });
	document.addEventListener('keydown', onKey);
	document.body.appendChild(el);
}

const slugText = s => searchText(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gallery';

/* Trash: deleted photos and albums, restorable for S.trashDays days */

function trashHtml() {
	if (!S.trash.length) return '';
	const left = t => {
		const days = Math.ceil((t.deleted_at + S.trashDays * 86400000 - Date.now()) / 86400000);
		return days <= 1 ? 'removed within a day' : `${days} days left`;
	};
	const albums = S.trash.filter(t => t.kind === 'album');
	const photos = S.trash.filter(t => t.kind === 'photo');
	return `
		<h2 class="admin-h">Trash</h2>
		<p class="admin-hint">Deleted photos and albums stay here for ${S.trashDays} days, then they are removed for good.
			<button type="button" class="link-btn" data-trash-empty>Empty trash now</button></p>
		<ul class="folder-list" id="trash-list">
			${albums.map(t => `
				<li class="album-row trash-row" data-trash="${t.id}">
					<span class="album-thumb">${t.key ? `<img src="${img(t.key, 't')}" alt="">` : ''}</span>
					<div class="folder-info">
						<span class="folder-name">${esc(t.title)}</span>
						<span class="folder-meta">Album · ${plural(t.photos, 'photo')} · ${left(t)}</span>
					</div>
					<div class="row-actions">
						<button class="btn-small" data-restore>Restore</button>
						<button class="btn-small danger" data-purge>Delete now</button>
					</div>
				</li>`).join('')}
		</ul>
		${photos.length ? `
			<div class="trash-photos">
				${photos.map(t => `
					<figure data-trash="${t.id}" title="${esc(t.title)} · ${left(t)}">
						<img src="${img(t.key, 't')}" alt="" loading="lazy">
						<button class="btn-small" data-restore>Restore</button>
					</figure>`).join('')}
			</div>` : ''}`;
}

function bindTrash() {
	app.querySelectorAll('[data-trash] [data-restore]').forEach(btn => {
		btn.onclick = () => run(async () => {
			await api(`trash/${btn.closest('[data-trash]').dataset.trash}/restore`, { method: 'POST' });
			toast('Restored');
			await refresh();
		});
	});
	app.querySelectorAll('[data-trash] [data-purge]').forEach(btn => {
		btn.onclick = () => run(async () => {
			if (!confirm('Delete this album and its photos for good? This cannot be undone.')) return;
			await api(`trash/${btn.closest('[data-trash]').dataset.trash}`, { method: 'DELETE' });
			await refresh();
		});
	});
	const empty = app.querySelector('[data-trash-empty]');
	if (empty) empty.onclick = () => run(async () => {
		if (!confirm(`Remove everything in the trash (${plural(S.trash.length, 'item')}) for good? This cannot be undone.`)) return;
		await api('trash', { method: 'DELETE' });
		await refresh();
	});
}

// Copy link and QR code buttons next to a link field.
function bindLinks() {
	app.querySelectorAll('[data-copy]').forEach(btn => {
		btn.onclick = async () => {
			const field = btn.closest('.folder-row').querySelector('.link-field');
			try { await navigator.clipboard.writeText(field.value); } catch { field.select(); document.execCommand('copy'); }
			btn.textContent = 'Copied';
			setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
		};
	});

	app.querySelectorAll('[data-qr]').forEach(btn => {
		btn.onclick = () => run(() => showQr(btn.closest('.folder-row').querySelector('.link-field').value, btn.dataset.qr));
	});
}

/* Main page */

function renderMain() {
	document.title = 'Admin';
	const publicAlbums = S.albums.filter(a => !a.folder_id && !a.hidden);
	const today = new Date().toISOString().slice(0, 10);

	app.innerHTML = `
		${header()}
		<main class="admin">
			<h2 class="admin-h">Site name</h2>
			<p class="admin-hint">Shown on every cover, in the footer, the browser tab and link previews.</p>
			<form class="inline-form" id="site-name">
				<input class="field" id="site-name-value" value="${esc(S.photographer)}" maxlength="60" required>
				<button class="btn-small" type="submit">Save</button>
			</form>
			<p class="admin-hint" id="storage">${storageLine(S.storage)}</p>
			<label class="check"><input type="checkbox" id="strip-gps"${S.stripGps ? ' checked' : ''}>
				Remove GPS location from originals when uploading (JPEG)</label>
			<form class="inline-form" id="watermark">
				<input class="field" id="watermark-text" value="${esc(S.watermark)}" maxlength="60" placeholder="Watermark, e.g. © ${esc(S.photographer)}">
				<button class="btn-small" type="submit">Save</button>
			</form>
			<p class="admin-hint">Watermark: drawn on the display copy of photos uploaded from now on, not on thumbnails or originals. Leave empty for none.</p>
			<p class="admin-hint">Lost a phone or laptop that was logged in?
				<button type="button" class="link-btn" id="logout-all">Log out on all devices</button></p>

			<h2 class="admin-h">Public home page</h2>
			<div class="folder-row">
				<div class="folder-info">
					<span class="folder-name">Home</span>
					<span class="folder-meta">${plural(publicAlbums.length, 'album')}</span>
				</div>
				<input class="field link-field" readonly value="${esc(location.origin + '/')}">
				<div class="row-actions">
					<button class="btn-small" data-copy>Copy link</button>
					<button class="btn-small" data-qr="${esc(S.photographer)}">QR code</button>
					<a class="btn-small" href="/" target="_blank" rel="noopener">Open</a>
				</div>
				${coverChooser('home', 0, S.homeCovers.map(c => c.id), S.homeCovers[0]?.key, publicAlbums)}
			</div>

			<h2 class="admin-h">Albums</h2>
			<form class="inline-form" id="new-album">
				<input class="field" id="album-title" placeholder="New album title" maxlength="120" required>
				<input class="field" id="album-date" type="date" value="${today}">
				${whereSelect('album-where', 'hidden')}
				<button class="btn-small" type="submit">Create</button>
			</form>
			${S.albums.length ? `<input class="field list-search" id="albums-search" type="search" placeholder="Search albums" value="${esc(queries.albums)}">` : ''}
			<p class="admin-hint" id="albums-empty" hidden>No albums match.</p>
			${S.albums.length > 1 ? '<p class="admin-hint">Drag ⠿ to set the order albums appear in.</p>' : ''}
			<ul class="folder-list" id="albums-list">
				${S.albums.map(a => `
					<li class="album-row" data-id="${a.id}" data-search="${esc(searchText(`${a.title} ${a.date || ''} ${whereLabel(a)}`))}">
						${gripHtml}
						<a class="album-thumb" href="#album/${a.id}">${a.cover ? `<img src="${img(a.cover, 't')}" alt="">` : ''}</a>
						<div class="folder-info">
							<a class="folder-name" href="#album/${a.id}">${esc(a.title)}</a>
							<span class="folder-meta">${[
								a.date && esc(a.date),
								plural(a.count, 'photo'),
								esc(whereLabel(a)),
								plural(a.views, 'view'),
								plural(a.downloads, 'download'),
								a.downloads_off && 'downloads off',
							].filter(Boolean).join(' · ')}</span>
						</div>
						<div class="row-actions">
							<a class="btn-small" href="#album/${a.id}">Edit</a>
							<a class="btn-small" href="${albumUrl(a)}" target="_blank" rel="noopener">Open</a>
						</div>
					</li>`).join('') || '<li class="admin-hint">No albums yet.</li>'}
			</ul>

			<h2 class="admin-h">Private folders</h2>
			<p class="admin-hint">People you share a folder with see its name on the cover, so name it for them. Anyone with a folder link can open it, unless you set a password. Photos go into albums: edit a folder and use + New album, or move an existing album in from its settings.</p>
			${S.folders.length ? `<input class="field list-search" id="folders-search" type="search" placeholder="Search folders or their albums" value="${esc(queries.folders)}">` : ''}
			<p class="admin-hint" id="folders-empty" hidden>No folders match.</p>
			<ul class="folder-list" id="folders-list">
				${S.folders.map(f => {
					const albums = S.albums.filter(a => a.folder_id === f.id);
					const cover = f.cover_key || albums.find(a => a.cover)?.cover;
					return `
					<li class="album-row no-grip" data-search="${esc(searchText([f.title, ...albums.map(a => a.title)].join(' ')))}">
						<a class="album-thumb" href="#folder/${f.id}">${cover ? `<img src="${img(cover, 't')}" alt="">` : ''}</a>
						<div class="folder-info">
							<a class="folder-name" href="#folder/${f.id}">${ICON.folder}${esc(f.title)}</a>
							<span class="folder-meta">${folderMeta(f, albums)}</span>
						</div>
						<div class="row-actions">
							<a class="btn-small" href="#folder/${f.id}">Edit</a>
							<a class="btn-small" href="/f/${f.token}" target="_blank" rel="noopener">Open</a>
						</div>
					</li>`;
				}).join('') || '<li class="admin-hint">No folders yet.</li>'}
			</ul>
			<form class="inline-form" id="new-folder">
				<input class="field" id="folder-title" placeholder="New folder, e.g. a name or an event" maxlength="120" required>
				<button class="btn-small" type="submit">Create folder</button>
			</form>

			${trashHtml()}
		</main>`;

	bindHeader();
	bindCoverPickers();

	bindLinks();
	bindSearch('albums');
	bindSearch('folders');
	bindTrash();

	const albumsList = document.getElementById('albums-list');
	makeSortable(albumsList, ids => run(async () => {
		await api('albums/order', { method: 'PUT', body: { ids } });
		ids.forEach((albumId, i) => { S.albums.find(a => a.id === albumId).sort = i + 1; });
		S.albums.sort((x, y) => x.sort - y.sort);
		toast('Order saved');
	}));

	document.getElementById('strip-gps').onchange = e => run(async () => {
		await api('strip-gps', { method: 'PUT', body: { on: e.target.checked } });
		S.stripGps = e.target.checked;
		toast('Saved');
	});

	document.getElementById('new-album').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			const { id } = await api('albums', {
				method: 'POST',
				body: {
					title: document.getElementById('album-title').value,
					date: document.getElementById('album-date').value,
					...parseWhere(document.getElementById('album-where').value),
				},
			});
			S = await api('state');
			location.hash = `album/${id}`;
		});
	});

	document.getElementById('storage').addEventListener('click', e => {
		const btn = e.target.closest('#recount');
		if (!btn) return;
		btn.disabled = true;
		btn.textContent = 'Counting…';
		run(async () => {
			S.storage = await api('storage', { method: 'POST' });
			document.getElementById('storage').innerHTML = storageLine(S.storage);
			if (S.storage.removed) toast(`Removed ${plural(S.storage.removed, 'file')} left over from unfinished uploads`);
		}).finally(() => {
			if (btn.isConnected) {
				btn.disabled = false;
				btn.textContent = 'Recount';
			}
		});
	});

	document.getElementById('watermark').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			const text = document.getElementById('watermark-text').value.trim();
			await api('watermark', { method: 'PUT', body: { text } });
			S.watermark = text;
			toast(text ? 'Watermark saved, used for new uploads' : 'Watermark off');
		});
	});

	document.getElementById('logout-all').onclick = () => run(async () => {
		if (!confirm('Log out on every device, including this one?')) return;
		await api('logout-all', { method: 'POST' });
		renderLogin();
	});

	document.getElementById('site-name').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			const name = document.getElementById('site-name-value').value;
			await api('site-name', { method: 'PUT', body: { name } });
			S.photographer = name.trim();
			toast('Saved');
		});
	});

	document.getElementById('new-folder').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			const { id } = await api('folders', { method: 'POST', body: { title: document.getElementById('folder-title').value } });
			location.hash = `folder/${id}`; // straight to its link and settings
		});
	});
}

/* Folder editor */

function renderFolder(id) {
	const f = folderOf(id);
	if (!f) { location.hash = ''; return; }
	const albums = S.albums.filter(a => a.folder_id === id);
	document.title = `${f.title} · Admin`;

	app.innerHTML = `
		${header()}
		<main class="admin">
			<p><a class="btn-small" href="#">← All folders</a></p>

			<h2 class="admin-h">Folder</h2>
			<div class="album-cover">${coverChooser('folder', id, [f.cover_photo_id], f.cover_key, albums)}</div>
			<form class="album-form" id="folder-form">
				<label class="label" for="title">Name <small>(people you share it with see it on the cover)</small></label>
				<input class="field" id="title" value="${esc(f.title)}" maxlength="120" required>
				<div class="row-actions"><button class="btn-small" type="submit">Save name</button></div>
			</form>

			<h2 class="admin-h">Link <span class="folder-meta">${folderMeta(f, albums)}</span></h2>
			<div class="folder-row link-row">
				<input class="field link-field" readonly value="${esc(`${location.origin}/f/${f.token}`)}">
				<div class="row-actions">
					<button class="btn-small" data-copy>Copy link</button>
					<button class="btn-small" data-qr="${esc(f.title)}">QR code</button>
					<a class="btn-small" href="/f/${f.token}" target="_blank" rel="noopener">Open folder</a>
					<button class="btn-small" data-act="relink" title="The old link stops working">New link</button>
				</div>
				<div class="folder-settings">
					<span class="setting">Password: <b>${f.has_password ? 'on' : 'off'}</b>
						<button type="button" class="link-btn" data-act="password">${f.has_password ? 'Change' : 'Set'}</button>
						${f.has_password ? '<button type="button" class="link-btn" data-act="nopassword">Remove</button>' : ''}</span>
					<label class="setting">Link works until
						<input class="field date-field" type="date" data-setting="expires_at" value="${esc(f.expires_at || '')}">
						${f.expires_at ? '<button type="button" class="link-btn" data-act="noexpiry">No expiry</button>' : ''}</label>
					<label class="setting" title="Off hides the buttons and blocks the full-size originals; photos on screen can still be saved"><input type="checkbox" data-setting="downloads"${f.downloads_off ? '' : ' checked'}> Allow downloads</label>
				</div>
				<form class="password-form" id="password-form" hidden>
					<input class="field" type="password" id="new-password" minlength="4" maxlength="100" autocomplete="new-password"
						placeholder="New password, at least 4 characters" aria-label="New password" required>
					<label class="check"><input type="checkbox" id="show-password"> Show</label>
					<button class="btn-small" type="submit">Save password</button>
					<button class="btn-small" type="button" id="password-cancel">Cancel</button>
				</form>
				${f.favorites ? `<details class="favorites" id="favorites">
					<summary>${ICON.heart} ${plural(f.favorites, 'photo')} picked as favourites <small>Show</small></summary>
					<div class="fav-list">Loading…</div>
				</details>` : ''}
			</div>

			<h2 class="admin-h">Albums <span class="folder-meta">${plural(albums.length, 'album')}</span></h2>
			<form class="inline-form" id="new-album">
				<input class="field" id="album-title" placeholder="New album in this folder" maxlength="120" required>
				<button class="btn-small" type="submit">+ New album</button>
			</form>
			<ul class="folder-list">
				${albums.map(a => `
					<li class="album-row no-grip">
						<a class="album-thumb" href="#album/${a.id}">${a.cover ? `<img src="${img(a.cover, 't')}" alt="">` : ''}</a>
						<div class="folder-info">
							<a class="folder-name" href="#album/${a.id}">${esc(a.title)}</a>
							<span class="folder-meta">${[a.date && esc(a.date), plural(a.count, 'photo'), plural(a.views, 'view'), plural(a.downloads, 'download'), a.downloads_off && 'downloads off'].filter(Boolean).join(' · ')}</span>
						</div>
						<div class="row-actions">
							<a class="btn-small" href="#album/${a.id}">Edit</a>
							<a class="btn-small" href="${albumUrl(a)}" target="_blank" rel="noopener">Open</a>
						</div>
					</li>`).join('') || '<li class="admin-hint">No albums yet. Add one, then upload photos into it. Existing albums move in from their own settings (Shown on).</li>'}
			</ul>

			<h2 class="admin-h">Danger zone</h2>
			<button class="btn-small danger" data-act="delete">Delete folder</button>
			<p class="admin-hint">Its albums and photos are kept: they become hidden albums.</p>
		</main>`;

	bindHeader();
	bindCoverPickers();
	bindLinks();

	document.getElementById('folder-form').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			await api(`folders/${id}`, { method: 'PATCH', body: { title: document.getElementById('title').value } });
			toast('Saved');
			await refresh();
		});
	});

	document.getElementById('new-album').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			const { id: albumId } = await api('albums', {
				method: 'POST',
				body: { title: document.getElementById('album-title').value, date: new Date().toISOString().slice(0, 10), folder_id: id, hidden: false },
			});
			S = await api('state');
			location.hash = `album/${albumId}`; // straight to the upload area
		});
	});

	app.querySelectorAll('[data-act]').forEach(btn => {
		btn.onclick = () => run(async () => {
			const act = btn.dataset.act;
			if (act === 'relink') {
				if (!confirm(`Make a new link for "${f.title}"? The old link stops working.`)) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { relink: true } });
			}
			if (act === 'delete') {
				if (!confirm(`Delete folder "${f.title}"? Its albums become hidden (not deleted).`)) return;
				await api(`folders/${id}`, { method: 'DELETE' });
				location.hash = '';
				return;
			}
			if (act === 'password') {
				pwForm.hidden = false;
				pwInput.focus();
				return;
			}
			if (act === 'nopassword') {
				if (!confirm(`Remove the password? Anyone with the link can open "${f.title}" again.`)) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { password: null } });
			}
			if (act === 'noexpiry') await api(`folders/${id}`, { method: 'PATCH', body: { expires_at: null } });
			await refresh();
		});
	});

	const pwForm = document.getElementById('password-form');
	const pwInput = document.getElementById('new-password');
	document.getElementById('show-password').onchange = e => { pwInput.type = e.target.checked ? 'text' : 'password'; };
	document.getElementById('password-cancel').onclick = () => { pwForm.hidden = true; pwInput.value = ''; };
	pwForm.onsubmit = e => {
		e.preventDefault();
		run(async () => {
			if (f.has_password && !confirm(`Change the password of "${f.title}"? Anyone who opened it with the old one must enter the new one.`)) return;
			await api(`folders/${id}`, { method: 'PATCH', body: { password: pwInput.value } });
			toast('Password set');
			await refresh();
		});
	};

	// Expiry date and the downloads switch save as soon as they change.
	app.querySelectorAll('[data-setting]').forEach(input => {
		input.onchange = () => run(async () => {
			const body = input.dataset.setting === 'downloads'
				? { downloads_off: !input.checked }
				: { expires_at: input.value || null };
			await api(`folders/${id}`, { method: 'PATCH', body });
			await refresh();
			toast('Saved');
		});
	});

	// Favourites load when opened: thumbnails with who picked them, and the file names to copy for editing.
	const box = document.getElementById('favorites');
	box?.addEventListener('toggle', () => {
		if (!box.open || box.dataset.loaded) return;
		box.dataset.loaded = '1';
		run(async () => {
			const { photos } = await api(`folders/${id}/favorites`);
			box.querySelector('.fav-list').innerHTML = `
				<div class="fav-grid">
					${photos.map(p => `
						<figure>
							<img src="${img(p.key, 't')}" alt="" loading="lazy">
							<figcaption>${esc(p.name)}<br><small>${esc(p.album)} · ${esc(p.clients)}</small></figcaption>
						</figure>`).join('')}
				</div>
				<button type="button" class="btn-small" data-copy-names>Copy file names</button>`;
			box.querySelector('[data-copy-names]').onclick = async e => {
				const names = photos.map(p => p.name).join('\n');
				try { await navigator.clipboard.writeText(names); e.target.textContent = 'Copied'; } catch { prompt('File names', names); }
			};
		});
	});
}

/* Album editor */

async function renderAlbum(id) {
	const { album: a, photos } = await api(`albums/${id}`);
	document.title = `${a.title} · Admin`;

	app.innerHTML = `
		${header()}
		<main class="admin">
			<p><a class="btn-small" href="${a.folder_id ? `#folder/${a.folder_id}` : '#'}" id="back">← ${folderOf(a.folder_id) ? `Folder: ${esc(folderOf(a.folder_id).title)}` : 'All albums'}</a></p>

			<h2 class="admin-h">Album</h2>
			<div class="album-cover" id="album-cover"></div>
			<form class="album-form" id="album-form">
				<label class="label" for="title">Title</label>
				<input class="field" id="title" value="${esc(a.title)}" maxlength="120" required>
				<label class="label" for="date">Date</label>
				<input class="field" id="date" type="date" value="${esc(a.date || '')}">
				<label class="label" for="where">Shown on</label>
				${whereSelect('where', whereValue(a))}
				<label class="check"><input type="checkbox" id="downloads"${a.downloads_off ? '' : ' checked'}> Allow downloads
					<small>(off hides the buttons and blocks the full-size original and its zoom; photos on screen can still be saved)</small></label>
				${folderOf(a.folder_id)?.downloads_off ? `<p class="admin-hint">Downloads are off for its folder "${esc(folderOf(a.folder_id).title)}", which blocks them here too.</p>` : ''}
				<div class="row-actions">
					<button class="btn-small" type="submit">Save details</button>
					<a class="btn-small" href="${albumUrl(a)}" target="_blank" rel="noopener">Open album</a>
				</div>
			</form>

			<h2 class="admin-h">Photos <span class="folder-meta" id="count">${plural(photos.length, 'photo')}</span></h2>
			<label class="dropzone" id="dropzone">
				<input type="file" id="files" multiple accept="image/jpeg,image/png,image/webp">
				<span>Drop photos here or click to choose</span>
				<small id="progress">JPEG, PNG or WebP. Originals are kept for download.</small>
			</label>
			<p class="admin-hint">Cover, order and deletions save at once. Drag ⠿ to reorder. The same photo is never added twice.
				<button type="button" class="link-btn" id="sort-taken">Sort by date taken</button> ·
				<button type="button" class="link-btn" id="select-mode">Select photos</button></p>
			<div class="select-bar" id="select-bar" hidden>
				<span id="select-count">Tap photos to select</span>
				<button type="button" class="link-btn" id="select-all">Select all</button>
				<select class="field" id="move-to">
					<option value="">Move to album…</option>
					${S.albums.filter(x => x.id !== id).map(x => `<option value="${x.id}">${esc(x.title)} (${esc(whereLabel(x))})</option>`).join('')}
				</select>
				<button type="button" class="btn-small" id="move-selected">Move</button>
				<button type="button" class="btn-small danger" id="delete-selected">Delete</button>
				<button type="button" class="btn-small primary" id="select-done">Done</button>
			</div>
			<div class="photo-grid" id="photos"></div>

			<h2 class="admin-h">Danger zone</h2>
			<button class="btn-small danger" id="delete-album">Delete album and all its photos</button>
			<p class="admin-hint">Deleted photos and albums go to the trash on the main page for ${S.trashDays} days.</p>
		</main>`;

	bindHeader();
	// Back from an album in a folder goes to that folder's page (as now chosen in Shown on).
	document.getElementById('back').onclick = e => {
		e.preventDefault();
		const { folder_id } = parseWhere(document.getElementById('where').value);
		location.hash = folder_id ? `folder/${folder_id}` : '';
	};
	const grid = document.getElementById('photos');
	let coverId = a.cover_photo_id || photos[0]?.id;

	const cell = p => `
		<div class="photo-cell${p.id === coverId ? ' selected' : ''}" data-id="${p.id}">
			<img src="${img(p.key, 't')}" alt="" loading="lazy">
			${gripHtml}
			<span class="cover-badge">✓ Cover</span>
			<div class="photo-actions">
				<button class="btn-small" data-open>Open</button>
				<button class="btn-small danger" data-delete>Delete</button>
			</div>
		</div>`;
	grid.innerHTML = photos.map(cell).join('');

	// Photos in the order shown in the grid (after drags, uploads and deletions).
	const inOrder = () => [...grid.children].map(el => photos.find(p => p.id === Number(el.dataset.id))).filter(Boolean);

	// Cover chooser at the top, same as on the home page and folders; redrawn when photos change.
	const setCover = photoId => {
		coverId = photoId;
		grid.querySelectorAll('.photo-cell').forEach(x => x.classList.toggle('selected', Number(x.dataset.id) === photoId));
	};
	const drawCoverRow = () => {
		document.getElementById('album-cover').innerHTML = coverPicker('album', id, [coverId], inOrder());
		bindCoverPickers(setCover);
	};
	drawCoverRow();
	const updateCount = () => { document.getElementById('count').textContent = plural(grid.children.length, 'photo'); };

	const saveOrder = ids => api(`albums/${id}/order`, { method: 'PUT', body: { ids } });
	makeSortable(grid, ids => run(async () => {
		await saveOrder(ids);
		drawCoverRow();
		toast('Order saved');
	}));

	// Oldest first by EXIF date taken; photos without a date keep their order at the end.
	document.getElementById('sort-taken').onclick = () => run(async () => {
		const byId = new Map(photos.map(p => [p.id, p]));
		const current = [...grid.children].map(el => Number(el.dataset.id));
		const dated = current.filter(pid => byId.get(pid)?.taken_at);
		if (!dated.length) return toast('No dates found. Dates are read from JPEG photos uploaded from now on.');
		if (!confirm('Sort the photos by date taken? This replaces the current order.')) return;
		dated.sort((x, y) => byId.get(x).taken_at.localeCompare(byId.get(y).taken_at));
		const ids = [...dated, ...current.filter(pid => !byId.get(pid)?.taken_at)];
		await saveOrder(ids);
		ids.forEach(pid => grid.appendChild(grid.querySelector(`[data-id="${pid}"]`)));
		drawCoverRow();
		toast('Sorted by date taken');
	});

	// Takes photos off this page after a delete or a move.
	const dropPhotos = ids => {
		for (const pid of ids) {
			grid.querySelector(`[data-id="${pid}"]`)?.remove();
			const i = photos.findIndex(p => p.id === pid);
			if (i >= 0) photos.splice(i, 1);
		}
		// Without a chosen cover the album uses its first photo, as the server does.
		if (ids.includes(coverId)) setCover(inOrder()[0]?.id);
		drawCoverRow();
		updateCount();
	};

	// Select mode: taps pick photos instead of opening them, for moving or deleting many at once.
	const bar = document.getElementById('select-bar');
	const picked = () => [...grid.querySelectorAll('.photo-cell.picked')].map(el => Number(el.dataset.id));
	const showPicked = () => {
		const n = picked().length;
		document.getElementById('select-count').textContent = n ? `${plural(n, 'photo')} selected` : 'Tap photos to select';
	};
	const selectMode = on => {
		grid.classList.toggle('selecting', on);
		bar.hidden = !on;
		if (!on) grid.querySelectorAll('.picked').forEach(el => el.classList.remove('picked'));
		showPicked();
	};
	document.getElementById('select-mode').onclick = () => selectMode(true);
	document.getElementById('select-done').onclick = () => selectMode(false);
	document.getElementById('select-all').onclick = () => {
		grid.querySelectorAll('.photo-cell').forEach(el => el.classList.add('picked'));
		showPicked();
	};
	document.getElementById('delete-selected').onclick = () => run(async () => {
		const ids = picked();
		if (!ids.length) return toast('Select photos first');
		if (!confirm(`Delete ${plural(ids.length, 'photo')}? They stay in the trash for ${S.trashDays} days.`)) return;
		await api('photos/delete', { method: 'POST', body: { ids } });
		dropPhotos(ids);
		showPicked();
		toast(`${plural(ids.length, 'photo')} moved to the trash`);
	});
	document.getElementById('move-selected').onclick = () => run(async () => {
		const ids = picked();
		const target = Number(document.getElementById('move-to').value);
		if (!ids.length) return toast('Select photos first');
		if (!target) return toast('Choose the album to move them to');
		const name = S.albums.find(x => x.id === target)?.title || 'the album';
		await api('photos/move', { method: 'POST', body: { ids: inOrder().map(p => p.id).filter(pid => ids.includes(pid)), album_id: target } });
		dropPhotos(ids);
		showPicked();
		toast(`${plural(ids.length, 'photo')} moved to "${name}"`);
	});

	grid.addEventListener('click', e => {
		const c = e.target.closest('.photo-cell');
		if (!c) return;
		const photoId = Number(c.dataset.id);
		if (grid.classList.contains('selecting')) {
			if (e.target.closest('.drag-handle')) return;
			c.classList.toggle('picked');
			return showPicked();
		}
		if (e.target.closest('[data-open]')) {
			const list = inOrder();
			previewPhotos(list, list.findIndex(p => p.id === photoId));
		}
		// One photo goes to the trash without asking: it can be restored from the main page.
		if (e.target.closest('[data-delete]')) run(async () => {
			await api('photos/delete', { method: 'POST', body: { ids: [photoId] } });
			dropPhotos([photoId]);
			toast('Moved to the trash');
		});
	});

	document.getElementById('album-form').addEventListener('submit', e => {
		e.preventDefault();
		run(async () => {
			await api(`albums/${id}`, {
				method: 'PATCH',
				body: {
					title: document.getElementById('title').value,
					date: document.getElementById('date').value,
					downloads_off: !document.getElementById('downloads').checked,
					...parseWhere(document.getElementById('where').value),
				},
			});
			S = await api('state');
			toast('Saved');
		});
	});

	document.getElementById('delete-album').onclick = () => run(async () => {
		if (!confirm(`Delete "${a.title}" and all ${grid.children.length} photos? You can restore it from the trash for ${S.trashDays} days.`)) return;
		await api(`albums/${id}`, { method: 'DELETE' });
		S = await api('state');
		location.hash = '';
	});

	const zone = document.getElementById('dropzone');
	const input = document.getElementById('files');
	input.onchange = () => upload([...input.files]);
	zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
	zone.addEventListener('dragleave', () => zone.classList.remove('over'));
	zone.addEventListener('drop', e => {
		e.preventDefault();
		zone.classList.remove('over');
		upload([...e.dataTransfer.files]);
	});

	// Uploads run 3 at a time and keep going if the admin opens another page of the admin; only this page's grid
	// is updated, and only while it is still on screen. Photos end up in the order the files were chosen.
	// The same file twice (already in the album, or chosen twice) is skipped.
	const PARALLEL = 3;
	let busy = false;
	async function upload(files) {
		files = files.filter(f => PHOTO_TYPES.test(f.type));
		if (!files.length) return toast('Choose JPEG, PNG or WebP photos');
		if (busy) {
			input.value = '';
			return toast('Wait for the current upload to finish, then add these');
		}
		busy = true;
		uploading++;
		const progress = document.getElementById('progress');
		const here = () => grid.isConnected;
		const added = new Array(files.length); // by file position
		const finishOrder = [];
		const failed = [];
		const seen = new Set(photos.map(p => p.hash).filter(Boolean));
		let skipped = 0;
		let next = 0;
		let stopped = false;
		const status = () => {
			const done = finishOrder.length + failed.length + skipped;
			progress.textContent = `Uploading ${Math.min(done + 1, files.length)} / ${files.length}` + (skipped ? ` · ${skipped} already in the album` : '');
		};
		const worker = async () => {
			while (!stopped && next < files.length) {
				const i = next++;
				status();
				try {
					const p = await uploadOne(id, files[i], seen, photos);
					if (!p) { skipped++; continue; }
					added[i] = p;
					finishOrder.push(p.id);
					photos.push(p);
					if (!coverId) coverId = p.id;
					if (here()) {
						grid.insertAdjacentHTML('beforeend', cell(p));
						updateCount();
					}
				} catch (e) {
					if (e instanceof LoginNeeded) { stopped = true; return; }
					failed.push(`${files[i].name} (${e.message})`);
				}
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
			// Parallel uploads finish in any order: put them back in the order the files were chosen, after the
			// photos as they are now (including any drag made meanwhile). The server writes only rows that moved.
			const wanted = added.filter(Boolean).map(p => p.id);
			if (!stopped && wanted.join() !== finishOrder.join()) {
				await saveOrder([...inOrder().map(p => p.id).filter(pid => !wanted.includes(pid)), ...wanted]);
				if (here()) wanted.forEach(pid => grid.appendChild(grid.querySelector(`[data-id="${pid}"]`)));
			}
		} finally {
			busy = false;
			uploading--;
		}
		if (stopped) return;
		const parts = [`${plural(finishOrder.length, 'photo')} uploaded`];
		if (skipped) parts.push(`${skipped} skipped, already in the album`);
		if (failed.length) parts.push(`failed: ${failed.join(', ')}`);
		const summary = `Done. ${parts.join('. ')}.`;
		if (!here()) return toast(`"${a.title}": ${summary}`);
		input.value = '';
		progress.textContent = summary;
		drawCoverRow();
	}
}

// Photo formats the server accepts (it refuses SVG and other non-photo images).
const PHOTO_TYPES = /^image\/(jpeg|png|webp|avif|gif|heic|heif)$/;

// Uploads in progress, so closing or reloading the tab asks first.
let uploading = 0;
window.addEventListener('beforeunload', e => {
	if (!uploading) return;
	e.preventDefault();
	e.returnValue = '';
});

/* Browser-side resizing: the server only stores files. */

async function resize(bitmap, maxEdge, quality, watermark = '') {
	let source = bitmap;
	let w = bitmap.width;
	let h = bitmap.height;
	const scale = Math.min(1, maxEdge / Math.max(w, h));
	const tw = Math.round(w * scale);
	const th = Math.round(h * scale);
	// Halve in steps first, one big jump looks soft.
	while (w / 2 > tw) {
		w = Math.round(w / 2);
		h = Math.round(h / 2);
		const step = document.createElement('canvas');
		step.width = w;
		step.height = h;
		step.getContext('2d').drawImage(source, 0, 0, w, h);
		source = step;
	}
	const canvas = document.createElement('canvas');
	canvas.width = tw;
	canvas.height = th;
	const g = canvas.getContext('2d');
	g.imageSmoothingQuality = 'high';
	g.drawImage(source, 0, 0, tw, th);
	if (watermark) await drawWatermark(canvas, watermark);
	return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not resize'))), 'image/jpeg', quality));
}

// Each file goes in its own request with the raw bytes as body, so the server streams it to storage.
async function putFile(key, size, blob, name) {
	const headers = { 'x-admin': '1', 'content-type': blob.type || 'image/jpeg' };
	if (name) headers['x-name'] = encodeURIComponent(name);
	const res = await fetch(`/api/admin/upload/${key}/${size}`, { method: 'PUT', headers, body: blob });
	if (res.status === 401) {
		renderLogin();
		throw new LoginNeeded();
	}
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
}

// Fingerprint of the file exactly as chosen (before GPS removal), so the same photo is recognised again.
async function sha256Hex(buf) {
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Watermark text in the lower right corner of a display copy, sized to the photo.
async function drawWatermark(canvas, text) {
	const g = canvas.getContext('2d');
	const size = Math.max(14, Math.round(Math.min(canvas.width, canvas.height) * 0.032));
	await document.fonts.load(`500 ${size}px Montserrat`).catch(() => {});
	g.font = `500 ${size}px Montserrat, sans-serif`;
	g.textAlign = 'right';
	g.textBaseline = 'bottom';
	g.shadowColor = 'rgba(0, 0, 0, .45)';
	g.shadowBlur = size / 3;
	g.fillStyle = 'rgba(255, 255, 255, .78)';
	g.fillText(text, canvas.width - size, canvas.height - size * 0.8);
}

// Uploads one photo; returns null when the same file is already in the album.
// seen: fingerprints in the album and earlier in this batch; photos: the album's photos (older ones have no fingerprint).
async function uploadOne(albumId, file, seen, photos) {
	const buf = await file.arrayBuffer();
	const hash = await sha256Hex(buf);
	if (seen.has(hash)) return null;
	seen.add(hash);

	let bitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		seen.delete(hash);
		throw new Error('this browser cannot read the file');
	}
	const { width: w, height: h } = bitmap;
	// Photos uploaded before fingerprints existed: same file name and size counts as the same photo.
	if (photos.some(p => !p.hash && p.name === file.name && p.w === w && p.h === h)) {
		bitmap.close();
		return null;
	}
	const display = await resize(bitmap, 2400, 0.86, S.watermark);
	const thumb = await resize(bitmap, 900, 0.82);
	bitmap.close();

	// JPEG originals: read the date taken (for "Sort by date taken") and, if the setting is on, remove the location.
	let original = file;
	let taken = null;
	if (file.type === 'image/jpeg') {
		try {
			taken = readExif(buf)?.taken || null;
			if (S.stripGps) {
				stripGps(buf);
				original = new Blob([buf], { type: file.type });
			}
		} catch {
			// Unusual metadata layout: upload unchanged rather than risk a broken file.
		}
	}

	// The server checks the fingerprint too (another tab or device may have added the photo meanwhile).
	let key;
	try {
		({ key } = await api(`albums/${albumId}/photos`, { method: 'POST', body: { hash } }));
	} catch (e) {
		if (e.data?.duplicate) return null;
		throw e;
	}
	await putFile(key, 't', thumb);
	await putFile(key, 'd', display);
	await putFile(key, 'o', original, file.name);
	return api(`albums/${albumId}/photos/${key}`, { method: 'POST', body: { w, h, taken_at: taken, hash } });
}

/* Routing */

async function refresh() {
	S = await api('state');
	route();
}

// The main list always reloads its data, so covers, counts and photos changed in an album editor show at once.
let fresh = false; // set by start(), which has just loaded the state
let shownHash = null;
function route() {
	const m = location.hash.match(/^#album\/(\d+)$/);
	const folder = location.hash.match(/^#folder\/(\d+)$/);
	const justLoaded = fresh;
	fresh = false;
	// A new page starts at the top; a refresh of the same page keeps its place.
	const scrollTop = location.hash !== shownHash;
	shownHash = location.hash;
	run(async () => {
		if (m) await renderAlbum(Number(m[1]));
		else {
			if (!justLoaded) S = await api('state');
			if (folder) renderFolder(Number(folder[1]));
			else renderMain();
		}
		if (scrollTop) window.scrollTo(0, 0);
	});
}

async function start() {
	try {
		S = await api('state');
	} catch (e) {
		if (!(e instanceof LoginNeeded)) toast(e.message);
		return;
	}
	fresh = true;
	window.onhashchange = route;
	route();
}

start();
