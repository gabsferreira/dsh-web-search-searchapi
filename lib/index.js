// SearchApi search provider for the DeepSeek Harness web seam (ctx.web).
//
// Registers one search provider, `searchapi`. A `web_search` tool call that
// resolves to it does a single GET against SearchApi's Google engine and maps
// `organic_results[]` onto the seam's source shape. Dependency-free: the host's
// WebError class is resolved at runtime so tool results keep a structured code.
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
const { version: VERSION } = localRequire('../package.json');

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searchapi';
/** The web seam this provider registers into. */
export const inject = ['web'];
/** Stable id this provider registers under (`web.searchProvider: searchapi`). */
export const SEARCHAPI_PROVIDER_ID = 'searchapi';
/** Attribution header sent on every request. */
export const USER_AGENT = `dsh-web-search-searchapi/${VERSION}`;

export const DEFAULTS = Object.freeze({
  apiKeyEnv: 'SEARCHAPI_API_KEY',
  baseURL: 'https://www.searchapi.io/api/v1/search',
  engine: 'google',
  timeoutMs: 30000,
  resolveLinks: true,
  linkTimeoutMs: 3000,
});

/** Longest slice of a SearchApi error message that rides on a thrown error. */
const ERROR_DETAIL_MAX = 200;

// ---------------------------------------------------------------------------
// Host error class
//
// The seam and the tool layer keep `{name, code}` in a tool result only for
// the host's own `WebError` (a `HarnessError`). The package is resolved from
// this module first (the peer dependency the profile links next to the plugin),
// then from the dsh launcher (`<dsh>/lib/bin.js`, so `process.argv[1]`). When
// neither resolves, a local stand-in with the same `code` field is used.

let hostWebError;

class FallbackWebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'WebError';
    this.code = code;
  }
}

function hostErrorClass() {
  if (hostWebError !== undefined) return hostWebError;
  for (const from of [import.meta.url, process.argv[1]]) {
    if (!from) continue;
    try {
      const mod = createRequire(from)('@deepseek-ai/dsh-web');
      if (typeof mod?.WebError === 'function') {
        hostWebError = mod.WebError;
        return hostWebError;
      }
    } catch {
      /* not resolvable from here; try the next anchor */
    }
  }
  hostWebError = FallbackWebError;
  return hostWebError;
}

function webError(message, code, cause, status) {
  const Ctor = hostErrorClass();
  const error = new Ctor(message, code, cause === undefined ? undefined : { cause });
  if (status !== undefined) error.status = status;
  return error;
}

// ---------------------------------------------------------------------------
// Mapping

/**
 * A SearchApi `date` ("Oct 12, 2026") as an ISO-8601 calendar date. Relative
 * values ("2 days ago") and anything else that does not parse are dropped: the
 * seam documents `publishedAt` as provider-supplied ISO-8601, so no guessing.
 *
 * @param {unknown} value - the `date` field of one organic result.
 * @returns {string | undefined} `YYYY-MM-DD`, or undefined.
 */
export function isoDate(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // "Oct 12, 2026", "Sept. 8, 2024", "12 Oct 2026": the absolute forms Google shows.
  if (!/^(?:[A-Za-z]{3,9}\.? \d{1,2}, \d{4}|\d{1,2} [A-Za-z]{3,9}\.? \d{4})$/.test(text)) return undefined;
  const ms = Date.parse(`${text.replace('.', '')} UTC`);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Map a SearchApi payload onto the seam's source shape. Keeps `organic_results`
 * entries with a non-empty http(s) `link`, once per URL; `title`, `snippet` and
 * `publishedAt` are included only when present, so the result stays lossless
 * JSON for the tool layer. `maxResults`, when given, caps the list here as
 * well (the seam enforces it regardless).
 *
 * @param {unknown} data - parsed SearchApi response.
 * @param {number | undefined} maxResults - optional cap on returned sources.
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>}
 */
export function toSources(data, maxResults) {
  const results = data?.organic_results;
  const sources = [];
  if (!Array.isArray(results)) return sources;
  const cap = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : Infinity;
  const seen = new Set();

  for (const item of results) {
    if (sources.length >= cap) break;
    const url = typeof item?.link === 'string' ? item.link.trim() : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const source = { url };
    if (typeof item.title === 'string' && item.title.trim()) source.title = item.title.trim();
    if (typeof item.snippet === 'string' && item.snippet.trim()) source.snippet = item.snippet.trim();
    const publishedAt = isoDate(item.date);
    if (publishedAt) source.publishedAt = publishedAt;
    sources.push(source);
  }
  return sources;
}

/**
 * The SearchApi `error` string of a failed response, when the body is JSON of
 * the shape `{ "error": "..." }`; anything else yields undefined so an HTML
 * error page or a stack trace is never echoed to the model.
 *
 * @param {string} text - the raw response body.
 * @returns {string | undefined}
 */
