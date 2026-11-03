import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtures, parseMeasurement, statistics } from './benchmark-metrics.mjs';

test('statistics interpolate quantiles and handle one observation', () => {
  assert.deepEqual(statistics([3]), { n: 1, min: 3, median: 3, p90: 3, max: 3, mean: 3, stddev: 0 });
  assert.equal(statistics([4, 1, 3, 2]).median, 2.5);
  assert.equal(statistics([1, 2, 3, 4, 5]).p90, 4.6);
});
test('parser requires compatible startup and exactly one correlated opening', () => {
  const opening = { opening_id: '1', frontend: { backend: { opening_id: '1' } } };
  const text = `noise\nMD_VIEWER_OPENING=${JSON.stringify(opening)}\nMD_VIEWER_PAINT_MS=12.34\n`;
  assert.equal(parseMeasurement(text).startup_ms, 12.34);
  assert.throws(() => parseMeasurement('MD_VIEWER_PAINT_MS=1'));
  assert.throws(() => parseMeasurement(text + text));
  assert.throws(() => parseMeasurement(text.replace('"opening_id":"1"', '"opening_id":"2"')));
});
test('fixtures cover sizes and deferred rich syntax without remote image fetches', () => {
  assert.ok(Buffer.byteLength(fixtures.small) < 1024);
  assert.ok(Buffer.byteLength(fixtures.large) > 1024 * 1024);
  for (const marker of ['```ts', '```mermaid', '$$', '| A |', '![local]']) assert.ok(fixtures.rich.includes(marker));
});
