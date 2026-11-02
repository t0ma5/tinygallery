// Admin panel: login, albums and uploads, private folders, cover photos.
const app = document.getElementById('app');
let S = null; // state from /api/admin/state

const ICON = {
	folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6.5h6l2 2h10V19H3z"/></svg>',
	chevron: '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 9l6 6 6-6"/></svg>',
	grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

ICON.heart = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';

// One line under a folder name: albums, views, favourites, password and expiry at a glance.
function folderMeta(f, albums) {
	const today = new Date().toISOString().slice(0, 10);
	return [
		plural(albums.length, 'album'),
		plural(f.views, 'view'),
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

// Private folders start collapsed; the ones opened stay open while the admin page is open.
const openFolders = new Set();
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
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

// Drops repeated photos (by id), keeping the first: chosen covers first, then the albums' photos.
const uniquePhotos = list => [...new Map(list.map(p => [p.id, p])).values()];

// Cover chooser: kind 'home' (several), 'folder' or 'album' (one). Every pick saves at once.
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
				${picks.map(p => `
					<button type="button" class="cover-thumb${selected.has(p.id) ? ' selected' : ''}" data-photo="${p.id}" data-key="${p.key}">
						<img src="${img(p.key, 't')}" alt="" loading="lazy">
					</button>`).join('')}
			</div>
		</details>`;
}

// onAlbumCover: lets the album editor update its photo grid when the cover changes.
function bindCoverPickers(onAlbumCover) {
	app.querySelectorAll('.cover-picker').forEach(picker => {
		picker.addEventListener('click', e => {
			const thumb = e.target.closest('.cover-thumb');
			if (!thumb) return;
			run(async () => {
				const photoId = Number(thumb.dataset.photo);
				const kind = picker.dataset.kind;
				if (kind === 'home') {
					// Toggle in or out of the set; the summary shows the first chosen one.
					const ids = new Set(S.homeCovers.map(c => c.id));
					if (ids.has(photoId)) ids.delete(photoId);
					else if (ids.size >= HOME_COVERS) return toast(`Up to ${HOME_COVERS} cover photos. Remove one first.`);
					else ids.add(photoId);
					await api('home-covers', { method: 'PUT', body: { ids: [...ids] } });
					S.homeCovers = [...ids].map(pid => S.homeCovers.find(c => c.id === pid) || { id: pid, key: thumb.dataset.key });
					thumb.classList.toggle('selected', ids.has(photoId));
					picker.querySelector('.cover-count').textContent = `${ids.size} of ${HOME_COVERS}, one at random on each visit`;
					const first = picker.querySelector('.cover-thumb.selected') || picker.querySelector('.cover-thumb');
					picker.querySelector('summary img').src = img(first.dataset.key, 't');
					return toast(ids.size ? 'Home covers saved' : 'No cover chosen: the first album\'s cover is used');
				}
				if (kind === 'folder') {
					await api(`folders/${picker.dataset.id}`, { method: 'PATCH', body: { cover_photo_id: photoId } });
					folderOf(Number(picker.dataset.id)).cover_photo_id = photoId;
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
					<a class="btn-small" href="/" target="_blank" rel="noopener">Open</a>
				</div>
				${coverPicker('home', 0, S.homeCovers.map(c => c.id), uniquePhotos([...S.homeCovers, ...publicAlbums.flatMap(a => a.picks)]))}
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
			<p class="admin-hint">People you share a folder with see its name on the cover, so name it for them. Anyone with a folder link can open it, unless you set a password. Put albums in a folder from the album's settings.</p>
			${S.folders.length ? `<input class="field list-search" id="folders-search" type="search" placeholder="Search folders or their albums" value="${esc(queries.folders)}">` : ''}
			<p class="admin-hint" id="folders-empty" hidden>No folders match.</p>
			<ul class="folder-list" id="folders-list">
				${S.folders.map(f => {
					const albums = S.albums.filter(a => a.folder_id === f.id);
					const open = openFolders.has(f.id);
					return `
					<li class="folder-item" data-folder="${f.id}" data-search="${esc(searchText([f.title, ...albums.map(a => a.title)].join(' ')))}">
						<button type="button" class="folder-toggle" aria-expanded="${open}">
							<span class="folder-info">
								<span class="folder-name">${ICON.folder}${esc(f.title)}</span>
								<span class="folder-meta">${folderMeta(f, albums)}</span>
							</span>
							${ICON.chevron}
						</button>
						<div class="folder-row folder-body"${open ? '' : ' hidden'}>
						<input class="field link-field" readonly value="${esc(`${location.origin}/f/${f.token}`)}">
						<div class="row-actions">
							<button class="btn-small" data-copy>Copy link</button>
							<a class="btn-small" href="/f/${f.token}" target="_blank" rel="noopener">Open</a>
							<button class="btn-small" data-act="rename">Rename</button>
							<button class="btn-small" data-act="relink" title="The old link stops working">New link</button>
							<button class="btn-small danger" data-act="delete">Delete</button>
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
						${f.favorites ? `<details class="favorites" data-favorites="${f.id}">
							<summary>${ICON.heart} ${plural(f.favorites, 'photo')} picked as favourites <small>Show</small></summary>
							<div class="fav-list">Loading…</div>
						</details>` : ''}
						${coverPicker('folder', f.id, [f.cover_photo_id], albums.flatMap(a => a.picks))}
						</div>
					</li>`;
				}).join('')}
			</ul>
			<form class="inline-form" id="new-folder">
				<input class="field" id="folder-title" placeholder="New folder, e.g. a name or an event" maxlength="120" required>
				<button class="btn-small" type="submit">Create folder</button>
			</form>
		</main>`;

	bindHeader();
	bindCoverPickers();

	app.querySelectorAll('[data-copy]').forEach(btn => {
		btn.onclick = async () => {
			const field = btn.closest('.folder-row').querySelector('.link-field');
			try { await navigator.clipboard.writeText(field.value); } catch { field.select(); document.execCommand('copy'); }
			btn.textContent = 'Copied';
			setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
		};
	});

	bindSearch('albums');
	bindSearch('folders');

	app.querySelectorAll('.folder-toggle').forEach(btn => {
		btn.onclick = () => {
			const id = Number(btn.closest('[data-folder]').dataset.folder);
			const open = btn.getAttribute('aria-expanded') !== 'true';
			btn.setAttribute('aria-expanded', open);
			btn.nextElementSibling.hidden = !open;
			if (open) openFolders.add(id);
			else openFolders.delete(id);
		};
	});

	app.querySelectorAll('[data-act]').forEach(btn => {
		const id = Number(btn.closest('[data-folder]').dataset.folder);
		const f = folderOf(id);
		btn.onclick = () => run(async () => {
			if (btn.dataset.act === 'rename') {
				const title = prompt('Folder name', f.title);
				if (!title || title === f.title) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { title } });
			}
			if (btn.dataset.act === 'relink') {
				if (!confirm(`Make a new link for "${f.title}"? The old link stops working.`)) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { relink: true } });
			}
			if (btn.dataset.act === 'delete') {
				if (!confirm(`Delete folder "${f.title}"? Its albums become hidden (not deleted).`)) return;
				await api(`folders/${id}`, { method: 'DELETE' });
			}
			if (btn.dataset.act === 'password') {
				const password = prompt(`Password for "${f.title}" (at least 4 characters). Anyone who opened it with the old one must enter the new one.`);
				if (password === null) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { password } });
				toast('Password set');
			}
			if (btn.dataset.act === 'nopassword') {
				if (!confirm(`Remove the password? Anyone with the link can open "${f.title}" again.`)) return;
				await api(`folders/${id}`, { method: 'PATCH', body: { password: null } });
			}
			if (btn.dataset.act === 'noexpiry') await api(`folders/${id}`, { method: 'PATCH', body: { expires_at: null } });
			await refresh();
		});
	});

	// Expiry date and the downloads switch save as soon as they change.
	app.querySelectorAll('[data-setting]').forEach(input => {
		const id = Number(input.closest('[data-folder]').dataset.folder);
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
	app.querySelectorAll('[data-favorites]').forEach(box => {
		box.addEventListener('toggle', () => {
			if (!box.open || box.dataset.loaded) return;
			box.dataset.loaded = '1';
			run(async () => {
				const { photos } = await api(`folders/${box.dataset.favorites}/favorites`);
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
	});

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
			openFolders.add(id); // show the new folder's link straight away
			await refresh();
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
			<p><a class="btn-small" href="#">← All albums</a></p>

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
			<p class="admin-hint">Cover, order and deletions save at once. Drag ⠿ to reorder.
				<button type="button" class="link-btn" id="sort-taken">Sort by date taken</button></p>
			<div class="photo-grid" id="photos"></div>

			<h2 class="admin-h">Danger zone</h2>
			<button class="btn-small danger" id="delete-album">Delete album and all its photos</button>
		</main>`;

	bindHeader();
	const grid = document.getElementById('photos');
	let coverId = a.cover_photo_id || photos[0]?.id;

	const cell = p => `
		<div class="photo-cell${p.id === coverId ? ' selected' : ''}" data-photo="${p.id}" data-id="${p.id}">
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

	grid.addEventListener('click', e => {
		const c = e.target.closest('.photo-cell');
		if (!c) return;
		const photoId = Number(c.dataset.photo);
		if (e.target.closest('[data-open]')) {
			const list = inOrder();
			previewPhotos(list, list.findIndex(p => p.id === photoId));
		}
		if (e.target.closest('[data-delete]')) run(async () => {
			if (!confirm('Delete this photo?')) return;
			await api(`photos/${photoId}`, { method: 'DELETE' });
			S.photoCount--;
			c.remove();
			photos.splice(photos.findIndex(p => p.id === photoId), 1);
			// Without a chosen cover the album uses its first photo, as the server does.
			if (coverId === photoId) setCover(inOrder()[0]?.id);
			drawCoverRow();
			updateCount();
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
		if (!confirm(`Delete "${a.title}" and all ${grid.children.length} photos? This cannot be undone.`)) return;
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

	// Uploads keep going if the admin opens another page of the admin; only this page's grid is updated,
	// and only while it is still on screen.
	let busy = false;
	async function upload(files) {
		files = files.filter(f => /^image\//.test(f.type));
		if (!files.length || busy) return;
		busy = true;
		uploading++;
		const progress = document.getElementById('progress');
		const here = () => grid.isConnected;
		const failed = [];
		let done = 0;
		try {
			for (const [i, file] of files.entries()) {
				progress.textContent = `Uploading ${i + 1} / ${files.length}: ${file.name}`;
				try {
					const p = await uploadOne(id, file);
					done++;
					S.photoCount++;
					photos.push(p);
					if (!coverId) coverId = p.id;
					if (here()) {
						grid.insertAdjacentHTML('beforeend', cell(p));
						updateCount();
					}
				} catch (e) {
					if (e instanceof LoginNeeded) return;
					failed.push(`${file.name} (${e.message})`);
				}
			}
		} finally {
			busy = false;
			uploading--;
		}
		const summary = failed.length ? `Done. Failed: ${failed.join(', ')}` : `Done. ${plural(done, 'photo')} uploaded.`;
		if (!here()) return toast(`"${a.title}": ${summary}`);
		input.value = '';
		progress.textContent = summary;
		drawCoverRow();
	}
}

// Uploads in progress, so closing or reloading the tab asks first.
let uploading = 0;
window.addEventListener('beforeunload', e => {
	if (!uploading) return;
	e.preventDefault();
	e.returnValue = '';
});

/* Browser-side resizing: the server only stores files. */

async function resize(bitmap, maxEdge, quality) {
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

async function uploadOne(albumId, file) {
	let bitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		throw new Error('this browser cannot read the file');
	}
	const { width: w, height: h } = bitmap;
	const display = await resize(bitmap, 2400, 0.86);
	const thumb = await resize(bitmap, 900, 0.82);
	bitmap.close();

	// JPEG originals: read the date taken (for "Sort by date taken") and, if the setting is on, remove the location.
	let original = file;
	let taken = null;
	if (file.type === 'image/jpeg') {
		const buf = await file.arrayBuffer();
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

	const { key } = await api(`albums/${albumId}/photos`, { method: 'POST' });
	await putFile(key, 't', thumb);
	await putFile(key, 'd', display);
	await putFile(key, 'o', original, file.name);
	return api(`albums/${albumId}/photos/${key}`, { method: 'POST', body: { w, h, taken_at: taken } });
}

/* Routing */

async function refresh() {
	S = await api('state');
	route();
}

// The main list always reloads its data, so covers, counts and photos changed in an album editor show at once.
let fresh = false; // set by start(), which has just loaded the state
function route() {
	const m = location.hash.match(/^#album\/(\d+)$/);
	const justLoaded = fresh;
	fresh = false;
	run(async () => {
		if (m) return renderAlbum(Number(m[1]));
		if (!justLoaded) S = await api('state');
		renderMain();
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