export function apiErrorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.error;
    if (typeof detail !== 'string') return undefined;
    const trimmed = detail.trim();
    return trimmed ? trimmed.slice(0, ERROR_DETAIL_MAX) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the API key from any text that could reach the model. */
function redact(text, apiKey) {
  return apiKey ? String(text).split(apiKey).join('[redacted]') : String(text);
}

/**
 * How redirect links are handled: `local` follows each one hop from this
 * process (default), `api` asks SearchApi for `link=resolved`, `off` leaves
 * them as they came.
 */
export function linkMode(resolveLinks) {
  if (resolveLinks === 'api') return 'api';
  if (resolveLinks === undefined || resolveLinks === null) return 'local';
  return resolveLinks && resolveLinks !== 'off' ? 'local' : 'off';
}

/**
 * The request URL for one search. `num` is deliberately not sent: Google
 * phased it out and SearchApi documents it as a constant 10; `maxResults` is
 * applied to the mapped sources instead. `link=resolved` (SearchApi resolving
 * Google's redirect links server-side) is sent only in `api` link mode: it is
 * complete, but measured at 26 to 28 extra seconds per search, because Google
 * answers some of those redirects with an 11-second bot check first.
 *
 * @param {object} options - resolved options for this search.
 * @param {string} query - the trimmed query.
 * @returns {URL}
 */
export function buildURL(options, query) {
  const url = new URL(options.baseURL);
  url.searchParams.set('engine', options.engine);
  url.searchParams.set('q', query);
  if (linkMode(options.resolveLinks) === 'api') url.searchParams.set('link', 'resolved');
  if (options.gl) url.searchParams.set('gl', options.gl);
  if (options.hl) url.searchParams.set('hl', options.hl);
  return url;
}

// ---------------------------------------------------------------------------
// Redirect links
//
// Google now serves many organic links as `https://www.google.com/goto?url=<token>`,
// a 302 to the real page. Left alone, the model would cite google.com and
// `web_fetch` would go through the redirect. In `local` link mode each of
// those links is followed for exactly one hop, in parallel, with its own short
// timeout. Google sometimes answers with a 200 "verifying your request" page
// instead of the redirect; that link, like one that does not answer in time,
// is kept as it came (it still redirects when opened).

const GOTO_LINK = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/goto\?/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** True for a Google `goto` redirect link. */
export function isGotoLink(url) {
  return GOTO_LINK.test(url);
}

/**
 * Follow one redirect hop of `url` without reading the body.
 *
 * @param {string} url - the redirect link.
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<string | undefined>} the absolute http(s) target, or undefined.
 */
