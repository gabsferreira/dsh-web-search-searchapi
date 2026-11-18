import test from 'node:test';
import assert from 'node:assert/strict';
import { bootProvider, withEnv } from '../support/ctx.mjs';
import { startMockSearchApi } from '../support/mock-searchapi.mjs';

const ENV = 'SEARCHAPI_API_KEY';
const credentialsWith = (refs) => ({ async resolve(ref) { return ref in refs ? { value: refs[ref] } : undefined; } });

test('a literal apiKey wins over the credentials service and the environment', async () => {
  const mock = await startMockSearchApi();
  try {
    await withEnv(ENV, 'from-env', async () => {
      const { provider } = bootProvider({ apiKey: 'literal', baseURL: mock.baseURL }, { credentials: credentialsWith({ [ENV]: 'from-store' }) });
      await provider.search({ query: 'q' });
      assert.equal(mock.requests()[0].headers.authorization, 'Bearer literal');
    });
  } finally {
    await mock.close();
  }
});

test('the credentials service is asked for apiKeyEnv before the environment', async () => {
  const mock = await startMockSearchApi();
  try {
    await withEnv('MY_REF', 'from-env', async () => {
      const { provider } = bootProvider({ apiKeyEnv: 'MY_REF', baseURL: mock.baseURL }, { credentials: credentialsWith({ MY_REF: ' from-store ' }) });
      await provider.search({ query: 'q' });
      assert.equal(mock.requests()[0].headers.authorization, 'Bearer from-store');
    });
  } finally {
    await mock.close();
  }
});

test('the environment is the fallback when the store has no value', async () => {
  const mock = await startMockSearchApi();
  try {
    await withEnv(ENV, ' from-env ', async () => {
      const { provider } = bootProvider({ baseURL: mock.baseURL }, { credentials: credentialsWith({}) });
      await provider.search({ query: 'q' });
      assert.equal(mock.requests()[0].headers.authorization, 'Bearer from-env');
    });
  } finally {
    await mock.close();
  }
});

test('no key anywhere: WEB_PROVIDER_CREDENTIAL_MISSING naming apiKeyEnv, and no request', async () => {
  const mock = await startMockSearchApi();
  try {
    await withEnv(ENV, undefined, async () => {
      const { provider } = bootProvider({ baseURL: mock.baseURL });
      await assert.rejects(provider.search({ query: 'q' }), (e) => e.name === 'WebError' && e.code === 'WEB_PROVIDER_CREDENTIAL_MISSING' && e.message.includes(ENV));
      assert.equal(mock.requests().length, 0);
    });
  } finally {
    await mock.close();
  }
});

test('available() is truthful and synchronous', async () => {
  await withEnv(ENV, undefined, async () => {
    assert.equal(bootProvider({}).provider.available(), false);
    assert.equal(bootProvider({ apiKey: 'k' }).provider.available(), true);
    assert.equal(bootProvider({}, { credentials: credentialsWith({}) }).provider.available(), true, 'a mounted credentials service may hold the key');
    assert.equal(bootProvider({ apiKey: '   ' }).provider.available(), false, 'blank literal is no key');
  });
  await withEnv(ENV, 'k', async () => {
    assert.equal(bootProvider({}).provider.available(), true);
  });
  await withEnv('OTHER_REF', 'k', async () => {
    assert.equal(bootProvider({ apiKeyEnv: 'OTHER_REF' }).provider.available(), true);
    assert.equal(bootProvider({}).provider.available(), false);
  });
});
