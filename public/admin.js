// Admin panel: login, albums and uploads, private folders, cover photos.
const app = document.getElementById('app');
let S = null; // state from /api/admin/state

const ICON = {
	folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6.5h6l2 2h10V19H3z"/></svg>',
	chevron: '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 9l6 6 6-6"/></svg>',
};

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

function coverPicker(kind, id, currentId, albums) {
	const picks = albums.flatMap(a => a.picks);
	if (!picks.length) return '<p class="admin-hint cover-picker">Add photos to its albums to choose a cover.</p>';
	const current = picks.find(p => p.id === currentId) || picks[0];
	return `
		<details class="cover-picker" data-kind="${kind}" data-id="${id}">
			<summary><img src="${img(current.key, 't')}" alt=""><span>Cover photo</span><small>Change</small></summary>
			<div class="cover-thumbs">
				${picks.map(p => `
					<button type="button" class="cover-thumb${p.id === current.id ? ' selected' : ''}" data-photo="${p.id}" data-key="${p.key}">
						<img src="${img(p.key, 't')}" alt="" loading="lazy">
					</button>`).join('')}
			</div>
		</details>`;
}

function bindCoverPickers() {
	app.querySelectorAll('.cover-picker').forEach(picker => {
		picker.addEventListener('click', e => {
			const thumb = e.target.closest('.cover-thumb');
			if (!thumb) return;
			run(async () => {
				const photoId = Number(thumb.dataset.photo);
				if (picker.dataset.kind === 'home') {
					await api('home-cover', { method: 'PUT', body: { photo_id: photoId } });
					S.homeCover = photoId;
				} else {
					await api(`folders/${picker.dataset.id}`, { method: 'PATCH', body: { cover_photo_id: photoId } });
					folderOf(Number(picker.dataset.id)).cover_photo_id = photoId;
				}
				picker.querySelectorAll('.cover-thumb').forEach(b => b.classList.toggle('selected', b === thumb));
				picker.querySelector('summary img').src = img(thumb.dataset.key, 't');
			});
		});
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
				${coverPicker('home', 0, S.homeCover, publicAlbums)}
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
			<ul class="folder-list" id="albums-list">
				${S.albums.map(a => `
					<li class="album-row" data-search="${esc(searchText(`${a.title} ${a.date || ''} ${whereLabel(a)}`))}">
						<a class="album-thumb" href="#album/${a.id}">${a.cover ? `<img src="${img(a.cover, 't')}" alt="">` : ''}</a>
						<div class="folder-info">
							<a class="folder-name" href="#album/${a.id}">${esc(a.title)}</a>
							<span class="folder-meta">${a.date ? `${esc(a.date)} · ` : ''}${plural(a.count, 'photo')} · ${esc(whereLabel(a))}</span>
						</div>
						<div class="row-actions">
							<a class="btn-small" href="#album/${a.id}">Edit</a>
							<a class="btn-small" href="${albumUrl(a)}" target="_blank" rel="noopener">Open</a>
						</div>
					</li>`).join('') || '<li class="admin-hint">No albums yet.</li>'}
			</ul>

			<h2 class="admin-h">Private folders</h2>
			<p class="admin-hint">Clients see the folder name on the cover of their link, so name it for them. Anyone with a folder link can open it, no password. Put albums in a folder from the album's settings.</p>
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
								<span class="folder-meta">${plural(albums.length, 'album')}</span>
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
						${coverPicker('folder', f.id, f.cover_photo_id, albums)}
						</div>
					</li>`;
				}).join('')}
			</ul>
			<form class="inline-form" id="new-folder">
				<input class="field" id="folder-title" placeholder="New folder, e.g. client name" maxlength="120" required>
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
			await refresh();
		});
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
		}).finally(() => {
			if (btn.isConnected) {
				btn.disabled = false;
				btn.textContent = 'Recount';
			}
		});
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
			<form class="album-form" id="album-form">
				<label class="label" for="title">Title</label>
				<input class="field" id="title" value="${esc(a.title)}" maxlength="120" required>
				<label class="label" for="date">Date</label>
				<input class="field" id="date" type="date" value="${esc(a.date || '')}">
				<label class="label" for="where">Shown on</label>
				${whereSelect('where', whereValue(a))}
				<div class="row-actions">
					<button class="btn-small" type="submit">Save</button>
					<a class="btn-small" href="${albumUrl(a)}" target="_blank" rel="noopener">Open album</a>
				</div>
			</form>

			<h2 class="admin-h">Photos <span class="folder-meta" id="count">${plural(photos.length, 'photo')}</span></h2>
			<label class="dropzone" id="dropzone">
				<input type="file" id="files" multiple accept="image/jpeg,image/png,image/webp">
				<span>Drop photos here or click to choose</span>
				<small id="progress">JPEG, PNG or WebP. Originals are kept for download.</small>
			</label>
			<p class="admin-hint">Click a photo's "Cover" to use it as the album cover.</p>
			<div class="photo-grid" id="photos"></div>

			<h2 class="admin-h">Danger zone</h2>
			<button class="btn-small danger" id="delete-album">Delete album and all its photos</button>
		</main>`;

	bindHeader();
	const grid = document.getElementById('photos');
	let coverId = a.cover_photo_id || photos[0]?.id;

	const cell = p => `
		<div class="photo-cell${p.id === coverId ? ' selected' : ''}" data-photo="${p.id}">
			<img src="${img(p.key, 't')}" alt="" loading="lazy">
			<div class="photo-actions">
				<button class="btn-small" data-cover>Cover</button>
				<button class="btn-small danger" data-delete>Delete</button>
			</div>
		</div>`;
	grid.innerHTML = photos.map(cell).join('');
	const updateCount = () => { document.getElementById('count').textContent = plural(grid.children.length, 'photo'); };

	grid.addEventListener('click', e => {
		const c = e.target.closest('.photo-cell');
		if (!c) return;
		const photoId = Number(c.dataset.photo);
		if (e.target.closest('[data-cover]')) run(async () => {
			await api(`albums/${id}`, { method: 'PATCH', body: { cover_photo_id: photoId } });
			coverId = photoId;
			grid.querySelectorAll('.photo-cell').forEach(x => x.classList.toggle('selected', x === c));
		});
		if (e.target.closest('[data-delete]')) run(async () => {
			if (!confirm('Delete this photo?')) return;
			await api(`photos/${photoId}`, { method: 'DELETE' });
			S.photoCount--;
			c.remove();
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

	let busy = false;
	async function upload(files) {
		files = files.filter(f => /^image\//.test(f.type));
		if (!files.length || busy) return;
		busy = true;
		const progress = document.getElementById('progress');
		const failed = [];
		for (const [i, file] of files.entries()) {
			progress.textContent = `Uploading ${i + 1} / ${files.length}: ${file.name}`;
			try {
				const p = await uploadOne(id, file);
				if (!coverId) coverId = p.id;
				grid.insertAdjacentHTML('beforeend', cell(p));
				updateCount();
			} catch (e) {
				if (e instanceof LoginNeeded) return;
				failed.push(`${file.name} (${e.message})`);
			}
		}
		busy = false;
		input.value = '';
		progress.textContent = failed.length ? `Done. Failed: ${failed.join(', ')}` : `Done. ${plural(files.length, 'photo')} uploaded.`;
		S = await api('state');
	}
}

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

	const { key } = await api(`albums/${albumId}/photos`, { method: 'POST' });
	await putFile(key, 't', thumb);
	await putFile(key, 'd', display);
	await putFile(key, 'o', file, file.name);
	return api(`albums/${albumId}/photos/${key}`, { method: 'POST', body: { w, h } });
}

/* Routing */

async function refresh() {
	S = await api('state');
	route();
}

function route() {
	const m = location.hash.match(/^#album\/(\d+)$/);
	run(() => (m ? renderAlbum(Number(m[1])) : renderMain()));
}

async function start() {
	try {
		S = await api('state');
	} catch (e) {
		if (!(e instanceof LoginNeeded)) toast(e.message);
		return;
	}
	window.onhashchange = route;
	route();
}

start();
