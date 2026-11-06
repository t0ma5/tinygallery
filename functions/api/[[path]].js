import {
	json, fail, notFound, randomToken, slugify,
	passwordMatches, sessionCookie, clearCookie, isAdmin,
	hashFolderPassword, folderPasswordMatches, folderCookie, tooManyAttempts, recordFailedAttempt,
} from '../../lib/util.js';

import { homeData, homeCoverPhotos, folderData, albumData, openFolder, siteName, ALBUM_SQL, ALBUM_ORDER } from '../../lib/data.js';
import { TRASH_DAYS, trashPhotoStatements, trashAlbumStatements, runBatches, selectIn, restore, purge, trashKeys } from '../../lib/trash.js';

const MB = 1024 * 1024;
const MAX_FAVORITES = 20000; // per folder, from all visitors together

export async function onRequest({ request, env, params, waitUntil }) {
	const path = (params.path || []).join('/');
	try {
		if (path.startsWith('admin/')) return await admin(path.slice(6), request, env, waitUntil);

		let m = path.match(/^f\/([A-Za-z0-9]{12})\/(unlock|favorites)$/);
		if (m && m[2] === 'unlock' && request.method === 'POST') return await unlockFolder(request, env, m[1]);
		if (m && m[2] === 'favorites') return await favorites(request, env, m[1]);
		if (request.method !== 'GET') return fail('Method not allowed', 405);

		if (path === 'home') return json(await homeData(env));
		m = path.match(/^f\/([A-Za-z0-9]{12})$/);
		if (m) {
			const data = await folderData(env, request, m[1]);
			if (data && !data.locked && !data.expired) {
				count(waitUntil, request, env, [['UPDATE folders SET views = views + 1, last_viewed_at = CURRENT_TIMESTAMP WHERE token = ?', m[1]]]);
			}
			return page(data);
		}
		m = path.match(/^album\/([a-z0-9-]{1,80})$/);
		if (m) {
			const token = new URL(request.url).searchParams.get('f');
			let data = await albumData(env, request, m[1], token);
			if (data && !data.locked && !data.expired) {
				const counts = [['UPDATE albums SET views = views + 1 WHERE slug = ?', m[1]]];
				// An album opened straight from a folder link also counts as opening the folder.
				if (data.back !== '/') counts.push(['UPDATE folders SET last_viewed_at = CURRENT_TIMESTAMP WHERE token = ?', token]);
				count(waitUntil, request, env, counts);
			} else if (!data) {
				// The admin may preview hidden and folder albums without a link.
				data = await albumData(env, request, m[1], token, await isAdmin(request, env));
			}
			return page(data);
		}
		return notFound();
	} catch (e) {
		console.error(e);
		return fail('Server error', 500);
	}
}

// Locked and expired folders answer with their own status, so the page can ask for the password or explain.
function page(data) {
	if (!data) return notFound();
	if (data.locked) return json(data, 401);
	if (data.expired) return json(data, 410);
	return json(data);
}

// View counters and "last opened", updated after the response; the admin's own visits do not count.
// updates: [[sql, value], ...]
function count(waitUntil, request, env, updates) {
	waitUntil((async () => {
		if (/(?:^|;\s*)session=/.test(request.headers.get('cookie') || '') && (await isAdmin(request, env))) return;
		await env.DB.batch(updates.map(([sql, value]) => env.DB.prepare(sql).bind(value)));
	})());
}

/* Private folder visitors */

async function unlockFolder(request, env, token) {
	const open = await openFolder(env, request, token);
	if (!open) return notFound();
	if (open.status === 'expired') return json({ expired: true }, 410);
	const ip = 'folder:' + (request.headers.get('cf-connecting-ip') || 'local');
	if (await tooManyAttempts(env, ip)) return fail('Too many attempts. Try again in 15 minutes.', 429);
	const { password } = await request.json().catch(() => ({}));
	if (!(await folderPasswordMatches(open.folder.password_hash, password))) {
		await recordFailedAttempt(env, ip);
		return fail('Wrong password', 401);
	}
	return json({ ok: true }, 200, { 'set-cookie': await folderCookie(env, open.folder) });
}

