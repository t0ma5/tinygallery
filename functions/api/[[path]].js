import {
	json, fail, notFound, randomToken, slugify,
	passwordMatches, sessionCookie, clearCookie, isAdmin,
} from '../../lib/util.js';

import { homeData, folderData, albumData, siteName, ALBUM_SQL, ALBUM_ORDER } from '../../lib/data.js';

const MB = 1024 * 1024;

export async function onRequest({ request, env, params }) {
	const path = (params.path || []).join('/');
	try {
		if (path.startsWith('admin/')) return await admin(path.slice(6), request, env);
		if (request.method !== 'GET') return fail('Method not allowed', 405);

		if (path === 'home') return json(await homeData(env));
		let m = path.match(/^f\/([A-Za-z0-9]{12})$/);
		if (m) return found(await folderData(env, m[1]));
		m = path.match(/^album\/([a-z0-9-]{1,80})$/);
		if (m) {
			const token = new URL(request.url).searchParams.get('f');
			// The admin may preview hidden and folder albums without a link.
			const data = (await albumData(env, m[1], token)) || (await albumData(env, m[1], token, await isAdmin(request, env)));
			return found(data);
		}
		return notFound();
	} catch (e) {
		console.error(e);
		return fail('Server error', 500);
	}
}

const found = data => (data ? json(data) : notFound());

/* Admin */

async function admin(path, request, env) {
	const method = request.method;
	if (path === 'login' && method === 'POST') return login(request, env);
	if (path === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie });
	if (!(await isAdmin(request, env))) return fail('Not logged in', 401);
	// Cross-site forms cannot send custom headers, so this blocks CSRF on top of SameSite cookies.
	if (method !== 'GET' && request.headers.get('x-admin') !== '1') return fail('Bad request', 400);

	const [res, rawId, sub, extra] = path.split('/');
	const id = Number(rawId) || 0;

	if (res === 'upload' && method === 'PUT') return putFile(request, env, rawId, sub);

	if (res === 'state' && method === 'GET') return state(env);
	if (res === 'home-cover' && method === 'PUT') {
		const { photo_id } = await request.json();
		await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('home_cover', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(Number(photo_id) || '')).run();
		return json({ ok: true });
	}
	if (res === 'storage' && method === 'POST') return recountStorage(env);
	// Shown on every cover, in the footer, tab titles and link previews.
	if (res === 'site-name' && method === 'PUT') {
		const { name } = await request.json();
		const value = typeof name === 'string' ? name.trim() : '';
		if (!value || value.length > 60) return fail('Site name must be 1 to 60 characters');
		await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('site_name', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(value).run();
		return json({ ok: true });
	}

	if (res === 'albums') {
		if (!id && method === 'POST') return createAlbum(request, env);
		if (id && !sub && method === 'GET') return getAlbum(env, id);
		if (id && !sub && method === 'PATCH') return updateAlbum(request, env, id);
		if (id && !sub && method === 'DELETE') return deleteAlbum(env, id);
		if (id && sub === 'photos' && !extra && method === 'POST') return startUpload(env, id);
		if (id && sub === 'photos' && extra && method === 'POST') return finishUpload(request, env, id, extra);
	}
	if (res === 'photos' && id && method === 'DELETE') return deletePhoto(env, id);

	if (res === 'folders') {
		if (!id && method === 'POST') return createFolder(request, env);
		if (id && method === 'PATCH') return updateFolder(request, env, id);
		if (id && method === 'DELETE') return deleteFolder(env, id);
	}
	return notFound();
}

async function login(request, env) {
	if (!env.ADMIN_PASSWORD) return fail('The admin password is not set on the server yet.', 503);
	const ip = request.headers.get('cf-connecting-ip') || 'local';
	const since = Date.now() - 15 * 60 * 1000;
	await env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(since).run();
	const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?').bind(ip, since).first();
	if (n >= 10) return fail('Too many attempts. Try again in 15 minutes.', 429);

	const body = await request.json().catch(() => ({}));
	if (!(await passwordMatches(env, body.password))) {
		await env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, Date.now()).run();
		return fail('Wrong password', 401);
	}
	return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env) });
}

async function state(env) {
	const [folders, albums, picks, homeCover, photoCount] = await Promise.all([
		env.DB.prepare('SELECT id, token, title, cover_photo_id FROM folders ORDER BY id DESC').all(),
		env.DB.prepare(ALBUM_SQL + ALBUM_ORDER).all(),
		// First 12 photos of each album, for the cover choosers.
		env.DB.prepare(`SELECT id, key, album_id FROM (
			SELECT id, key, album_id, ROW_NUMBER() OVER (PARTITION BY album_id ORDER BY sort, id) AS rn FROM photos
		) WHERE rn <= 12`).all(),
		env.DB.prepare(`SELECT value FROM settings WHERE key = 'home_cover'`).first(),
		env.DB.prepare('SELECT COUNT(*) AS n FROM photos').first(),
	]);
	return json({
		photographer: await siteName(env),
		storage: await savedStorage(env),
		photoCount: photoCount.n,
		homeCover: Number(homeCover?.value) || null,
		folders: folders.results,
		albums: albums.results.map(a => ({
			...a,
			picks: picks.results.filter(p => p.album_id === a.id).map(p => ({ id: p.id, key: p.key })),
		})),
	});
}

