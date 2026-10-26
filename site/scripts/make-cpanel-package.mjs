/**
 * Builds the site and packs what cPanel needs into whizperz-cpanel.tar.gz:
 * the built site, the start-up file and a production-only package.json.
 * Run by "Make cPanel upload.bat". Nothing secret goes in the package.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'cpanel-upload');
const archive = join(root, 'whizperz-cpanel.tar.gz');
const siteUrl = (process.env.SITE_URL || 'https://tours.whizperzpizza.co.ke').replace(/\/+$/, '');

console.log(`\n  Building the site for ${siteUrl} ...\n`);
execSync('npx astro build', { stdio: 'inherit', env: { ...process.env, SITE_URL: siteUrl } });

rmSync(out, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(root, 'passenger.cjs'), join(out, 'passenger.cjs'));
if (existsSync(join(root, 'package-lock.json'))) cpSync(join(root, 'package-lock.json'), join(out, 'package-lock.json'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Only what the running site needs; fonts are already built into the pages, and the Vercel adapter is only used on Vercel.
const runtime = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => !name.startsWith('@fontsource/') && name !== '@astrojs/vercel'));
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', main: 'passenger.cjs', scripts: { start: 'node passenger.cjs' }, dependencies: runtime, engines: pkg.engines }, null, 2),
);

execSync(`tar -czf "${archive}" -C "${out}" .`, { stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
console.log(`\n  Ready: ${archive}\n  Upload it in cPanel's File Manager and follow DEPLOY_CPANEL.md.\n`);