// Favourites: GET lists this client's photo keys, POST { client, key, on, name } sets one.
// client is a random id kept in the visitor's browser; name is optional so the photographer knows who picked what.
async function favorites(request, env, token) {
	const open = await openFolder(env, request, token);
	if (!open) return notFound();
	if (open.status !== 'ok') return fail('Not available', open.status === 'locked' ? 401 : 410);
	const folderId = open.folder.id;
	const validClient = c => typeof c === 'string' && /^[A-Za-z0-9]{16}$/.test(c);

	if (request.method === 'GET') {
		const client = new URL(request.url).searchParams.get('client');
		if (!validClient(client)) return json({ keys: [] });
		const { results } = await env.DB.prepare(`
			SELECT p.key FROM favorites v JOIN photos p ON p.id = v.photo_id
			WHERE v.folder_id = ? AND v.client = ?`).bind(folderId, client).all();
		return json({ keys: results.map(r => r.key) });
	}
	if (request.method !== 'POST') return fail('Method not allowed', 405);

	const { client, key, on, name } = await request.json().catch(() => ({}));
	if (!validClient(client)) return fail('Bad client id');
	// The photo must be in a visible album of this folder.
	const photo = await env.DB.prepare(`
		SELECT p.id FROM photos p JOIN albums a ON a.id = p.album_id
		WHERE p.key = ? AND a.folder_id = ? AND a.hidden = 0`).bind(String(key), folderId).first();
	if (!photo) return notFound();
	const who = typeof name === 'string' ? name.trim().slice(0, 60) || null : null;
	if (on) {
		// Anyone with the link can add favourites, so a folder has a ceiling against scripted spam.
		const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM favorites WHERE folder_id = ?').bind(folderId).first();
		if (n >= MAX_FAVORITES) return fail('This folder has reached its limit of favourites', 429);
		await env.DB.batch([
			env.DB.prepare('INSERT OR IGNORE INTO favorites (folder_id, photo_id, client, name) VALUES (?, ?, ?, ?)')
				.bind(folderId, photo.id, client, who),
			env.DB.prepare('UPDATE favorites SET name = ? WHERE folder_id = ? AND client = ? AND ? IS NOT NULL').bind(who, folderId, client, who),
		]);
	} else {
		await env.DB.prepare('DELETE FROM favorites WHERE folder_id = ? AND photo_id = ? AND client = ?').bind(folderId, photo.id, client).run();
	}
	return json({ ok: true });
}

/* Admin */

