import test from 'node:test';
import assert from 'node:assert/strict';
import { toSources, isoDate } from '../../lib/index.js';

test('maps organic_results onto the seam source shape', () => {
  const data = {
    organic_results: [
      { position: '1', title: 'A', link: 'https://example.com/a', snippet: 'first', date: 'Oct 12, 2026' },
      { position: '2', link: 'https://example.com/b', snippet: 'second' },
      { position: '3', title: 'C', link: 'http://example.com/c' },
    ],
  };
  assert.deepEqual(toSources(data), [
    { url: 'https://example.com/a', title: 'A', snippet: 'first', publishedAt: '2026-10-12' },
    { url: 'https://example.com/b', snippet: 'second' },
    { url: 'http://example.com/c', title: 'C' },
  ]);
});

test('drops entries without an http(s) link, dedupes by URL and trims text', () => {
  const data = {
    organic_results: [
      { title: ' no link ' },
      { link: '', title: 'empty' },
      { link: 'ftp://example.com/x', title: 'ftp' },
      { link: 'https://example.com/a', title: '  A  ', snippet: '  s  ' },
      { link: 'https://example.com/a', title: 'again' },
      null,
      42,
    ],
  };
  assert.deepEqual(toSources(data), [{ url: 'https://example.com/a', title: 'A', snippet: 's' }]);
});

test('omits fields that are not non-empty strings so the result survives a JSON round trip', () => {
  const data = { organic_results: [{ link: 'https://example.com/a', title: null, snippet: 7, date: 42 }] };
  const sources = toSources(data);
  assert.deepEqual(sources, [{ url: 'https://example.com/a' }]);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(sources))), JSON.stringify(sources));
});

test('publishedAt is an ISO calendar date, or absent when the date is relative or unparseable', () => {
  assert.equal(isoDate('Oct 12, 2026'), '2026-10-12');
  assert.equal(isoDate('Aug 8, 2024'), '2024-08-08');
  assert.equal(isoDate('2026-11-04'), '2026-11-04');
  assert.equal(isoDate('2 days ago'), undefined);
  assert.equal(isoDate('4 weeks ago'), undefined);
  assert.equal(isoDate(''), undefined);
  assert.equal(isoDate(undefined), undefined);
  assert.equal(isoDate('not a date 1999'), undefined);
});

test('caps to maxResults when given and leaves the list alone otherwise', () => {
  const data = { organic_results: Array.from({ length: 10 }, (_, i) => ({ link: `https://example.com/${i}` })) };
  assert.equal(toSources(data, 3).length, 3);
  assert.equal(toSources(data).length, 10);
  assert.equal(toSources(data, 0).length, 10, 'a non-positive cap is ignored');
  assert.equal(toSources(data, 2.5).length, 10, 'a non-integer cap is ignored');
});

test('tolerates junk payloads', () => {
  assert.deepEqual(toSources(undefined), []);
  assert.deepEqual(toSources(null), []);
  assert.deepEqual(toSources({}), []);
  assert.deepEqual(toSources({ organic_results: 'nope' }), []);
  assert.deepEqual(toSources({ organic_results: {} }), []);
});
