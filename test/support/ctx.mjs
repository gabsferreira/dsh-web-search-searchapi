// A minimal stand-in for the cordis Context the plugin receives: a `web`
// registry and `get('credentials')`. The contract suite uses the real one.
import * as plugin from '../../lib/index.js';

export function fakeContext({ credentials } = {}) {
  const providers = new Map();
  return {
    providers,
    web: {
      registerSearchProvider(provider) {
        if (providers.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`);
        providers.set(provider.id, provider);
        return () => providers.delete(provider.id);
      },
    },
    get(name) {
      return name === 'credentials' ? credentials : undefined;
    },
  };
}

/** Apply the plugin on a fake context and return the registered provider. */
export function bootProvider(config = {}, options = {}) {
  const ctx = fakeContext(options);
  plugin.apply(ctx, config);
  return { ctx, provider: ctx.providers.get(plugin.SEARCHAPI_PROVIDER_ID) };
}

/** Run `fn` with `process.env[name]` set (or deleted when `value` is undefined). */
export async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}