async function admin(path, request, env, waitUntil) {
	const method = request.method;
	if (path === 'login' && method === 'POST') return login(request, env);
	if (path === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie });
	if (!(await isAdmin(request, env))) return fail('Not logged in', 401);
	// Cross-site forms cannot send custom headers, so this blocks CSRF on top of SameSite cookies.
	if (method !== 'GET' && request.headers.get('x-admin') !== '1') return fail('Bad request', 400);

	const [res, rawId, sub, extra] = path.split('/');
	const id = Number(rawId) || 0;

	if (res === 'upload' && method === 'PUT') return putFile(request, env, rawId, sub);

	if (res === 'state' && method === 'GET') {
		// The admin page loading is the moment to clear trash older than 7 days (no scheduled jobs on Pages).
		waitUntil(purge(env).catch(e => console.error(e)));
		return state(env);
	}
	// Up to 5 home cover photos; the home page shows one of them at random on each visit.
	if (res === 'home-covers' && method === 'PUT') {
		const { ids } = await request.json();
		if (!Array.isArray(ids) || ids.length > 5) return fail('Choose up to 5 cover photos');
		await setSetting(env, 'home_covers', JSON.stringify([...new Set(ids.map(Number).filter(Boolean))]));
		return json({ ok: true });
	}
	if (res === 'storage' && method === 'POST') return recountStorage(env);
	// A new session epoch makes every admin cookie invalid, on all devices.
	if (res === 'logout-all' && method === 'POST') {
		await setSetting(env, 'session_epoch', randomToken(12));
		return json({ ok: true }, 200, { 'set-cookie': clearCookie });
	}
	// Shown on every cover, in the footer, tab titles and link previews.
	if (res === 'site-name' && method === 'PUT') {
		const { name } = await request.json();
		const value = typeof name === 'string' ? name.trim() : '';
		if (!value || value.length > 60) return fail('Site name must be 1 to 60 characters');
		await setSetting(env, 'site_name', value);
		return json({ ok: true });
	}
	// The admin page reads this before uploading; the GPS removal itself happens in the browser.
	if (res === 'strip-gps' && method === 'PUT') {
		const { on } = await request.json();
		await setSetting(env, 'strip_gps', on ? '1' : '0');
		return json({ ok: true });
	}
	// Text drawn on display copies of new uploads; empty turns it off. Drawn in the browser like the resizing.
	if (res === 'watermark' && method === 'PUT') {
		const { text } = await request.json();
		const value = typeof text === 'string' ? text.trim() : '';
		if (value.length > 60) return fail('Watermark text must be at most 60 characters');
		await setSetting(env, 'watermark', value);
		return json({ ok: true });
	}

	if (res === 'trash') {
		if (id && sub === 'restore' && method === 'POST') {
			const error = await restore(env, id);
			return error ? fail(error, 409) : json({ ok: true });
		}
		if (id && !sub && method === 'DELETE') return json({ removed: await purge(env, { ids: [id] }) });
		if (!rawId && method === 'DELETE') {
			const { results } = await env.DB.prepare('SELECT id FROM trash').all();
			return json({ removed: results.length ? await purge(env, { ids: results.map(r => r.id) }) : 0 });
		}
	}

	if (res === 'albums') {
		if (rawId === 'order' && method === 'PUT') return setOrder(request, env, 'albums', null);
		if (!id && method === 'POST') return createAlbum(request, env);
		if (id && !sub && method === 'GET') return getAlbum(env, id);
		if (id && !sub && method === 'PATCH') return updateAlbum(request, env, id);
		if (id && !sub && method === 'DELETE') return deleteAlbum(env, id);
		if (id && sub === 'order' && method === 'PUT') return setOrder(request, env, 'photos', id);
		if (id && sub === 'photos' && !extra && method === 'POST') return startUpload(request, env, id);
		if (id && sub === 'photos' && extra && method === 'POST') return finishUpload(request, env, id, extra);
	}
	if (res === 'photos' && rawId === 'delete' && method === 'POST') return deletePhotos(request, env);
	if (res === 'photos' && rawId === 'move' && method === 'POST') return movePhotos(request, env);

	if (res === 'folders') {
		if (!id && method === 'POST') return createFolder(request, env);
		if (id && sub === 'favorites' && method === 'GET') return folderFavorites(env, id);
		if (id && !sub && method === 'PATCH') return updateFolder(request, env, id);
		if (id && !sub && method === 'DELETE') return deleteFolder(env, id);
	}
	return notFound();
}

function setSetting(env, key, value) {
	return env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}

async function login(request, env) {
	if (!env.ADMIN_PASSWORD) return fail('The admin password is not set on the server yet.', 503);
	const ip = request.headers.get('cf-connecting-ip') || 'local';
	if (await tooManyAttempts(env, ip)) return fail('Too many attempts. Try again in 15 minutes.', 429);
	const body = await request.json().catch(() => ({}));
	if (!(await passwordMatches(env, body.password))) {
		await recordFailedAttempt(env, ip);
		return fail('Wrong password', 401);
	}
	return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env) });
}