// Storage use is counted on request only: listing the bucket is a paid (Class A) operation, 1 per 1,000 files.
async function savedStorage(env) {
	const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'storage'`).first();
	return r ? JSON.parse(r.value) : null;
}

async function recountStorage(env) {
	let bytes = 0;
	let cursor;
	do {
		const page = await env.PHOTOS.list({ cursor, limit: 1000 });
		for (const obj of page.objects) bytes += obj.size;
		cursor = page.truncated ? page.cursor : null;
	} while (cursor);
	const storage = { bytes, checked: Date.now() };
	await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('storage', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(storage)).run();
	return json(storage);
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
	const { results } = await env.DB.prepare('SELECT id, key, name, w, h FROM photos WHERE album_id = ? ORDER BY sort, id').bind(id).all();
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
	if ('folder_id' in body) {
		const folderId = body.folder_id ? Number(body.folder_id) : null;
		if (!(await folderExists(env, folderId))) return fail('No such folder');
		sets.push('folder_id = ?'); values.push(folderId);
	}
	if ('hidden' in body) { sets.push('hidden = ?'); values.push(body.hidden ? 1 : 0); }
	if ('cover_photo_id' in body) {
		const p = await env.DB.prepare('SELECT id FROM photos WHERE id = ? AND album_id = ?').bind(Number(body.cover_photo_id), id).first();
		if (!p) return fail('No such photo in this album');
		sets.push('cover_photo_id = ?'); values.push(p.id);
	}
	if (!sets.length) return fail('Nothing to change');
	await env.DB.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run();
	return json({ ok: true });
}

const filesOf = key => [`${key}/t`, `${key}/d`, `${key}/o`];

async function deleteAlbum(env, id) {
	const { results } = await env.DB.prepare('SELECT key FROM photos WHERE album_id = ?').bind(id).all();
	const files = results.flatMap(p => filesOf(p.key));
	for (let i = 0; i < files.length; i += 900) await env.PHOTOS.delete(files.slice(i, i + 900));
	await env.DB.batch([
		env.DB.prepare('DELETE FROM photos WHERE album_id = ?').bind(id),
		env.DB.prepare('DELETE FROM albums WHERE id = ?').bind(id),
	]);
	return json({ ok: true });
}

// Uploads go in three steps, so the function never reads the file bytes and stays far below the CPU limit:
// 1. startUpload hands out a new key, 2. putFile streams each file (t, d, o) straight into R2,
// 3. finishUpload checks the three files are there and adds the photo to the album.
// The admin page makes the display and thumb JPEGs in the browser.

const MAX_SIZE = { t: 4 * MB, d: 15 * MB, o: 80 * MB };

async function startUpload(env, albumId) {
	if (!(await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?').bind(albumId).first())) return notFound();
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
	const { w, h } = await request.json();
	if (!(w > 0 && h > 0)) return fail('Missing size');
	const heads = await Promise.all(filesOf(key).map(f => env.PHOTOS.head(f)));
	if (heads.some(x => !x)) return fail('Upload incomplete, try again');

	const name = heads[2].customMetadata?.name || 'photo.jpg';
	const r = await env.DB.prepare(`INSERT INTO photos (album_id, key, name, w, h, sort)
		VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM photos WHERE album_id = ?))`)
		.bind(albumId, key, name, Math.round(w), Math.round(h), albumId).run();
	return json({ id: r.meta.last_row_id, key, name, w, h });
}

async function deletePhoto(env, id) {
	const p = await env.DB.prepare('SELECT key FROM photos WHERE id = ?').bind(id).first();
	if (!p) return notFound();
	await env.PHOTOS.delete(filesOf(p.key));
	await env.DB.batch([
		env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id),
		env.DB.prepare('UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ?').bind(id),
		env.DB.prepare('UPDATE folders SET cover_photo_id = NULL WHERE cover_photo_id = ?').bind(id),
	]);
	return json({ ok: true });
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
	if ('title' in body) {
		const title = cleanTitle(body.title);
		if (!title) return fail('Folder needs a name');
		await env.DB.prepare('UPDATE folders SET title = ? WHERE id = ?').bind(title, id).run();
	}
	if ('cover_photo_id' in body) {
		await env.DB.prepare('UPDATE folders SET cover_photo_id = ? WHERE id = ?').bind(Number(body.cover_photo_id) || null, id).run();
	}
	// A new token makes the old link stop working.
	if (body.relink) {
		await env.DB.prepare('UPDATE folders SET token = ? WHERE id = ?').bind(randomToken(12), id).run();
	}
	return json({ ok: true });
}

// Albums of a deleted folder become hidden, never public, so nothing private leaks onto the home page.
async function deleteFolder(env, id) {
	await env.DB.batch([
		env.DB.prepare('UPDATE albums SET folder_id = NULL, hidden = 1 WHERE folder_id = ?').bind(id),
		env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id),
	]);
	return json({ ok: true });
}
