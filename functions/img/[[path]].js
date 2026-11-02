// /img/<key>/<t|d|o>  thumb, display or original. Add ?dl to download the original.
// Keys are 20 random characters, so a photo can only be found through a page that lists it.
export async function onRequestGet({ params, request, env, waitUntil }) {
	const [key, size] = params.path || [];
	if (!/^[A-Za-z0-9]{20}$/.test(key || '') || !['t', 'd', 'o'].includes(size)) {
		return new Response('Not found', { status: 404 });
	}

	// Edge cache first: files never change under a key, so a cached copy saves an R2 read.
	const cache = caches.default;
	const cached = await cache.match(request);
	if (cached) return cached;

	const obj = await env.PHOTOS.get(`${key}/${size}`);
	if (!obj) return new Response('Not found', { status: 404 });

	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', 'public, max-age=31536000, immutable');

	if (new URL(request.url).searchParams.has('dl')) {
		// The database has the original file name, so downloads keep it even if R2 metadata is lost (copies, migrations).
		const row = await env.DB.prepare('SELECT name FROM photos WHERE key = ?').bind(key).first();
		const name = row?.name || obj.customMetadata?.name || `${key}.jpg`;
		const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
		headers.set('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
	}

	const response = new Response(obj.body, { headers });
	if (request.method === 'GET') waitUntil(cache.put(request, response.clone()));
	return response;
}

export const onRequestHead = onRequestGet;
