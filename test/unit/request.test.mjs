import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENT, buildURL, DEFAULTS } from '../../lib/index.js';
import { bootProvider } from '../support/ctx.mjs';
import { startMockSearchApi } from '../support/mock-searchapi.mjs';

const KEY = 'unit-key-123';

test('one GET with engine and q; bearer key, accept and user-agent; no num, no link=resolved', async () => {
  const mock = await startMockSearchApi();
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    const result = await provider.search({ query: '  deepseek harness  ', maxResults: 8 });
    const [req] = mock.requests();
    assert.equal(mock.requests().length, 1);
    assert.equal(req.url.pathname, '/api/v1/search');
    assert.deepEqual(req.query, { engine: 'google', q: 'deepseek harness' });
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.headers['user-agent'], USER_AGENT);
    assert.match(USER_AGENT, /^dsh-web-search-searchapi\/\d+\.\d+\.\d+/);
    assert.equal(result.truncated, false);
    assert.equal(result.sources.length, 3);
    assert.deepEqual(result.sources[0], {
      url: 'https://example.com/deepseek%20harness/1',
      title: 'deepseek harness result 1',
      snippet: 'Snippet 1 about deepseek harness.',
      publishedAt: '2026-10-12',
    });
  } finally {
    await mock.close();
  }
});

test('gl, hl and engine are forwarded only when configured', async () => {
  const mock = await startMockSearchApi();
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL, gl: 'br', hl: 'pt', engine: 'bing' });
    await provider.search({ query: 'x' });
    assert.deepEqual(mock.requests()[0].query, { engine: 'bing', q: 'x', gl: 'br', hl: 'pt' });
    const url = buildURL({ baseURL: DEFAULTS.baseURL, engine: 'google' }, 'q');
    assert.equal(url.href, 'https://www.searchapi.io/api/v1/search?engine=google&q=q');
  } finally {
    await mock.close();
  }
});

test('maxResults caps the mapped sources without changing the request', async () => {
  const mock = await startMockSearchApi({ scenario: (r) => ({ status: 200, json: { organic_results: Array.from({ length: 10 }, (_, i) => ({ link: `https://e.com/${r.query.q}/${i}` })) } }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    const result = await provider.search({ query: 'cap', maxResults: 4 });
    assert.equal(result.sources.length, 4);
    assert.equal('num' in mock.requests()[0].query, false);
    const all = await provider.search({ query: 'cap' });
    assert.equal(all.sources.length, 10);
  } finally {
    await mock.close();
  }
});

test('config is re-read on every search, including reactive accessors', async () => {
  const mock = await startMockSearchApi();
  try {
    const gl = { value: 'us', get() { return this.value; } };
    const { provider } = bootProvider({ apiKey: { get: () => KEY }, baseURL: mock.baseURL, gl });
    await provider.search({ query: 'one' });
    gl.value = 'de';
    await provider.search({ query: 'two' });
    assert.equal(mock.requests()[0].query.gl, 'us');
    assert.equal(mock.requests()[1].query.gl, 'de');
  } finally {
    await mock.close();
  }
});

test('two in-flight searches keep their own results', async () => {
  const mock = await startMockSearchApi({ scenario: (r) => ({ status: 200, delayMs: r.query.q === 'slow' ? 60 : 0, json: { organic_results: [{ link: `https://e.com/${r.query.q}` }] } }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    const [slow, fast] = await Promise.all([provider.search({ query: 'slow' }), provider.search({ query: 'fast' })]);
    assert.equal(slow.sources[0].url, 'https://e.com/slow');
    assert.equal(fast.sources[0].url, 'https://e.com/fast');
  } finally {
    await mock.close();
  }
});