async function state(env) {
	const [folders, albums, settings, photoCount, trash] = await Promise.all([
		// Never send password hashes to the browser, only whether one is set. cover_key: the chosen cover while
		// it is still in one of the folder's albums (same rule as the public page).
		env.DB.prepare(`SELECT f.id, f.token, f.title, f.cover_photo_id, f.expires_at, f.downloads_off, f.views, f.last_viewed_at,
				f.password_hash IS NOT NULL AS has_password,
				(SELECT p.key FROM photos p JOIN albums a ON a.id = p.album_id WHERE p.id = f.cover_photo_id AND a.folder_id = f.id) AS cover_key,
				(SELECT COUNT(DISTINCT photo_id) FROM favorites v WHERE v.folder_id = f.id) AS favorites
			FROM folders f ORDER BY f.id DESC`).all(),
		env.DB.prepare(ALBUM_SQL + ALBUM_ORDER).all(),
		env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('storage', 'strip_gps', 'watermark')`).all(),
		env.DB.prepare('SELECT COALESCE(SUM(photo_count), 0) AS n FROM albums').first(),
		// Newest first, with the first photo for a thumbnail and the number of photos (not the whole rows).
		env.DB.prepare(`SELECT id, kind, title, deleted_at, json_extract(keys, '$[0]') AS key, json_array_length(keys) AS photos
			FROM trash ORDER BY deleted_at DESC, id DESC`).all(),
	]);
	const setting = k => settings.results.find(r => r.key === k)?.value;
	return json({
		photographer: await siteName(env),
		storage: setting('storage') ? JSON.parse(setting('storage')) : null,
		photoCount: photoCount.n,
		// Chosen home covers that are still in public albums, with keys so the picker can always show them.
		homeCovers: await homeCoverPhotos(env),
		// On unless the admin turned it off.
		stripGps: setting('strip_gps') !== '0',
		watermark: setting('watermark') || '',
		trash: trash.results,
		trashDays: TRASH_DAYS,
		folders: folders.results,
		// No photos here: the cover choosers load one album's photos when opened, so this stays small.
		albums: albums.results,
	});
}

// Storage use is counted on request only: listing the bucket is a paid (Class A) operation, 1 per 1,000 files.
// The same pass removes files of uploads that never finished (tab closed, connection lost): files whose key
// is not in the database and that are over a day old, so uploads running right now are left alone.
async function recountStorage(env) {
	const { results } = await env.DB.prepare('SELECT key FROM photos').all();
	const known = new Set([...results.map(r => r.key), ...(await trashKeys(env))]);
	const dayAgo = Date.now() - 86400 * 1000;
	let bytes = 0;
	const orphans = [];
	let cursor;
	do {
		const page = await env.PHOTOS.list({ cursor, limit: 1000 });
		for (const obj of page.objects) {
			// Only files named like photo files: anything else in the bucket is never touched.
			const m = obj.key.match(/^([A-Za-z0-9]{20})\/[tdo]$/);
			if (m && !known.has(m[1]) && obj.uploaded.getTime() < dayAgo) orphans.push(obj.key);
			else bytes += obj.size;
		}
		cursor = page.truncated ? page.cursor : null;
	} while (cursor);
	for (let i = 0; i < orphans.length; i += 1000) await env.PHOTOS.delete(orphans.slice(i, i + 1000));
	const storage = { bytes, checked: Date.now() };
	await setSetting(env, 'storage', JSON.stringify(storage));
	return json({ ...storage, removed: orphans.length });
}

function cleanTitle(v) {
	const t = typeof v === 'string' ? v.trim() : '';
	return t && t.length <= 120 ? t : null;
}

function cleanDate(v) {
	return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

async function folderExists(env, folderId) {
	return folderId === null || !!(await env.DB.prepare('SELECT 1 FROM folders WHERE id = ?').bind(folderId).first());
}

// PUT { ids: [...] } in the new order: albums overall, or the photos of one album.
async function setOrder(request, env, table, albumId) {
	const { ids } = await request.json();
	if (!Array.isArray(ids) || ids.length > 10000) return fail('Send ids');
	const where = albumId ? ' AND album_id = ?' : '';
	const statements = ids.map((rowId, i) =>
		env.DB.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?${where}`).bind(i + 1, Number(rowId), ...(albumId ? [albumId] : [])));
	for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
	return json({ ok: true });
}

