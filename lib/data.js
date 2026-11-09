// Public page data, shared by the API and the link-preview (Open Graph) pages.
// Each function returns null when the page does not exist or the visitor may not see it, and
// { locked: true } or { expired: true } for a private folder behind a password or past its expiry date.
import { folderUnlocked } from './util.js';

// Album card fields, with the cover photo key (chosen cover, or the first photo).
// The count is stored on the album (kept current by triggers): counting would read every photo row.
export const ALBUM_SQL = `
	SELECT a.id, a.slug, a.title, a.date, a.folder_id, a.hidden, a.cover_photo_id, a.sort,
		a.downloads_off, a.views, a.downloads,
		a.photo_count AS count,
		COALESCE(
			(SELECT key FROM photos WHERE id = a.cover_photo_id AND album_id = a.id),
			(SELECT key FROM photos WHERE album_id = a.id ORDER BY sort, id LIMIT 1)
		) AS cover
	FROM albums a`;
// Albums the admin placed by hand come in that order; new ones (sort 0) first, then by date.
export const ALBUM_ORDER = ' ORDER BY a.sort, a.date DESC, a.id DESC';

// Site name from the admin settings, or the PHOTOGRAPHER default in wrangler.toml.
export async function siteName(env) {
	const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_name'").first();
	return r?.value || env.PHOTOGRAPHER;
}

const card = r => ({ slug: r.slug, title: r.title, date: r.date, count: r.count, cover: r.cover });

// Fields every public page needs: site name and the optional source link for the footer.
async function base(env) {
	return { photographer: await siteName(env), repo: env.REPO_URL || '' };
}

const today = () => new Date().toISOString().slice(0, 10);

// A private folder by token, with what the visitor may do: 'ok', 'locked' (password) or 'expired'.
export async function openFolder(env, request, token) {
	if (!/^[A-Za-z0-9]{12}$/.test(token || '')) return null;
	const f = await env.DB.prepare(
		'SELECT id, title, cover_photo_id, password_hash, expires_at, downloads_off FROM folders WHERE token = ?').bind(token).first();
	if (!f) return null;
	if (f.expires_at && f.expires_at < today()) return { folder: f, status: 'expired' };
	if (!(await folderUnlocked(request, env, f))) return { folder: f, status: 'locked' };
	return { folder: f, status: 'ok' };
}

// Home cover photo ids: up to 5 in 'home_covers' (JSON).
export async function homeCoverIds(env) {
	const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'home_covers'").first();
	try { return r ? JSON.parse(r.value).map(Number).filter(Boolean) : []; } catch { return []; }
}

// The chosen home covers that are still in public albums: [{ id, key }].
export async function homeCoverPhotos(env) {
	const ids = await homeCoverIds(env);
	if (!ids.length) return [];
	const { results } = await env.DB.prepare(`
		SELECT p.id, p.key FROM photos p JOIN albums a ON a.id = p.album_id
		WHERE p.id IN (${ids.map(() => '?').join(', ')}) AND a.folder_id IS NULL AND a.hidden = 0`).bind(...ids).all();
	return results;
}

export async function homeData(env) {
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id IS NULL AND a.hidden = 0${ALBUM_ORDER}`).all();
	const albums = results.filter(r => r.count > 0).map(card);
	// One of the chosen covers at random on each visit; a cover counts only while its album is still public.
	const chosen = await homeCoverPhotos(env);
	const pick = chosen.length ? chosen[Math.floor(Math.random() * chosen.length)].key : null;
	return { ...(await base(env)), cover: pick || albums[0]?.cover || null, albums };
}

// isAdmin opens password-protected and expired folders too, so the admin can preview them.
export async function folderData(env, request, token, isAdmin = false) {
	const open = await openFolder(env, request, token);
	if (!open) return null;
	if (open.status !== 'ok' && !isAdmin) return { ...(await base(env)), [open.status]: true };
	const f = open.folder;
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id = ? AND a.hidden = 0${ALBUM_ORDER}`).bind(f.id).all();
	// A folder with no photos yet still opens (its link is often shared before the upload), with an empty list.
	const albums = results.filter(r => r.count > 0).map(card);
	const chosen = await env.DB.prepare(`
		SELECT p.key FROM photos p JOIN albums a ON a.id = p.album_id
		WHERE p.id = ? AND a.folder_id = ? AND a.hidden = 0`).bind(f.cover_photo_id, f.id).first();
	return { ...(await base(env)), title: f.title, cover: chosen?.key || albums[0]?.cover || null, albums };
}

// Public albums open for everyone, folder albums only through their folder's link. isAdmin sees all.
// withPhotos false skips the photo rows (link previews need only the count and cover): a big album is many rows read.
export async function albumData(env, request, slug, token, isAdmin = false, withPhotos = true) {
	const a = await env.DB.prepare(`
		SELECT a.id, a.title, a.date, a.folder_id, a.hidden, a.downloads_off, a.photo_count, f.token,
			COALESCE(
				(SELECT key FROM photos WHERE id = a.cover_photo_id AND album_id = a.id),
				(SELECT key FROM photos WHERE album_id = a.id ORDER BY sort, id LIMIT 1)
			) AS cover
		FROM albums a LEFT JOIN folders f ON f.id = a.folder_id
		WHERE a.slug = ?`).bind(slug).first();
	if (!a) return null;

	let folder = null;
	let unlocked = false;
	if (a.folder_id !== null && token === a.token) {
		const open = await openFolder(env, request, token);
		if (open.status !== 'ok' && !isAdmin) return { ...(await base(env)), [open.status]: true };
		folder = open.folder;
		unlocked = open.status === 'ok';
	}
	const allowed = a.folder_id === null ? !a.hidden : !a.hidden && folder;
	if (!allowed && !isAdmin) return null;

	const photos = withPhotos
		? (await env.DB.prepare('SELECT key, name, w, h FROM photos WHERE album_id = ? ORDER BY sort, id').bind(a.id).all()).results
		: null;
	return {
		...(await base(env)),
		album: { slug, title: a.title, date: a.date, cover: a.cover, count: a.photo_count },
		photos,
		back: folder ? `/f/${a.token}` : '/',
		downloads: !a.downloads_off && !folder?.downloads_off,
		// Favourites are for clients, so only inside a private folder they could open (not the admin's preview of a locked one).
		favorites: unlocked,
	};
}

// Whether the original of a photo may be served (download and full-resolution zoom).
// Only photos still in an album: files in the trash or of unfinished uploads are not served.
export async function downloadsAllowed(env, key) {
	const r = await env.DB.prepare(`
		SELECT a.downloads_off AS album_off, f.downloads_off AS folder_off
		FROM photos p JOIN albums a ON a.id = p.album_id LEFT JOIN folders f ON f.id = a.folder_id
		WHERE p.key = ?`).bind(key).first();
	return !!r && !r.album_off && !r.folder_off;
}
