// Contract suite: the plugin against the real @deepseek-ai/dsh-web seam and
// the cordis runtime from devDependencies (the same packages a profile links
// as peers). A dsh-web change that breaks the seam fails here first. No
// network: the search goes to the loopback mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as plugin from '../../lib/index.js';
import { startMockSearchApi, SEARCHAPI_OK } from '../support/mock-searchapi.mjs';
import { withEnv } from '../support/ctx.mjs';

const require = createRequire(import.meta.url);
let host;
try {
  const [cordis, web, llm] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-web'),
    import('@deepseek-ai/dsh-llm'),
  ]);
  host = { Context: cordis.Context, WebRuntime: web.WebRuntime ?? web.default, WebError: web.WebError, HarnessError: llm.HarnessError };
} catch (error) {
  host = undefined;
  console.log(`# host packages not installed, contract suite skipped (${error.message})`);
}

const KEY = 'contract-key-1';

async function boot(webConfig, pluginConfig) {
  const root = new host.Context();
  await root.plugin(host.WebRuntime, webConfig);
  const fiber = root.plugin(plugin, pluginConfig);
  await fiber;
  return { root, fiber };
}

test('the pinned dsh-web seam has the surface this plugin uses', { skip: !host }, () => {
  const version = require('@deepseek-ai/dsh-web/package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof host.WebRuntime.prototype.registerSearchProvider, 'function');
  assert.equal(typeof host.WebRuntime.prototype.search, 'function');
  assert.ok(new host.WebError('m', 'C') instanceof host.HarnessError, 'WebError extends HarnessError');
  assert.equal(new host.WebError('m', 'C').code, 'C');
});

test('the plugin declares inject [web] and registers the "searchapi" provider the seam selects', { skip: !host }, async () => {
  assert.deepEqual(plugin.inject, ['web']);
  assert.equal(plugin.name, 'web-search-searchapi');
  const mock = await startMockSearchApi();
  const { root, fiber } = await boot({ searchProvider: 'searchapi' }, { apiKey: KEY, baseURL: mock.baseURL });
  try {
    assert.ok(root.web.searchProviders.has('searchapi'));
    const result = await root.web.search({ query: 'cordis' });
    assert.equal(mock.requests().length, 1);
    assert.equal(mock.requests()[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(result.sources.map((s) => s.url), SEARCHAPI_OK('cordis').json.organic_results.map((r) => r.link));
    assert.equal(result.truncated, false);
  } finally {
    await fiber.dispose();
    await mock.close();
  }
});

test('with no searchProvider pinned the seam auto-selects searchapi as the only usable provider', { skip: !host }, async () => {
  const mock = await startMockSearchApi();
  const { fiber, root } = await boot({}, { apiKey: KEY, baseURL: mock.baseURL });
  try {
    const result = await root.web.search({ query: 'solo' });
    assert.equal(result.sources.length, 3);
  } finally {
    await fiber.dispose();
    await mock.close();
  }
});

test('maxResults is honored end to end', { skip: !host }, async () => {
  const mock = await startMockSearchApi({ scenario: (r) => SEARCHAPI_OK(r.query.q, 7) });
  const { fiber, root } = await boot({ searchProvider: 'searchapi' }, { apiKey: KEY, baseURL: mock.baseURL });
  try {
    for (const max of [1, 3, 7, 9]) {
      const result = await root.web.search({ query: 'cap', maxResults: max });
      assert.equal(result.sources.length, Math.min(max, 7));
      assert.equal('num' in mock.requests().at(-1).query, false, 'num is never sent');
    }
  } finally {
    await fiber.dispose();
    await mock.close();
  }
});

test('errors are host WebError instances with their code intact', { skip: !host }, async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 401, json: { error: 'Invalid API key.' } }) });
  await withEnv('SEARCHAPI_API_KEY', undefined, async () => {
    const { fiber, root } = await boot({ searchProvider: 'searchapi' }, { apiKey: KEY, baseURL: mock.baseURL });
    try {
      await assert.rejects(root.web.search({ query: 'q' }), (e) => e instanceof host.WebError && e instanceof host.HarnessError && e.code === 'WEB_PROVIDER_ERROR' && e.status === 401);
    } finally {
      await fiber.dispose();
    }
    const { fiber: f2, root: r2 } = await boot({ searchProvider: 'searchapi' }, { baseURL: mock.baseURL });
    try {
      // No key anywhere: available() is false, so the seam refuses before calling search.
      await assert.rejects(r2.web.search({ query: 'q' }), (e) => e instanceof host.WebError && e.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE');
      assert.equal(mock.requests().length, 1, 'only the 401 search reached the mock');
    } finally {
      await f2.dispose();
      await mock.close();
    }
  });
});

test('disposing the plugin unregisters searchapi; the seam reports it missing', { skip: !host }, async () => {
  const mock = await startMockSearchApi();
  const { fiber, root } = await boot({ searchProvider: 'searchapi' }, { apiKey: KEY, baseURL: mock.baseURL });
  await fiber.dispose();
  try {
    await assert.rejects(root.web.search({ query: 'gone' }), (e) => e instanceof host.WebError && e.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
    assert.equal(mock.requests().length, 0);
  } finally {
    await mock.close();
  }
});
