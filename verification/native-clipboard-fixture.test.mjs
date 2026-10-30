import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import vm from 'node:vm';
import {createClipboardFixture, sanitizeClipboardResult, fixturePage} from './native-clipboard-server.mjs';

test('owned PNG is a real 64 by 48 RGBA image and its advertised pixel digest matches decoded scanlines', () => {
  const fixture = createClipboardFixture(), png = fixture.png;
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const compressed = []; let width, height;
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); }
    if (type === 'IDAT') compressed.push(data);
    at += size + 12;
  }
  assert.equal(width, 64); assert.equal(height, 48);
  const scanlines = zlib.inflateSync(Buffer.concat(compressed)), pixels = [];
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 4 + 1); assert.equal(scanlines[offset], 0);
    pixels.push(scanlines.subarray(offset + 1, offset + width * 4 + 1));
  }
  assert.equal(crypto.createHash('sha256').update(Buffer.concat(pixels)).digest('hex'), fixture.config.cases.png.pixelSha256);
  assert.notEqual(fixture.config.runId, createClipboardFixture().config.runId);
});

test('result endpoint refuses raw clipboard bodies and drops all metadata belonging to unknown content', () => {
  const runId = 'owned-session', input = {runId, case: 'text', operation: 'browser-read', owned: true, ok: true};
  assert.throws(() => sanitizeClipboardResult({...input, text: 'private clipboard body'}, runId), /metadata/);
  assert.throws(() => sanitizeClipboardResult({...input, html: '<b>private</b>'}, runId), /metadata/);
  assert.throws(() => sanitizeClipboardResult({...input, runId: 'another-session'}, runId), /identity/);
  assert.deepEqual(sanitizeClipboardResult({...input, owned: false, sha256: 'a'.repeat(64), types: ['text/plain']}, runId),
    {runId, case: 'text', operation: 'browser-read', owned: false, ok: false, reason: 'not-owned'});
});

test('browser fixture script parses and provides trusted copy/read buttons without starting a listener', () => {
  const html = fixturePage(createClipboardFixture().config);
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes('replace(/\\s+/g'));
  for (const name of ['copy-text', 'copy-html', 'copy-png', 'read-text', 'read-html', 'read-png', 'read-graph', 'recopy-graph'])
    assert.ok(html.includes(`id="${name}"`), name);
});
