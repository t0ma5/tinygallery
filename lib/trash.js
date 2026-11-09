// Trash: deleted photos and albums stay 7 days with their files, so a wrong click can be undone.
// A trash row holds the deleted database rows as JSON and the R2 file prefixes to remove when it is purged.
// Pages Functions have no scheduled jobs, so old items are purged whenever the admin page loads.
import { slugify } from './util.js';

export const TRASH_DAYS = 7;

// The three R2 files of a photo: thumb, display and original.
export const filesOf = key => [`${key}/t`, `${key}/d`, `${key}/o`];

// Statements that move photos (full rows) into the trash, one item per photo, and remove them everywhere.
export function trashPhotoStatements(env, photos, albums) {
	const now = Date.now();
	const statements = [];
	for (const p of photos) {
		const album = albums.get(p.album_id);
		statements.push(
			env.DB.prepare('INSERT INTO trash (kind, title, data, keys, deleted_at) VALUES (?, ?, ?, ?, ?)')
				.bind('photo', p.name, JSON.stringify({ photo: p, album: { id: album.id, slug: album.slug, title: album.title } }), JSON.stringify([p.key]), now),
			env.DB.prepare('DELETE FROM favorites WHERE photo_id = ?').bind(p.id),
			env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(p.id),
			env.DB.prepare('UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ?').bind(p.id),
			env.DB.prepare('UPDATE folders SET cover_photo_id = NULL WHERE cover_photo_id = ?').bind(p.id),
		);
	}
	return statements;
}

// Statements that move an album with all its photos into the trash as one item.
export async function trashAlbumStatements(env, id) {
	const album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?').bind(id).first();
	if (!album) return null;
	const { results: photos } = await env.DB.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY sort, id').bind(id).all();
	const cover = photos.find(p => p.id === album.cover_photo_id);
	const data = { album, photos, cover_key: cover?.key || null };
	return [
		env.DB.prepare('INSERT INTO trash (kind, title, data, keys, deleted_at) VALUES (?, ?, ?, ?, ?)')
			.bind('album', album.title, JSON.stringify(data), JSON.stringify(photos.map(p => p.key)), Date.now()),
		env.DB.prepare('DELETE FROM favorites WHERE photo_id IN (SELECT id FROM photos WHERE album_id = ?)').bind(id),
		env.DB.prepare('UPDATE folders SET cover_photo_id = NULL WHERE cover_photo_id IN (SELECT id FROM photos WHERE album_id = ?)').bind(id),
		env.DB.prepare('DELETE FROM photos WHERE album_id = ?').bind(id),
		env.DB.prepare('DELETE FROM albums WHERE id = ?').bind(id),
	];
}

// Runs statements in batches D1 accepts.
export async function runBatches(env, statements, size = 100) {
	for (let i = 0; i < statements.length; i += size) await env.DB.batch(statements.slice(i, i + size));
}

// sql ending in "IN", run for the ids in chunks: D1 takes at most 100 bound values per query.
export async function selectIn(env, sql, ids) {
	const rows = [];
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		rows.push(...(await env.DB.prepare(`${sql} (${chunk.map(() => '?').join(', ')})`).bind(...chunk).all()).results);
	}
	return rows;
}

// Keeps the old photo id when it is still free, so links to it from covers can be restored.
const photoInsert = (env, p, albumId) => env.DB.prepare(`
	INSERT OR IGNORE INTO photos (id, album_id, key, name, w, h, sort, taken_at, hash, created_at)
	VALUES (CASE WHEN EXISTS (SELECT 1 FROM photos WHERE id = ?) THEN NULL ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	.bind(p.id, p.id, albumId, p.key, p.name, p.w, p.h, p.sort, p.taken_at ?? null, p.hash ?? null, p.created_at);

// Puts a trash item back. Returns an error message, or null when restored.
export async function restore(env, id) {
	const item = await env.DB.prepare('SELECT * FROM trash WHERE id = ?').bind(id).first();
	if (!item) return 'Not in the trash any more';
	const data = JSON.parse(item.data);

	if (item.kind === 'photo') {
		// The same album must still exist (id and address), or the photo would land in a stranger's album.
		const album = await env.DB.prepare('SELECT id FROM albums WHERE id = ? AND slug = ?').bind(data.album.id, data.album.slug).first();
		if (!album) return `Its album "${data.album.title}" is gone. Restore the album first.`;
		await env.DB.batch([photoInsert(env, data.photo, album.id), env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(id)]);
		return null;
	}

	// Album: same id and address when still free; a folder that was deleted meanwhile makes it hidden.
	const a = data.album;
	let slug = a.slug;
	for (let i = 2; await env.DB.prepare('SELECT 1 FROM albums WHERE slug = ?').bind(slug).first(); i++) slug = `${slugify(a.title)}-${i}`;
	const folderOk = a.folder_id === null || !!(await env.DB.prepare('SELECT 1 FROM folders WHERE id = ?').bind(a.folder_id).first());
	const r = await env.DB.prepare(`
		INSERT INTO albums (id, slug, title, date, folder_id, hidden, sort, downloads_off, views, downloads, created_at)
		VALUES (CASE WHEN EXISTS (SELECT 1 FROM albums WHERE id = ?) THEN NULL ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(a.id, a.id, slug, a.title, a.date, folderOk ? a.folder_id : null, folderOk ? a.hidden : 1,
			a.sort, a.downloads_off, a.views, a.downloads, a.created_at).run();
	const albumId = r.meta.last_row_id;
	await runBatches(env, data.photos.map(p => photoInsert(env, p, albumId)));
	await env.DB.batch([
		env.DB.prepare('UPDATE albums SET cover_photo_id = (SELECT id FROM photos WHERE key = ?) WHERE id = ?').bind(data.cover_key, albumId),
		env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(id),
	]);
	return null;
}

// Removes trash items for good, with their files: the ones given, or all older than TRASH_DAYS.
// limit keeps one request's work small when the trash has piled up.
export async function purge(env, { ids = null, limit = 50 } = {}) {
	const results = ids
		? await selectIn(env, 'SELECT id, keys FROM trash WHERE id IN', ids)
		: (await env.DB.prepare('SELECT id, keys FROM trash WHERE deleted_at < ? LIMIT ?').bind(Date.now() - TRASH_DAYS * 86400 * 1000, limit).all()).results;
	if (!results.length) return 0;
	const files = results.flatMap(r => JSON.parse(r.keys).flatMap(filesOf));
	for (let i = 0; i < files.length; i += 1000) await env.PHOTOS.delete(files.slice(i, i + 1000));
	await runBatches(env, results.map(r => env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(r.id)));
	return results.length;
}

// Photo keys in the trash, so the storage recount does not take their files for leftovers.
export async function trashKeys(env) {
	const { results } = await env.DB.prepare('SELECT keys FROM trash').all();
	return results.flatMap(r => JSON.parse(r.keys));
}
