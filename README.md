# dsh-web-search-searchapi

A [SearchApi](https://www.searchapi.io) search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web seam (`ctx.web`).

One backend, one job: the `web_search` tool sends the query to SearchApi's Google engine and gets the organic results back as sources, in `dsh web`, dsh-TUI and headless runs. No settings card, no fan-out, no state. `web_fetch` is unchanged.

- Single GET to `https://www.searchapi.io/api/v1/search?engine=google`
- Key from the credentials service, then `$SEARCHAPI_API_KEY` (or a literal `apiKey` in your profile patch)
- `organic_results[]` mapped to `{ url, title, snippet, publishedAt }`; `maxResults` honored
- Google's `google.com/goto` redirect links are followed one hop, in parallel, so sources cite the real page
- Clear failures: missing key, non-2xx with SearchApi's own error message, timeout, cancellation

## Requirements

- DeepSeek Harness with the `web` service (any profile that mounts `@deepseek-ai/dsh-base`); tested against dsh 0.2.2-rc.1
- Node 20.3 or newer
- A SearchApi API key: <https://www.searchapi.io/>

## Install

```sh
dsh plugin --profile web add github:gabsferreira/dsh-web-search-searchapi
```

The package ships its own bundle patch: it mounts the provider and points the web seam's `searchProvider` at `searchapi` (keeping `fetchProvider: http`). Nothing else to wire up; only the key is missing.

## Store the key

Either through the credentials service, in `$DSH_HOME/.credentials.yaml` (keep it at `chmod 600`):

```yaml
version: 1
refs:
  SEARCHAPI_API_KEY: your-key
```

or in the environment that launches dsh:

```sh
SEARCHAPI_API_KEY=your-key dsh web
```

The key is resolved at every search (credentials service first, then the environment), so a rotated key applies without a restart.

## Verify

Ask for something current. A missing key surfaces as `SearchApi search has no API key: …`, a wrong one as `SearchApi returned HTTP 401: Invalid API key.`.

## Configuration

All optional. Set them on the `web-search-searchapi` row in your profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: web-search-searchapi
  config:
    apiKeyEnv: SEARCHAPI_API_KEY
    gl: br
    hl: pt
```

| key | default | what it does |
|---|---|---|
| `apiKeyEnv` | `SEARCHAPI_API_KEY` | credential reference and environment variable the key is read from |
| `apiKey` | | a literal key; prefer the credentials service |
| `engine` | `google` | any SearchApi engine that returns `organic_results` (`bing`, `duckduckgo`, …) |
| `gl`, `hl` | | Google country and language |
| `resolveLinks` | `true` | `true`: follow Google's `goto` redirect links one hop from this process; `'api'`: ask SearchApi for `link=resolved` instead (complete, but 26 to 28 s slower per search, see below); `false`: leave them |
| `linkTimeoutMs` | `3000` | per redirect link, in the default mode |
| `timeoutMs` | `30000` | whole search |
| `baseURL` | `https://www.searchapi.io/api/v1/search` | the endpoint |

A patch entry's `config` **replaces** the row's config, so repeat `apiKeyEnv` when you add keys to the row.

## How it maps

- `num` is not sent: Google phased it out and SearchApi documents it as a constant 10. `maxResults` is applied to the mapped sources, and the seam enforces it again.
- `publishedAt` is an ISO calendar date (`2026-10-12`) built from SearchApi's `date` when it is an absolute date; relative dates ("2 days ago") are dropped rather than guessed.
- Google serves part of the organic links as `https://www.google.com/goto?url=…`, a 302 to the page. In the default mode each one is followed exactly one hop (a tenth of a second each, in parallel, never reading the body). Google sometimes answers with a "verifying your request" page instead of the redirect; that link is kept as it came, and still redirects when opened. SearchApi's own `link=resolved` waits that check out server-side, which is why `'api'` mode is complete but slow.
- Errors are the host's `WebError`, so tool results keep a structured code: `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_PROVIDER_ERROR` (with `status` on HTTP failures), `WEB_ABORTED`. SearchApi's `error` message rides on the error when the body is JSON; the key never does.

## Development

```sh
npm install
npm test                 # unit (mock SearchApi on loopback) + contract (real @deepseek-ai/dsh-web seam)
DSH_BIN=<dsh>/lib/bin.js npm test   # also composes the bundle with a real dsh (--dump-config)
```

No network leaves the box during tests.

## License

MIT. Built by Gabs Ferreira, developer advocate at SearchApi.
