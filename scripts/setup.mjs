#!/usr/bin/env node
// One-command setup on your own Cloudflare account: node scripts/setup.mjs
// Creates the D1 database and R2 bucket, writes wrangler.toml, creates the tables and the Pages project,
// asks for the admin password (typed into Wrangler, never stored here) and deploys.
// Needs Node 18+, `npx wrangler login` done once, and R2 enabled in the Cloudflare dashboard.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question, fallback) {
	const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
	return answer || fallback;
}

// Runs wrangler in the project folder. capture: return its output instead of showing it.
function wrangler(args, { capture = false } = {}) {
	console.log(`\n> npx wrangler ${args.join(' ')}`);
	const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
		cwd: root,
		shell: process.platform === 'win32',
		stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
		encoding: 'utf8',
	});
	if (capture) process.stdout.write(r.stdout || '');
	if (r.status !== 0) throw new Error(`wrangler ${args[0]} ${args[1] || ''} failed`);
	return r.stdout || '';
}

const name = (await ask('Project name (becomes <name>.pages.dev, lowercase letters, digits, dashes)', 'tinygallery')).toLowerCase();
if (!/^[a-z0-9][a-z0-9-]{0,56}$/.test(name)) throw new Error('Use lowercase letters, digits and dashes');
const site = await ask('Site name shown on the pages', 'Tiny Gallery');
const repo = await ask('Source link in the footer (empty to hide)', '');
rl.close();

const created = wrangler(['d1', 'create', name], { capture: true });
const id = created.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] || created.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];
if (!id) throw new Error('Could not read the new database id from Wrangler');
wrangler(['r2', 'bucket', 'create', name]);

const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8')
	.replace(/^name = ".*"$/m, `name = "${name}"`)
	.replace(/^PHOTOGRAPHER = ".*"$/m, `PHOTOGRAPHER = ${JSON.stringify(site)}`)
	.replace(/^REPO_URL = ".*"$/m, repo ? `REPO_URL = ${JSON.stringify(repo)}` : '# REPO_URL = ""')
	.replace(/^database_name = ".*"$/m, `database_name = "${name}"`)
	.replace(/^database_id = ".*"$/m, `database_id = "${id}"`)
	.replace(/^bucket_name = ".*"$/m, `bucket_name = "${name}"`);
writeFileSync(join(root, 'wrangler.toml'), toml);
console.log('\nwrangler.toml updated.');

wrangler(['d1', 'execute', name, '--remote', '--file', 'schema.sql', '-y']);
// --force creates a classic Pages project with a <name>.pages.dev address.
wrangler(['pages', 'project', 'create', name, '--production-branch', 'main', '--force']);
console.log('\nChoose the admin password. You type it into Wrangler; it is stored encrypted at Cloudflare.');
wrangler(['pages', 'secret', 'put', 'ADMIN_PASSWORD', '--project-name', name]);
wrangler(['pages', 'deploy', '--project-name', name, '--branch', 'main']);

console.log(`\nDone. Open https://${name}.pages.dev/admin and log in (the first deploy can take a minute to appear).`);