async function createAlbum(request, env) {
	const body = await request.json();
	const title = cleanTitle(body.title);
	if (!title) return fail('Album needs a title');
	const folderId = body.folder_id ? Number(body.folder_id) : null;
	if (!(await folderExists(env, folderId))) return fail('No such folder');

	const base = slugify(title);
	let slug = base;
	for (let i = 2; await env.DB.prepare('SELECT 1 FROM albums WHERE slug = ?').bind(slug).first(); i++) slug = `${base}-${i}`;

	const r = await env.DB.prepare('INSERT INTO albums (slug, title, date, folder_id, hidden) VALUES (?, ?, ?, ?, ?)')
		.bind(slug, title, cleanDate(body.date), folderId, body.hidden ? 1 : 0).run();
	return json({ id: r.meta.last_row_id, slug });
}

async function getAlbum(env, id) {
	const a = await env.DB.prepare(`${ALBUM_SQL} WHERE a.id = ?`).bind(id).first();
	if (!a) return notFound();
	const { results } = await env.DB.prepare(
		'SELECT id, key, name, w, h, taken_at, hash FROM photos WHERE album_id = ? ORDER BY sort, id').bind(id).all();
	return json({ album: a, photos: results });
}

async function updateAlbum(request, env, id) {
	const body = await request.json();
	const sets = [];
	const values = [];
	if ('title' in body) {
		const title = cleanTitle(body.title);
		if (!title) return fail('Album needs a title');
		sets.push('title = ?'); values.push(title);
	}
	if ('date' in body) { sets.push('date = ?'); values.push(cleanDate(body.date)); }
	const folderId = body.folder_id ? Number(body.folder_id) : null;
	if ('folder_id' in body) {
		if (!(await folderExists(env, folderId))) return fail('No such folder');
		sets.push('folder_id = ?'); values.push(folderId);
	}
	if ('hidden' in body) { sets.push('hidden = ?'); values.push(body.hidden ? 1 : 0); }
	if ('downloads_off' in body) { sets.push('downloads_off = ?'); values.push(body.downloads_off ? 1 : 0); }
	if ('cover_photo_id' in body) {
		const p = await env.DB.prepare('SELECT id FROM photos WHERE id = ? AND album_id = ?').bind(Number(body.cover_photo_id), id).first();
		if (!p) return fail('No such photo in this album');
		sets.push('cover_photo_id = ?'); values.push(p.id);
	}
	if (!sets.length) return fail('Nothing to change');
	const statements = [env.DB.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id)];
	// Favourites belong to the folder they were picked in: they go when the album moves elsewhere.
	if ('folder_id' in body) {
		statements.push(env.DB.prepare(`DELETE FROM favorites
			WHERE photo_id IN (SELECT id FROM photos WHERE album_id = ?) AND folder_id IS NOT ?`).bind(id, folderId));
	}
	await env.DB.batch(statements);
	return json({ ok: true });
}

const filesOf = key => [`${key}/t`, `${key}/d`, `${key}/o`];

// Deleted albums go to the trash with their photos; files are removed only when the trash is purged.
async function deleteAlbum(env, id) {
	const statements = await trashAlbumStatements(env, id);
	if (!statements) return notFound();
	await env.DB.batch(statements);
	return json({ ok: true });
}

