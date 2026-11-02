#!/usr/bin/env node
// API checks against a running local copy: start `npx wrangler pages dev public --port 8788` in one terminal,
// then `npm test` in another. Reads ADMIN_PASSWORD from .dev.vars. Never point this at a live site:
// it creates and deletes albums, a folder and photos, and logs every admin session out at the end.
// It only removes what it created itself.
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
	console.error('Only for a local server (http://127.0.0.1 or http://localhost).');
	process.exit(1);
}
const PASSWORD = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!PASSWORD) throw new Error('ADMIN_PASSWORD missing in .dev.vars');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` (${detail})` : ''}`);
	console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

// Cookie jars: the admin, and a visitor.
const jars = { admin: new Map(), visitor: new Map() };
async function req(path, { method = 'GET', body, jar = 'admin', headers = {}, raw } = {}) {
	const h = { ...headers };
	const cookies = jars[jar] ? [...jars[jar]].map(([k, v]) => `${k}=${v}`).join('; ') : '';
	if (cookies) h.cookie = cookies;
	if (body !== undefined && !raw) h['content-type'] = 'application/json';
	if (path.startsWith('/api/admin/') && method !== 'GET' && !('x-admin' in h)) h['x-admin'] = '1';
	const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
	for (const c of res.headers.getSetCookie?.() || []) {
		const [pair] = c.split(';');
		const [k, v] = pair.split('=');
		if (jars[jar]) v ? jars[jar].set(k, v) : jars[jar].delete(k);
	}
	const type = res.headers.get('content-type') || '';
	return { status: res.status, data: type.includes('json') ? await res.json() : null };
}
const admin = (path, opts) => req(`/api/admin/${path}`, opts);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A "photo": any bytes pass, the server stores what the browser made. Each one gets its own fingerprint.
async function addPhoto(albumId, name, hash) {
	const start = await admin(`albums/${albumId}/photos`, { method: 'POST', body: { hash } });
	if (start.status !== 200) return start;
	const { key } = start.data;
	for (const size of ['t', 'd', 'o']) {
		await admin(`upload/${key}/${size}`, {
			method: 'PUT', raw: new Uint8Array(64).fill(size.charCodeAt(0)),
			headers: { 'content-type': 'image/jpeg', ...(size === 'o' ? { 'x-name': encodeURIComponent(name) } : {}) },
		});
	}
	return admin(`albums/${albumId}/photos/${key}`, { method: 'POST', body: { w: 1200, h: 800, hash } });
}
const hashOf = n => n.toString(16).padStart(64, '0');
const stamp = Date.now().toString(36);
const created = { albums: [], folder: null };

try {
	console.log(`Testing ${BASE}\n`);

	console.log('Admin login');
	check('state needs login', (await admin('state', { jar: null })).status === 401);
	check('wrong password refused', (await req('/api/admin/login', { method: 'POST', body: { password: 'wrong' }, jar: null })).status === 401);
	check('login works', (await req('/api/admin/login', { method: 'POST', body: { password: PASSWORD } })).status === 200);
	check('writes need the x-admin header', (await admin('albums', { method: 'POST', body: { title: 'x' }, headers: { 'x-admin': '0' } })).status === 400);

	console.log('\nAlbums, uploads and stored counts');
	const pub = (await admin('albums', { method: 'POST', body: { title: `Test public ${stamp}`, hidden: false } })).data;
	const hid = (await admin('albums', { method: 'POST', body: { title: `Test hidden ${stamp}`, hidden: true } })).data;
	created.albums.push(pub.id, hid.id);
	const p1 = await addPhoto(pub.id, 'one.jpg', hashOf(1));
	const p2 = await addPhoto(pub.id, 'two.jpg', hashOf(2));
	await addPhoto(hid.id, 'hidden.jpg', hashOf(3));
	check('upload finishes', p1.status === 200 && p2.status === 200, `${p1.status}/${p2.status}`);
	check('same file twice in an album is refused', (await admin(`albums/${pub.id}/photos`, { method: 'POST', body: { hash: hashOf(1) } })).data?.duplicate === true);
	check('same file in another album is allowed', (await admin(`albums/${hid.id}/photos`, { method: 'POST', body: { hash: hashOf(1) } })).status === 200);
	let st = (await admin('state')).data;
	check('stored photo count', st.albums.find(a => a.id === pub.id)?.count === 2);
	const home = (await req('/api/home', { jar: 'visitor' })).data;
	check('public album on the home page', home.albums.some(a => a.slug === pub.slug && a.count === 2));
	check('hidden album not on the home page', !home.albums.some(a => a.slug === hid.slug));
	check('hidden album closed to visitors', (await req(`/api/album/${hid.slug}`, { jar: 'visitor' })).status === 404);
	check('hidden album open to the admin', (await req(`/api/album/${hid.slug}`)).status === 200);
	check('photo files served', (await req(`/img/${p1.data.key}/t`, { jar: 'visitor' })).status === 200);

	console.log('\nPrivate folders');
	const folder = (await admin('folders', { method: 'POST', body: { title: `Test folder ${stamp}` } })).data;
	created.folder = folder.id;
	const inf = (await admin('albums', { method: 'POST', body: { title: `Test in folder ${stamp}`, folder_id: folder.id } })).data;
	created.albums.push(inf.id);
	const p4 = await addPhoto(inf.id, 'client.jpg', hashOf(4));
	check('folder album closed without the link', (await req(`/api/album/${inf.slug}`, { jar: 'visitor' })).status === 404);
	check('folder album open with the link', (await req(`/api/album/${inf.slug}?f=${folder.token}`, { jar: 'visitor' })).status === 200);
	check('folder page lists its album', (await req(`/api/f/${folder.token}`, { jar: 'visitor' })).data?.albums?.length === 1);
	await sleep(300);
	st = (await admin('state')).data;
	check('folder "last opened" recorded', !!st.folders.find(f => f.id === folder.id)?.last_viewed_at);

	await admin(`folders/${folder.id}`, { method: 'PATCH', body: { password: 'test1234' } });
	check('password locks the folder', (await req(`/api/f/${folder.token}`, { jar: 'visitor' })).status === 401);
	check('wrong folder password refused', (await req(`/api/f/${folder.token}/unlock`, { method: 'POST', body: { password: 'nope' }, jar: 'visitor' })).status === 401);
	check('right folder password unlocks', (await req(`/api/f/${folder.token}/unlock`, { method: 'POST', body: { password: 'test1234' }, jar: 'visitor' })).status === 200);
	check('unlocked folder opens', (await req(`/api/f/${folder.token}`, { jar: 'visitor' })).status === 200);
	await admin(`folders/${folder.id}`, { method: 'PATCH', body: { expires_at: '2000-01-01' } });
	check('expired link answers 410', (await req(`/api/f/${folder.token}`, { jar: 'visitor' })).status === 410);
	await admin(`folders/${folder.id}`, { method: 'PATCH', body: { expires_at: null, downloads_off: true } });
	check('downloads off blocks originals', (await req(`/img/${p4.data.key}/o?dl`, { jar: 'visitor' })).status === 403);
	check('downloads off still shows photos', (await req(`/img/${p4.data.key}/d`, { jar: 'visitor' })).status === 200);
	await admin(`folders/${folder.id}`, { method: 'PATCH', body: { downloads_off: false } });
	check('downloads on serves originals', (await req(`/img/${p4.data.key}/o?dl`, { jar: 'visitor' })).status === 200);

	console.log('\nFavourites');
	const client = 'TestClient' + 'abcdef';
	await req(`/api/f/${folder.token}/favorites`, { method: 'POST', body: { client, key: p4.data.key, on: true, name: 'Tester' }, jar: 'visitor' });
	check('favourite saved', (await req(`/api/f/${folder.token}/favorites?client=${client}`, { jar: 'visitor' })).data?.keys?.length === 1);
	await admin(`albums/${inf.id}`, { method: 'PATCH', body: { folder_id: null, hidden: true } });
	check('favourites go when the album leaves the folder', (await admin(`folders/${folder.id}/favorites`)).data?.photos?.length === 0);
	await admin(`albums/${inf.id}`, { method: 'PATCH', body: { folder_id: folder.id, hidden: false } });

	console.log('\nMove and trash');
	await admin('photos/move', { method: 'POST', body: { ids: [p2.data.id], album_id: inf.id } });
	st = (await admin('state')).data;
	check('move updates both counts', st.albums.find(a => a.id === pub.id)?.count === 1 && st.albums.find(a => a.id === inf.id)?.count === 2);
	await admin('photos/delete', { method: 'POST', body: { ids: [p1.data.id] } });
	st = (await admin('state')).data;
	const photoItem = st.trash.find(t => t.kind === 'photo' && t.key === p1.data.key);
	check('deleted photo is in the trash', !!photoItem);
	check('deleted photo leaves the count', st.albums.find(a => a.id === pub.id)?.count === 0);
	check('trashed original not served', (await req(`/img/${p1.data.key}/o?dl`, { jar: 'visitor' })).status === 403);
	check('photo restores', (await admin(`trash/${photoItem.id}/restore`, { method: 'POST' })).status === 200);
	st = (await admin('state')).data;
	check('restored photo counts again', st.albums.find(a => a.id === pub.id)?.count === 1);

	await admin(`albums/${inf.id}`, { method: 'DELETE' });
	st = (await admin('state')).data;
	const albumItem = st.trash.find(t => t.kind === 'album' && t.title === `Test in folder ${stamp}`);
	check('deleted album is in the trash with its photos', albumItem?.photos === 2);
	check('deleted album is gone from its folder', (await req(`/api/album/${inf.slug}?f=${folder.token}`, { jar: 'visitor' })).status === 404);
	check('album restores', (await admin(`trash/${albumItem.id}/restore`, { method: 'POST' })).status === 200);
	st = (await admin('state')).data;
	const back = st.albums.find(a => a.slug === inf.slug);
	check('restored album keeps its address, folder and photos', back?.folder_id === folder.id && back?.count === 2);

	await admin('photos/delete', { method: 'POST', body: { ids: [p4.data.id] } });
	st = (await admin('state')).data;
	const purgeItem = st.trash.find(t => t.key === p4.data.key);
	await admin(`trash/${purgeItem.id}`, { method: 'DELETE' });
	check('"Delete now" removes the files', (await req(`/img/${p4.data.key}/t?fresh=${stamp}`, { jar: 'visitor' })).status === 404);

	console.log('\nSessions');
	const visitorCopy = new Map(jars.admin);
	await admin('logout-all', { method: 'POST' });
	jars.visitor = visitorCopy; // the old admin cookie, as another device would still have it
	check('log out on all devices ends other sessions', (await req('/api/admin/state', { jar: 'visitor' })).status === 401);
	await req('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
} finally {
	// Clean up only what this run made: albums go to the trash, then their trash items are purged.
	try {
		for (const id of created.albums) await admin(`albums/${id}`, { method: 'DELETE' });
		if (created.folder) await admin(`folders/${created.folder}`, { method: 'DELETE' });
		const st = (await admin('state')).data;
		const mine = (st?.trash || []).filter(t => t.title?.includes(stamp) || ['one.jpg', 'two.jpg', 'hidden.jpg', 'client.jpg'].includes(t.title) && t.deleted_at > Date.now() - 600000);
		for (const t of mine) await admin(`trash/${t.id}`, { method: 'DELETE' });
	} catch (e) {
		console.error('Cleanup failed:', e.message);
	}
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	console.log(failures.map(f => `  - ${f}`).join('\n'));
	process.exit(1);
}
