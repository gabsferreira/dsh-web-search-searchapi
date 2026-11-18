import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorDetail } from '../../lib/index.js';
import { bootProvider } from '../support/ctx.mjs';
import { startMockSearchApi } from '../support/mock-searchapi.mjs';

const KEY = 'secret-key-xyz';
const isWebError = (code) => (e) => e.name === 'WebError' && e.code === code;

test('HTTP 401 with the SearchApi error body: status and message, never the key', async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 401, json: { error: 'Invalid API key.' } }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    await assert.rejects(provider.search({ query: 'q' }), (e) => {
      assert.equal(e.name, 'WebError');
      assert.equal(e.code, 'WEB_PROVIDER_ERROR');
      assert.equal(e.status, 401);
      assert.equal(e.message, 'SearchApi returned HTTP 401: Invalid API key.');
      return true;
    });
  } finally {
    await mock.close();
  }
});

test('a non-JSON error body is not echoed', async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 503, text: '<html>upstream exploded</html>' }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    await assert.rejects(provider.search({ query: 'q' }), (e) => e.code === 'WEB_PROVIDER_ERROR' && e.status === 503 && e.message === 'SearchApi returned HTTP 503');
  } finally {
    await mock.close();
  }
});

test('an upstream error that echoes the key is redacted and clipped', async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 400, json: { error: `bad key ${KEY} ` + 'x'.repeat(500) } }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    await assert.rejects(provider.search({ query: 'q' }), (e) => !e.message.includes(KEY) && e.message.includes('[redacted]') && e.message.length < 260);
    assert.equal(apiErrorDetail('{"error": 42}'), undefined);
    assert.equal(apiErrorDetail('nope'), undefined);
    assert.equal(apiErrorDetail('{"error": "  "}'), undefined);
  } finally {
    await mock.close();
  }
});

test('a 200 with an unparseable body is WEB_PROVIDER_ERROR, not a SyntaxError', async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 200, text: '<html>not json</html>' }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    await assert.rejects(provider.search({ query: 'q' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && /unparseable/.test(e.message) && !(e instanceof SyntaxError));
  } finally {
    await mock.close();
  }
});

test('timeout names the limit, whether it lands before or during the body', async () => {
  const slowHead = await startMockSearchApi({ scenario: () => ({ status: 200, delayMs: 200, json: { organic_results: [] } }) });
  const slowBody = await startMockSearchApi({ scenario: () => ({ status: 200, bodyDelayMs: 200, json: { organic_results: [] } }) });
  try {
    for (const mock of [slowHead, slowBody]) {
      const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL, timeoutMs: 50 });
      await assert.rejects(provider.search({ query: 'q' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && e.message.includes('timed out after 50ms'));
    }
  } finally {
    await slowHead.close();
    await slowBody.close();
  }
});

test('caller abort is WEB_ABORTED with the reason as cause', async () => {
  const mock = await startMockSearchApi({ scenario: () => ({ status: 200, delayMs: 200, json: { organic_results: [] } }) });
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    const controller = new AbortController();
    const pending = provider.search({ query: 'q' }, controller.signal);
    setTimeout(() => controller.abort(new Error('user cancelled')), 20);
    await assert.rejects(pending, (e) => isWebError('WEB_ABORTED')(e) && e.cause?.message === 'user cancelled');

    const already = new AbortController();
    already.abort('early');
    await assert.rejects(provider.search({ query: 'q' }, already.signal), isWebError('WEB_ABORTED'));
    assert.equal(mock.requests().length, 1, 'an already-aborted search never leaves the process');
  } finally {
    await mock.close();
  }
});

test('invalid config fails before any request', async () => {
  const mock = await startMockSearchApi();
  try {
    for (const timeoutMs of ['soon', -1, 0, NaN, {}]) {
      const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL, timeoutMs });
      await assert.rejects(provider.search({ query: 'q' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && e.message.includes('timeoutMs') && !(e instanceof TypeError));
    }
    const numeric = bootProvider({ apiKey: KEY, baseURL: mock.baseURL, timeoutMs: '5000' }).provider;
    await numeric.search({ query: 'q' });
    const badURL = bootProvider({ apiKey: KEY, baseURL: 'not a url' }).provider;
    await assert.rejects(badURL.search({ query: 'q' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && e.message.includes('baseURL'));
    const empty = bootProvider({ apiKey: KEY, baseURL: mock.baseURL }).provider;
    await assert.rejects(empty.search({ query: '   ' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && e.message.includes('query'));
    assert.equal(mock.requests().length, 1, 'only the numeric-string timeout reached the mock');
  } finally {
    await mock.close();
  }
});

test('a refused connection is WEB_PROVIDER_ERROR with the key redacted', async () => {
  const mock = await startMockSearchApi();
  const dead = mock.baseURL;
  await mock.close();
  const { provider } = bootProvider({ apiKey: KEY, baseURL: dead });
  await assert.rejects(provider.search({ query: 'q' }), (e) => isWebError('WEB_PROVIDER_ERROR')(e) && e.message.startsWith('SearchApi search request failed') && !e.message.includes(KEY));
});
