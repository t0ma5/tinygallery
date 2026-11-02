// Public page data, shared by the API and the link-preview (Open Graph) pages.
// Each function returns null when the page does not exist or the visitor may not see it, and
// { locked: true } or { expired: true } for a private folder behind a password or past its expiry date.
import { folderUnlocked } from './util.js';

// Album card fields, with the cover photo key (chosen cover, or the first photo).
export const ALBUM_SQL = `
	SELECT a.id, a.slug, a.title, a.date, a.folder_id, a.hidden, a.cover_photo_id, a.sort,
		a.downloads_off, a.views, a.downloads,
		(SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS count,
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

export async function homeData(env) {
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id IS NULL AND a.hidden = 0${ALBUM_ORDER}`).all();
	const albums = results.filter(r => r.count > 0).map(card);
	// The chosen cover counts only while its album is still public.
	const chosen = await env.DB.prepare(`
		SELECT p.key FROM settings s
		JOIN photos p ON p.id = CAST(s.value AS INTEGER)
		JOIN albums a ON a.id = p.album_id
		WHERE s.key = 'home_cover' AND a.folder_id IS NULL AND a.hidden = 0`).first();
	return { ...(await base(env)), cover: chosen?.key || albums[0]?.cover || null, albums };
}

export async function folderData(env, request, token) {
	const open = await openFolder(env, request, token);
	if (!open) return null;
	if (open.status !== 'ok') return { ...(await base(env)), [open.status]: true };
	const f = open.folder;
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id = ? AND a.hidden = 0${ALBUM_ORDER}`).bind(f.id).all();
	const albums = results.filter(r => r.count > 0).map(card);
	if (!albums.length) return null;
	const chosen = await env.DB.prepare(`
		SELECT p.key FROM photos p JOIN albums a ON a.id = p.album_id
		WHERE p.id = ? AND a.folder_id = ? AND a.hidden = 0`).bind(f.cover_photo_id, f.id).first();
	return { ...(await base(env)), title: f.title, cover: chosen?.key || albums[0].cover, albums };
}

// Public albums open for everyone, folder albums only through their folder's link. isAdmin sees all.
export async function albumData(env, request, slug, token, isAdmin = false) {
	const a = await env.DB.prepare(`
		SELECT a.id, a.title, a.date, a.folder_id, a.hidden, a.cover_photo_id, a.downloads_off, f.token
		FROM albums a LEFT JOIN folders f ON f.id = a.folder_id
		WHERE a.slug = ?`).bind(slug).first();
	if (!a) return null;

	let folder = null;
	if (a.folder_id !== null && token === a.token) {
		const open = await openFolder(env, request, token);
		if (open.status !== 'ok' && !isAdmin) return { ...(await base(env)), [open.status]: true };
		folder = open.folder;
	}
	const allowed = a.folder_id === null ? !a.hidden : !a.hidden && folder;
	if (!allowed && !isAdmin) return null;

	const { results: photos } = await env.DB.prepare(
		'SELECT id, key, name, w, h FROM photos WHERE album_id = ? ORDER BY sort, id').bind(a.id).all();
	const cover = photos.find(p => p.id === a.cover_photo_id) || photos[0];
	return {
		...(await base(env)),
		album: { slug, title: a.title, date: a.date, cover: cover?.key || null },
		photos: photos.map(p => ({ key: p.key, name: p.name, w: p.w, h: p.h })),
		back: folder ? `/f/${a.token}` : '/',
		downloads: !a.downloads_off && !folder?.downloads_off,
		// Favourites are for clients, so only inside a private folder.
		favorites: !!folder,
	};
}

// Whether the original of a photo may be served (download and full-resolution zoom).
export async function downloadsAllowed(env, key) {
	const r = await env.DB.prepare(`
		SELECT a.downloads_off AS album_off, f.downloads_off AS folder_off
		FROM photos p JOIN albums a ON a.id = p.album_id LEFT JOIN folders f ON f.id = a.folder_id
		WHERE p.key = ?`).bind(key).first();
	return !r || (!r.album_off && !r.folder_off);
}