// POST { ids }: photos to the trash, one item each (from the album editor, one or many at a time).
async function deletePhotos(request, env) {
	const ids = await photoIds(request);
	if (!ids) return fail('Send photo ids');
	const photos = await selectIn(env, 'SELECT * FROM photos WHERE id IN', ids);
	if (!photos.length) return notFound();
	const albums = await selectIn(env, 'SELECT id, slug, title FROM albums WHERE id IN', [...new Set(photos.map(p => p.album_id))]);
	await runBatches(env, trashPhotoStatements(env, photos, new Map(albums.map(a => [a.id, a]))));
	return json({ deleted: photos.length });
}

// POST { ids, album_id }: photos to another album, at its end, in the order given.
// Covers that pointed at them are cleared, and favourites go when the photos leave their folder.
async function movePhotos(request, env) {
	const body = await request.clone().json();
	const ids = await photoIds(request);
	const target = await env.DB.prepare('SELECT id, folder_id FROM albums WHERE id = ?').bind(Number(body.album_id)).first();
	if (!ids || !target) return fail('Choose photos and an album');
	const { n } = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM photos WHERE album_id = ?').bind(target.id).first();
	const statements = ids.flatMap((pid, i) => [
		env.DB.prepare('UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ? AND id != ?').bind(pid, target.id),
		env.DB.prepare('DELETE FROM favorites WHERE photo_id = ? AND folder_id IS NOT ?').bind(pid, target.folder_id),
		env.DB.prepare('UPDATE photos SET album_id = ?, sort = ? WHERE id = ?').bind(target.id, n + i + 1, pid),
	]);
	await runBatches(env, statements, 99);
	return json({ moved: ids.length });
}

async function photoIds(request) {
	const { ids } = await request.json().catch(() => ({}));
	if (!Array.isArray(ids) || !ids.length || ids.length > 2000) return null;
	const clean = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
	return clean.length ? clean : null;
}

// Uploads go in three steps, so the function never reads the file bytes and stays far below the CPU limit:
// 1. startUpload hands out a new key, 2. putFile streams each file (t, d, o) straight into R2,
// 3. finishUpload checks the three files are there and adds the photo to the album.
// The admin page makes the display and thumb JPEGs in the browser.

const MAX_SIZE = { t: 4 * MB, d: 15 * MB, o: 80 * MB };

// SHA-256 of the chosen file, in hex, made in the browser.
const cleanHash = v => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