async function followRedirect(url, { timeoutMs, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await response.body?.cancel().catch(() => {});
  if (!REDIRECT_STATUS.has(response.status)) return undefined;
  const location = response.headers.get('location');
  if (!location) return undefined;
  let target;
  try {
    target = new URL(location, url).href;
  } catch {
    return undefined;
  }
  return /^https?:\/\//i.test(target) && !isGotoLink(target) ? target : undefined;
}

/**
 * Replace every redirect link among `sources` with its target, when the target
 * answers in time; other sources, and links that do not resolve, are returned
 * unchanged. Order is kept. A caller abort propagates as a rejection.
 *
 * @param {Array<{ url: string }>} sources - mapped sources.
 * @param {{ timeoutMs: number, signal?: AbortSignal, redirectLink?: (url: string) => boolean }} options
 */
export async function resolveGotoLinks(sources, { timeoutMs, signal, redirectLink = isGotoLink }) {
  const resolved = await Promise.all(sources.map(async (source) => {
    if (!redirectLink(source.url)) return source;
    try {
      const target = await followRedirect(source.url, { timeoutMs, signal });
      return target ? { ...source, url: target } : source;
    } catch (error) {
      if (signal?.aborted) throw error;
      return source;
    }
  }));
  const seen = new Set();
  return resolved.filter((source) => !seen.has(source.url) && seen.add(source.url));
}

// ---------------------------------------------------------------------------
// Provider

export class SearchApiSearchProvider {
  id = SEARCHAPI_PROVIDER_ID;

  /**
   * @param {() => object} options - the options for the next search, read at
   * each search's entry so a config change applies without re-registering.
   */
  constructor(options) {
    this.options = options;
  }

  /** Cheap, synchronous and network-free: mirrors the key sources of `search`. */
  available() {
    const options = this.options();
    if (options.apiKey) return true;
    if (process.env[options.apiKeyEnv]?.trim()) return true;
    return Boolean(options.hasCredentials);
  }

  async search(request, signal) {
    const options = this.options();
    const query = String(request?.query ?? '').trim();
    if (!query) throw webError('SearchApi search needs a non-empty query', 'WEB_PROVIDER_ERROR');

    const timeoutMs = Number(options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw webError(
        `SearchApi search config timeoutMs must be a positive number of milliseconds (got ${JSON.stringify(options.timeoutMs ?? null)})`,
        'WEB_PROVIDER_ERROR',
      );
    }

    const links = linkMode(options.resolveLinks);
    const linkTimeoutMs = Number(options.linkTimeoutMs);
    if (links === 'local' && (!Number.isFinite(linkTimeoutMs) || linkTimeoutMs <= 0)) {
      throw webError(
        `SearchApi search config linkTimeoutMs must be a positive number of milliseconds (got ${JSON.stringify(options.linkTimeoutMs ?? null)})`,
        'WEB_PROVIDER_ERROR',
      );
    }

    let baseURL;
    try {
      baseURL = new URL(options.baseURL).href;
    } catch (error) {
      throw webError(`SearchApi search config baseURL is not a valid URL (got ${JSON.stringify(options.baseURL ?? null)})`, 'WEB_PROVIDER_ERROR', error);
    }

    if (signal?.aborted) throw webError('SearchApi search aborted', 'WEB_ABORTED', signal.reason);
    const apiKey = await options.resolveApiKey();
    if (!apiKey) {
      throw webError(
        `SearchApi search has no API key: store it under ${options.apiKeyEnv} in the credentials service, export ${options.apiKeyEnv} in the environment that launches dsh, or set apiKey in the web-search-searchapi config`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }

    const url = buildURL({ ...options, baseURL }, query);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const fail = (message, error) => {
      if (signal?.aborted) return webError('SearchApi search aborted', 'WEB_ABORTED', signal.reason);
      if (timeout.aborted) return webError(`SearchApi search timed out after ${timeoutMs}ms`, 'WEB_PROVIDER_ERROR', error);
      return webError(message, 'WEB_PROVIDER_ERROR', error);
    };

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        signal: combined,
      });
    } catch (error) {
      throw fail(`SearchApi search request failed: ${redact(error?.message ?? error, apiKey)}`, error);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw fail('SearchApi search response could not be read', error);
    }

    if (!response.ok) {
      const detail = apiErrorDetail(text);
      throw webError(
        `SearchApi returned HTTP ${response.status}${detail ? `: ${redact(detail, apiKey)}` : ''}`,
        'WEB_PROVIDER_ERROR',
        undefined,
        response.status,
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw webError('SearchApi returned an unparseable 200 response body', 'WEB_PROVIDER_ERROR', error);
    }
    let sources = toSources(data, request?.maxResults);
    if (links === 'local' && sources.length > 0) {
      try {
        sources = await resolveGotoLinks(sources, { timeoutMs: linkTimeoutMs, signal, redirectLink: options.redirectLink });
      } catch (error) {
        throw fail('SearchApi search link resolution failed', error);
      }
    }
    return { sources, truncated: false };
  }
}

// ---------------------------------------------------------------------------
// Plugin

/** A config value, whether plain or a reactive accessor with `.get()`. */
function read(value) {
  return value && typeof value.get === 'function' ? value.get() : value;
}

function text(value) {
  const v = read(value);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Register the SearchApi search provider with `ctx.web`.
 *
 * Config (all optional): `apiKey` (literal; prefer the credentials service),
 * `apiKeyEnv` (credential reference and environment variable, default
 * `SEARCHAPI_API_KEY`), `engine` (default `google`; any SearchApi engine that
 * returns `organic_results`), `gl` and `hl` (Google country and language),
 * `baseURL`, `timeoutMs` (default 30000), `resolveLinks` (`true`: follow
 * Google's `goto` redirect links one hop from this process, the default;
 * `'api'`: ask SearchApi for `link=resolved`, complete but slow; `false`: leave
 * them) and `linkTimeoutMs` (per link in the default mode, 3000).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - the plugin row's config.
 */
export function apply(ctx, config = {}) {
  const credentialsOf = () => {
    try {
      return ctx.get('credentials');
    } catch {
      return undefined;
    }
  };

  ctx.web.registerSearchProvider(new SearchApiSearchProvider(() => {
    const apiKeyEnv = text(config.apiKeyEnv) ?? DEFAULTS.apiKeyEnv;
    const literal = text(config.apiKey);
    return {
      apiKey: literal,
      apiKeyEnv,
      hasCredentials: credentialsOf() !== undefined,
      baseURL: text(config.baseURL) ?? DEFAULTS.baseURL,
      engine: text(config.engine) ?? DEFAULTS.engine,
      gl: text(config.gl),
      hl: text(config.hl),
      timeoutMs: read(config.timeoutMs) ?? DEFAULTS.timeoutMs,
      resolveLinks: read(config.resolveLinks) ?? DEFAULTS.resolveLinks,
      linkTimeoutMs: read(config.linkTimeoutMs) ?? DEFAULTS.linkTimeoutMs,
      resolveApiKey: async () => {
        if (literal) return literal;
        const credentials = credentialsOf();
        if (credentials !== undefined) {
          const resolved = await credentials.resolve(apiKeyEnv);
          if (typeof resolved?.value === 'string' && resolved.value.trim()) return resolved.value.trim();
        }
        const ambient = process.env[apiKeyEnv]?.trim();
        return ambient || undefined;
      },
    };
  }));
}
