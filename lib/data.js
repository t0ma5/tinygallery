// Public page data, shared by the API and the link-preview (Open Graph) pages.
// Every function returns null when the visitor may not see the page.

// Album card fields, with the cover photo key (chosen cover, or the first photo).
export const ALBUM_SQL = `
	SELECT a.id, a.slug, a.title, a.date, a.folder_id, a.hidden, a.cover_photo_id,
		(SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS count,
		COALESCE(
			(SELECT key FROM photos WHERE id = a.cover_photo_id AND album_id = a.id),
			(SELECT key FROM photos WHERE album_id = a.id ORDER BY sort, id LIMIT 1)
		) AS cover
	FROM albums a`;
export const ALBUM_ORDER = ' ORDER BY a.date DESC, a.id DESC';

// Site name from the admin settings, or the PHOTOGRAPHER default in wrangler.toml.
export async function siteName(env) {
	const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_name'").first();
	return r?.value || env.PHOTOGRAPHER;
}

const card = r => ({ slug: r.slug, title: r.title, date: r.date, count: r.count, cover: r.cover });

export async function homeData(env) {
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id IS NULL AND a.hidden = 0${ALBUM_ORDER}`).all();
	const albums = results.filter(r => r.count > 0).map(card);
	// The chosen cover counts only while its album is still public.
	const chosen = await env.DB.prepare(`
		SELECT p.key FROM settings s
		JOIN photos p ON p.id = CAST(s.value AS INTEGER)
		JOIN albums a ON a.id = p.album_id
		WHERE s.key = 'home_cover' AND a.folder_id IS NULL AND a.hidden = 0`).first();
	return { photographer: await siteName(env), cover: chosen?.key || albums[0]?.cover || null, albums };
}

export async function folderData(env, token) {
	const f = await env.DB.prepare('SELECT id, title, cover_photo_id FROM folders WHERE token = ?').bind(token).first();
	if (!f) return null;
	const { results } = await env.DB.prepare(`${ALBUM_SQL} WHERE a.folder_id = ? AND a.hidden = 0${ALBUM_ORDER}`).bind(f.id).all();
	const albums = results.filter(r => r.count > 0).map(card);
	if (!albums.length) return null;
	const chosen = await env.DB.prepare(`
		SELECT p.key FROM photos p JOIN albums a ON a.id = p.album_id
		WHERE p.id = ? AND a.folder_id = ? AND a.hidden = 0`).bind(f.cover_photo_id, f.id).first();
	return { photographer: await siteName(env), title: f.title, cover: chosen?.key || albums[0].cover, albums };
}

// Public albums open for everyone, folder albums only with their folder's token. isAdmin sees all.
export async function albumData(env, slug, token, isAdmin = false) {
	const a = await env.DB.prepare(`
		SELECT a.id, a.title, a.date, a.folder_id, a.hidden, a.cover_photo_id, f.token
		FROM albums a LEFT JOIN folders f ON f.id = a.folder_id
		WHERE a.slug = ?`).bind(slug).first();
	if (!a) return null;
	const allowed = a.folder_id === null ? !a.hidden : !a.hidden && token === a.token;
	if (!allowed && !isAdmin) return null;

	const { results: photos } = await env.DB.prepare(
		'SELECT id, key, name, w, h FROM photos WHERE album_id = ? ORDER BY sort, id').bind(a.id).all();
	const cover = photos.find(p => p.id === a.cover_photo_id) || photos[0];
	return {
		photographer: await siteName(env),
		album: { slug, title: a.title, date: a.date, cover: cover?.key || null },
		photos: photos.map(p => ({ key: p.key, name: p.name, w: p.w, h: p.h })),
		back: a.folder_id !== null && token === a.token ? `/f/${a.token}` : '/',
	};
}
