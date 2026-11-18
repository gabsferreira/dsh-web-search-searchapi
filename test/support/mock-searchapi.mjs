// A loopback stand-in for https://www.searchapi.io/api/v1/search. Records every
// request (URL, headers) and answers from a scenario; no network leaves the box.
import { createServer } from 'node:http';

/** A SearchApi Google payload in the live shape, `n` organic results. */
export function SEARCHAPI_OK(query, n = 3) {
  const organic_results = Array.from({ length: n }, (_, i) => ({
    position: String(i + 1),
    title: `${query} result ${i + 1}`,
    link: `https://example.com/${encodeURIComponent(query)}/${i + 1}`,
    source: 'example.com',
    domain: 'example.com',
    displayed_link: `https://example.com › ${i + 1}`,
    snippet: `Snippet ${i + 1} about ${query}.`,
    ...(i % 2 === 0 ? { date: 'Oct 12, 2026' } : {}),
  }));
  return {
    status: 200,
    json: {
      search_metadata: { id: 'mock', status: 'Success' },
      search_parameters: { engine: 'google', q: query, link: 'resolved' },
      organic_results,
      pagination: { current: 1 },
    },
  };
}

/**
 * Start the mock. `scenario(request)` returns `{status, json | text, delayMs?, bodyDelayMs?}`.
 * @returns {{ baseURL: string, requests: () => Array, close: () => Promise<void> }}
 */
export async function startMockSearchApi({ scenario, goto } = {}) {
  const log = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { url, headers: req.headers, query: Object.fromEntries(url.searchParams), method: req.method };
    log.push(record);
    if (url.pathname === '/goto') {
      // A stand-in for https://www.google.com/goto?url=<token>: one 302 to the page.
      const reply = (goto ?? ((r) => ({ status: 302, location: `https://resolved.example/${r.query.url}` })))(record);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status ?? 302, reply.location ? { location: reply.location } : {});
      res.end(reply.text ?? '');
      return;
    }
    const reply = (scenario ?? ((r) => SEARCHAPI_OK(r.query.q)))(record);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const body = reply.text !== undefined ? reply.text : JSON.stringify(reply.json);
    res.writeHead(reply.status ?? 200, { 'content-type': reply.text !== undefined ? 'text/html' : 'application/json' });
    if (reply.bodyDelayMs) {
      res.write(body.slice(0, 1));
      await new Promise((r) => setTimeout(r, reply.bodyDelayMs));
      res.end(body.slice(1));
    } else {
      res.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}/api/v1/search`,
    gotoURL: (token) => `http://127.0.0.1:${port}/goto?url=${encodeURIComponent(token)}`,
    /** The predicate that treats this mock's /goto links as Google's. */
    redirectLink: (url) => url.startsWith(`http://127.0.0.1:${port}/goto?`),
    searches: () => log.filter((r) => r.url.pathname !== '/goto'),
    gotos: () => log.filter((r) => r.url.pathname === '/goto'),
    requests: () => log,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