// POST { hash }: the same file already in this album is refused before anything is uploaded.
async function startUpload(request, env, albumId) {
	if (!(await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?').bind(albumId).first())) return notFound();
	const hash = cleanHash((await request.json().catch(() => ({}))).hash);
	if (hash && (await env.DB.prepare('SELECT 1 FROM photos WHERE album_id = ? AND hash = ?').bind(albumId, hash).first())) {
		return json({ duplicate: true }, 409);
	}
	return json({ key: randomToken(20) });
}

async function putFile(request, env, key, size) {
	if (!/^[A-Za-z0-9]{20}$/.test(key || '') || !(size in MAX_SIZE)) return notFound();
	// Never overwrite the files of a photo that is already in an album.
	if (await env.DB.prepare('SELECT 1 FROM photos WHERE key = ?').bind(key).first()) return fail('Key already used', 409);
	const type = request.headers.get('content-type') || '';
	const length = Number(request.headers.get('content-length'));
	if (!/^image\//.test(type)) return fail('Send an image file');
	if (!(length > 0)) return fail('Missing file size', 411);
	if (length > MAX_SIZE[size]) return fail('File too large', 413);

	const options = { httpMetadata: { contentType: type } };
	if (size === 'o') {
		const name = decodeURIComponent(request.headers.get('x-name') || '').slice(0, 200) || 'photo.jpg';
		options.customMetadata = { name };
	}
	await env.PHOTOS.put(`${key}/${size}`, request.body, options);
	return json({ ok: true });
}

async function finishUpload(request, env, albumId, key) {
	if (!/^[A-Za-z0-9]{20}$/.test(key)) return notFound();
	if (!(await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?').bind(albumId).first())) return notFound();
	const { w, h, taken_at, hash } = await request.json();
	if (!(w > 0 && h > 0)) return fail('Missing size');
	const heads = await Promise.all(filesOf(key).map(f => env.PHOTOS.head(f)));
	if (heads.some(x => !x)) return fail('Upload incomplete, try again');

	const name = heads[2].customMetadata?.name || 'photo.jpg';
	const taken = typeof taken_at === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(taken_at) ? taken_at : null;
	const digest = cleanHash(hash);
	const r = await env.DB.prepare(`INSERT INTO photos (album_id, key, name, w, h, taken_at, hash, sort)
		VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM photos WHERE album_id = ?))`)
		.bind(albumId, key, name, Math.round(w), Math.round(h), taken, digest, albumId).run();
	return json({ id: r.meta.last_row_id, key, name, w, h, taken_at: taken, hash: digest });
}

async function createFolder(request, env) {
	const title = cleanTitle((await request.json()).title);
	if (!title) return fail('Folder needs a name');
	const token = randomToken(12);
	const r = await env.DB.prepare('INSERT INTO folders (token, title) VALUES (?, ?)').bind(token, title).run();
	return json({ id: r.meta.last_row_id, token });
}

async function updateFolder(request, env, id) {
	const body = await request.json();
	if (!(await env.DB.prepare('SELECT 1 FROM folders WHERE id = ?').bind(id).first())) return notFound();
	const sets = [];
	const values = [];
	if ('title' in body) {
		const title = cleanTitle(body.title);
		if (!title) return fail('Folder needs a name');
		sets.push('title = ?'); values.push(title);
	}
	if ('cover_photo_id' in body) { sets.push('cover_photo_id = ?'); values.push(Number(body.cover_photo_id) || null); }
	// password: a string sets it, null removes it. A new password locks out everyone who unlocked the old one.
	if ('password' in body) {
		if (body.password === null) {
			sets.push('password_hash = NULL');
		} else {
			const pw = typeof body.password === 'string' ? body.password : '';
			if (pw.length < 4 || pw.length > 100) return fail('Password must be 4 to 100 characters');
			sets.push('password_hash = ?'); values.push(await hashFolderPassword(pw));
		}
	}
	// expires_at: the last day the link works (YYYY-MM-DD), or null for no expiry.
	if ('expires_at' in body) { sets.push('expires_at = ?'); values.push(cleanDate(body.expires_at)); }
	if ('downloads_off' in body) { sets.push('downloads_off = ?'); values.push(body.downloads_off ? 1 : 0); }
	// A new token makes the old link stop working.
	if (body.relink) { sets.push('token = ?'); values.push(randomToken(12)); }
	if (sets.length) await env.DB.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run();
	return json({ ok: true });
}

// Favourites of a folder, one row per photo with who picked it, in album and photo order.
async function folderFavorites(env, id) {
	const { results } = await env.DB.prepare(`
		SELECT p.id, p.key, p.name, a.title AS album, GROUP_CONCAT(COALESCE(v.name, 'Anonymous'), ', ') AS clients,
			COUNT(*) AS picks
		FROM favorites v JOIN photos p ON p.id = v.photo_id JOIN albums a ON a.id = p.album_id
		WHERE v.folder_id = ?
		GROUP BY p.id ORDER BY a.sort, a.date DESC, a.id DESC, p.sort, p.id`).bind(id).all();
	return json({ photos: results });
}

// Albums of a deleted folder become hidden, never public, so nothing private leaks onto the home page.
async function deleteFolder(env, id) {
	await env.DB.batch([
		env.DB.prepare('UPDATE albums SET folder_id = NULL, hidden = 1 WHERE folder_id = ?').bind(id),
		env.DB.prepare('DELETE FROM favorites WHERE folder_id = ?').bind(id),
		env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id),
	]);
	return json({ ok: true });
}
