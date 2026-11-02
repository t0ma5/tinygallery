const enc = new TextEncoder();

export const json = (data, status = 200, headers = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
	});

export const fail = (error, status = 400) => json({ error }, status);

export const notFound = () => fail('Not found', 404);

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Unbiased base62 token from crypto random bytes.
export function randomToken(length) {
	let out = '';
	while (out.length < length) {
		for (const b of crypto.getRandomValues(new Uint8Array(length))) {
			if (b < 248 && out.length < length) out += B62[b % 62];
		}
	}
	return out;
}

export function slugify(title) {
	const s = title
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return s || 'album';
}

const b64url = buf =>
	btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256(text) {
	return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

// Compares hashes so the check takes the same time whatever the input length.
export async function passwordMatches(env, password) {
	if (!env.ADMIN_PASSWORD || typeof password !== 'string') return false;
	return safeEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD));
}

// The session key comes from the admin password, so changing the password logs out every session.
async function sessionKey(env) {
	const raw = await crypto.subtle.digest('SHA-256', enc.encode('tinygallery-session:' + env.ADMIN_PASSWORD));
	return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(env, value) {
	return b64url(await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(value)));
}

const SESSION_DAYS = 30;

export async function sessionCookie(env) {
	const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
	const value = `${exp}.${await sign(env, String(exp))}`;
	return `session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = 'session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

/* Folder passwords: PBKDF2 with few enough rounds to stay well inside the free plan's 10 ms CPU per request.
   Folder passwords guard client galleries, not accounts, so this is a fair trade. */

const FOLDER_ROUNDS = 10000;

const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function pbkdf2(password, salt, rounds) {
	const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
	return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256);
}

export async function hashFolderPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${FOLDER_ROUNDS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, FOLDER_ROUNDS))}`;
}

export async function folderPasswordMatches(stored, password) {
	if (typeof password !== 'string' || !stored) return false;
	const [, rounds, salt, hash] = stored.split('$');
	return safeEqual(b64url(await pbkdf2(password, fromB64url(salt), Number(rounds))), hash);
}

// The unlock cookie is signed with the folder's password hash, so a new password locks everyone out again.
const folderSignature = (env, f) => sign(env, `folder:${f.id}:${f.password_hash}`);

export async function folderCookie(env, f) {
	return `f${f.id}=${await folderSignature(env, f)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export async function folderUnlocked(request, env, f) {
	if (!f.password_hash) return true;
	const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)f${f.id}=([A-Za-z0-9_-]+)`));
	return !!m && safeEqual(await folderSignature(env, f), m[1]);
}

// Shared by the admin login and folder passwords: at most 10 wrong tries per IP in 15 minutes.
export async function tooManyAttempts(env, key) {
	const since = Date.now() - 15 * 60 * 1000;
	await env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(since).run();
	const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?').bind(key, since).first();
	return n >= 10;
}

export async function recordFailedAttempt(env, key) {
	await env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(key, Date.now()).run();
}

export async function isAdmin(request, env) {
	if (!env.ADMIN_PASSWORD) return false;
	const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)session=(\d+)\.([A-Za-z0-9_-]+)/);
	if (!m || Number(m[1]) < Date.now() / 1000) return false;
	return safeEqual(await sign(env, m[1]), m[2]);
}
