import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchApiSearchProvider, isGotoLink, resolveGotoLinks, linkMode, DEFAULTS } from '../../lib/index.js';
import { bootProvider } from '../support/ctx.mjs';
import { startMockSearchApi } from '../support/mock-searchapi.mjs';

const KEY = 'links-key';

/** A provider wired to the mock, treating the mock's /goto links as Google's. */
function providerFor(mock, overrides = {}) {
  return new SearchApiSearchProvider(() => ({
    apiKey: KEY,
    apiKeyEnv: DEFAULTS.apiKeyEnv,
    baseURL: mock.baseURL,
    engine: 'google',
    timeoutMs: DEFAULTS.timeoutMs,
    resolveLinks: true,
    linkTimeoutMs: 500,
    redirectLink: mock.redirectLink,
    resolveApiKey: async () => KEY,
    ...overrides,
  }));
}

const payload = (mock, links) => ({ status: 200, json: { organic_results: links.map((link, i) => ({ link, title: `t${i}` })) } });

test('isGotoLink matches Google goto links only', () => {
  assert.equal(isGotoLink('https://www.google.com/goto?url=CAESYQ'), true);
  assert.equal(isGotoLink('http://google.com/goto?url=x'), true);
  assert.equal(isGotoLink('https://www.google.com.br/goto?url=x'), true);
  assert.equal(isGotoLink('https://www.google.com/search?q=goto'), false);
  assert.equal(isGotoLink('https://example.com/goto?url=x'), false);
});

test('goto links are followed one hop, in parallel, and plain links are left alone', async () => {
  const mock = await startMockSearchApi({ scenario: (r) => r.url.pathname === '/goto' ? undefined : payload(mock, [mock.gotoURL('a'), 'https://plain.example/p', mock.gotoURL('b')]) });
  try {
    const result = await providerFor(mock).search({ query: 'q' });
    assert.deepEqual(result.sources.map((s) => s.url), ['https://resolved.example/a', 'https://plain.example/p', 'https://resolved.example/b']);
    assert.deepEqual(result.sources.map((s) => s.title), ['t0', 't1', 't2'], 'titles and order survive');
    assert.equal(mock.gotos().length, 2);
    assert.equal(mock.gotos()[0].method, 'GET');
    assert.match(mock.gotos()[0].headers['user-agent'], /^dsh-web-search-searchapi\//);
  } finally {
    await mock.close();
  }
});

test('a goto link that answers late, without a redirect, or with a bad target is kept as it came', async () => {
  const mock = await startMockSearchApi({
    scenario: () => payload(mock, [mock.gotoURL('slow'), mock.gotoURL('plain200'), mock.gotoURL('relative'), mock.gotoURL('ftp'), mock.gotoURL('ok')]),
    goto: (r) => {
      switch (r.query.url) {
        case 'slow': return { status: 302, location: 'https://resolved.example/slow', delayMs: 300 };
        case 'plain200': return { status: 200, text: '<html>interstitial</html>' };
        case 'relative': return { status: 302, location: '/elsewhere' };
        case 'ftp': return { status: 302, location: 'ftp://files.example/x' };
        default: return { status: 302, location: 'https://resolved.example/ok' };
      }
    },
  });
  try {
    const t = Date.now();
    const result = await providerFor(mock, { linkTimeoutMs: 100 }).search({ query: 'q' });
    assert.ok(Date.now() - t < 280, 'the slow link is cut by its own timeout, not waited for');
    assert.deepEqual(result.sources.map((s) => s.url), [
      mock.gotoURL('slow'),
      mock.gotoURL('plain200'),
      `${new URL(mock.baseURL).origin}/elsewhere`,
      mock.gotoURL('ftp'),
      'https://resolved.example/ok',
    ]);
  } finally {
    await mock.close();
  }
});

test('two goto links to the same page collapse into one source', async () => {
  const mock = await startMockSearchApi({ scenario: () => payload(mock, [mock.gotoURL('same'), mock.gotoURL('same2')]), goto: () => ({ status: 302, location: 'https://resolved.example/same' }) });
  try {
    const result = await providerFor(mock).search({ query: 'q' });
    assert.deepEqual(result.sources.map((s) => s.url), ['https://resolved.example/same']);
  } finally {
    await mock.close();
  }
});

test('resolveLinks: false sends no extra request', async () => {
  const mock = await startMockSearchApi({ scenario: () => payload(mock, [mock.gotoURL('a')]) });
  try {
    const result = await providerFor(mock, { resolveLinks: false }).search({ query: 'q' });
    assert.deepEqual(result.sources.map((s) => s.url), [mock.gotoURL('a')]);
    assert.equal(mock.gotos().length, 0);
  } finally {
    await mock.close();
  }
});

test('a caller abort during link resolution is WEB_ABORTED', async () => {
  const mock = await startMockSearchApi({ scenario: () => payload(mock, [mock.gotoURL('a')]), goto: () => ({ status: 302, location: 'https://resolved.example/a', delayMs: 300 }) });
  try {
    const controller = new AbortController();
    const pending = providerFor(mock, { linkTimeoutMs: 1000 }).search({ query: 'q' }, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 60);
    await assert.rejects(pending, (e) => e.name === 'WebError' && e.code === 'WEB_ABORTED');
  } finally {
    await mock.close();
  }
});

test('invalid linkTimeoutMs fails before any request; ignored when resolveLinks is off', async () => {
  const mock = await startMockSearchApi();
  try {
    await assert.rejects(providerFor(mock, { linkTimeoutMs: 'later' }).search({ query: 'q' }), (e) => e.code === 'WEB_PROVIDER_ERROR' && e.message.includes('linkTimeoutMs'));
    assert.equal(mock.requests().length, 0);
    await providerFor(mock, { linkTimeoutMs: 'later', resolveLinks: false }).search({ query: 'q' });
    assert.equal(mock.searches().length, 1);
  } finally {
    await mock.close();
  }
});

test('through apply(): the default predicate is Google goto, so example.com links trigger nothing', async () => {
  const mock = await startMockSearchApi();
  try {
    const { provider } = bootProvider({ apiKey: KEY, baseURL: mock.baseURL });
    const result = await provider.search({ query: 'q' });
    assert.equal(result.sources.length, 3);
    assert.equal(mock.gotos().length, 0);
    const kept = await resolveGotoLinks([{ url: 'https://plain.example/' }], { timeoutMs: 10 });
    assert.deepEqual(kept, [{ url: 'https://plain.example/' }]);
  } finally {
    await mock.close();
  }
});

test("resolveLinks: 'api' sends link=resolved and follows nothing itself", async () => {
  const mock = await startMockSearchApi({ scenario: () => payload(mock, [mock.gotoURL('a')]) });
  try {
    const result = await providerFor(mock, { resolveLinks: 'api', linkTimeoutMs: 'ignored' }).search({ query: 'q' });
    assert.equal(mock.searches()[0].query.link, 'resolved');
    assert.equal(mock.gotos().length, 0);
    assert.deepEqual(result.sources.map((s) => s.url), [mock.gotoURL('a')], 'whatever SearchApi returned is passed through');
  } finally {
    await mock.close();
  }
});

test('linkMode: true/undefined mean local, false/off mean off, api means api', () => {
  assert.equal(linkMode(undefined), 'local');
  assert.equal(linkMode(true), 'local');
  assert.equal(linkMode('local'), 'local');
  assert.equal(linkMode(false), 'off');
  assert.equal(linkMode('off'), 'off');
  assert.equal(linkMode('api'), 'api');
});
