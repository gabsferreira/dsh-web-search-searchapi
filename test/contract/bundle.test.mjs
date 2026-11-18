// Contract suite for the installable bundle: package.json declares dsh.bundle,
// and a real dsh composes the package's cordis.patch.yml into a profile exactly
// as `dsh plugin add` leaves it (package in the profile's node_modules, name in
// dsh.profile.bundles): the web row is pinned to `searchapi` and exactly one
// web-search-searchapi row names this package with apiKeyEnv SEARCHAPI_API_KEY.
//
// Needs a dsh install: DSH_BIN=<path to dsh's lib/bin.js>. Skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const DSH_BIN = process.env.DSH_BIN ? resolve(process.env.DSH_BIN) : undefined;
if (!DSH_BIN) console.log('# DSH_BIN not set, bundle suite skipped');

function dsh(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [DSH_BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (status) => done({ status, stdout, stderr }));
  });
}

/** A private DSH_HOME whose headless profile has this package installed as a bundle. */
async function composedProfile() {
  const root = mkdtempSync(join(tmpdir(), 'searchapi-bundle-'));
  const dshHome = join(root, '.dsh');
  const dir = join(dshHome, 'profiles', 'headless');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(ROOT, join(dir, 'node_modules', manifest.name));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-headless',
    private: true,
    dependencies: { [manifest.name]: 'link:' + ROOT },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', manifest.name] } },
  }));
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n');
  const env = { PATH: process.env.PATH ?? '', HOME: root, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' };
  try {
    const dump = await dsh(['--profile', 'headless', '--dump-config'], env);
    assert.equal(dump.status, 0, 'dsh --dump-config failed:\n' + dump.stderr);
    const YAML = createRequire(join(dirname(DSH_BIN), '..', 'package.json'))('yaml');
    return { tree: YAML.parse(dump.stdout), text: dump.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rowsOf = (tree, id) => tree.filter((row) => row && row.id === id);

test('package.json declares an installable dsh.bundle whose patch ships in the tarball', () => {
  assert.deepEqual(manifest.dsh?.bundle, { patch: './cordis.patch.yml' });
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.equal(manifest.dependencies, undefined, 'official packages are peers, not dependencies');
  assert.ok(manifest.keywords.includes('dsh-plugin'));
  const layer = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(layer, /apiKey:/, 'the bundle layer carries no literal key');
  assert.match(layer, /searchProvider: searchapi/);
  assert.match(layer, /apiKeyEnv: SEARCHAPI_API_KEY/);
});

test('the real dsh composes the bundle: web pinned to searchapi, one web-search-searchapi row by package name', { skip: !DSH_BIN }, async () => {
  const { tree, text } = await composedProfile();
  const web = rowsOf(tree, 'web');
  assert.equal(web.length, 1);
  assert.deepEqual(web[0].config, { searchProvider: 'searchapi', fetchProvider: 'http' });
  assert.match(text, new RegExp(`patched by ${manifest.name}`));
  const rows = rowsOf(tree, 'web-search-searchapi');
  assert.equal(rows.length, 1, 'exactly one web-search-searchapi row');
  assert.equal(rows[0].name, manifest.name);
  assert.deepEqual(rows[0].config, { apiKeyEnv: 'SEARCHAPI_API_KEY' });
  assert.equal(rowsOf(tree, 'web-search-deepseek').length, 1, 'the official provider row is still there, just not selected');
});
