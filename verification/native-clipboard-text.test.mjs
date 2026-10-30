import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const moduleURL = new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/native-clipboard-text.mjs', import.meta.url);
const {installNativeClipboardText} = fs.existsSync(moduleURL) ? await import(moduleURL.href) : {};
const editorURL = 'file:///bundle/upstream/drawio/src/main/webapp/index.html';
const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const encoded = encodeURIComponent(xml);

async function setup(clipboard, url = editorURL + '?mode=device', frameURL = url, rendererURL = url, ready = true) {
  assert.equal(typeof installNativeClipboardText, 'function', 'Native clipboard graph text normalization is not implemented');
  const app = new EventEmitter(), contents = new EventEmitter(), window = {location: {href: rendererURL}};
  window.top = window;
  const context = vm.createContext({window, navigator: {clipboard}, Blob, console});
  contents.getURL = () => url; contents.mainFrame = {url: frameURL}; contents.executions = 0;
  contents.executeJavaScript = async source => { contents.executions++; return vm.runInContext(source, context); };
  const dispose = installNativeClipboardText(app, editorURL);
  app.emit('web-contents-created', {}, contents); if (ready) contents.emit('dom-ready');
  await new Promise(resolve => setImmediate(resolve));
  return {app, contents, clipboard, context, dispose};
}

test('original editor readText decodes only the owned mxGraphModel text representation', async () => {
  const run = await setup({readText: async () => encoded});
  assert.equal(await run.clipboard.readText(), xml);
  run.dispose();
});

test('normal text, percent signs, encoded HTML and invalid graph prefixes remain byte-for-byte', async () => {
  for (const text of ['普通文本 100% 中文', '%25%20unchanged', '%3Cdiv%3Etext%3C%2Fdiv%3E',
    '%3cmxGraphModel%3E', '%3CmxGraphModelFake%3E', '%3CmxGraphModel%ZZ', '%3CmxGraphModel%20%E0%A4%A']) {
    const run = await setup({readText: async () => text});
    assert.equal(await run.clipboard.readText(), text);
    run.dispose();
  }
});

test('read().getType(text/plain) normalizes returned bytes without changing native stored bytes', async () => {
  const stored = new Blob([encoded], {type: 'text/plain'}), original = {types: ['text/plain'], getType: async () => stored};
  const run = await setup({read: async () => [original]});
  const [item] = await run.clipboard.read();
  const result = await item.getType('text/plain');
  assert.equal(await result.text(), xml); assert.equal(result.type, stored.type);
  assert.equal(await stored.text(), encoded); assert.equal(await original.getType('text/plain'), stored);
  run.dispose();
});

test('HTML and PNG blobs and item types are passed through unchanged', async () => {
  const text = new Blob([encoded], {type: 'text/plain'}), html = new Blob(['<b>owned</b>'], {type: 'text/html'});
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], {type: 'image/png'});
  const types = ['text/plain', 'text/html', 'image/png'];
  const run = await setup({read: async () => [{types, getType: async type => ({'text/plain': text, 'text/html': html, 'image/png': png}[type])}]});
  const [item] = await run.clipboard.read();
  assert.equal(item.types, types); assert.equal(await item.getType('text/html'), html); assert.equal(await item.getType('image/png'), png);
  run.dispose();
});

test('ordinary text Blob identity and non-text items are preserved', async () => {
  const blob = new Blob(['100% 普通文本'], {type: 'text/plain'}), plain = {types: ['text/plain'], getType: async () => blob};
  const image = {types: ['image/png'], getType: async () => new Blob()};
  const run = await setup({read: async () => [plain, image]});
  const items = await run.clipboard.read();
  assert.equal(await items[0].getType('text/plain'), blob); assert.equal(items[1], image);
  run.dispose();
});

test('readText and read preserve caller receivers, arguments and native permission errors', async () => {
  const receiver = {}, options = {unsanitized: ['text/html']}, denied = new Error('Read denied'); denied.name = 'NotAllowedError';
  const calls = [];
  const run = await setup({readText(...args) { calls.push([this, args]); return Promise.reject(denied); },
    read(...args) { calls.push([this, args]); return Promise.reject(denied); }});
  await assert.rejects(run.clipboard.readText.call(receiver, options), error => error === denied);
  await assert.rejects(run.clipboard.read.call(receiver, options), error => error === denied);
  assert.equal(calls.length, 2);
  for (const [actualReceiver, args] of calls) { assert.equal(actualReceiver, receiver); assert.deepEqual(args, [options]); }
  run.dispose();
});

test('ClipboardItem getType keeps its native receiver and all arguments', async () => {
  const blob = new Blob([encoded], {type: 'text/plain'}), calls = [], receiver = {};
  const original = {types: ['text/plain'], getType(...args) { calls.push([this, args]); return Promise.resolve(blob); }};
  const run = await setup({read: async () => [original]});
  const [item] = await run.clipboard.read();
  await item.getType('text/plain', 42); await item.getType.call(receiver, 'text/plain', 43);
  assert.equal(calls[0][0], original); assert.deepEqual(calls[0][1], ['text/plain', 42]);
  assert.equal(calls[1][0], receiver); assert.deepEqual(calls[1][1], ['text/plain', 43]);
  run.dispose();
});

test('synchronous original receiver errors and getType rejections remain unchanged', async () => {
  const denied = new Error('Item denied');
  const run = await setup({readText() { throw denied; }, read: async () => [{types: ['text/plain'], getType: () => Promise.reject(denied)}]});
  assert.throws(() => run.clipboard.readText(), error => error === denied);
  const [item] = await run.clipboard.read();
  await assert.rejects(item.getType('text/plain'), error => error === denied);
  run.dispose();
});

test('external URLs, mismatched main frames and renderer navigation races are not patched', async () => {
  for (const [url, frame, renderer] of [['https://example.invalid/', editorURL, editorURL],
    [editorURL, 'https://example.invalid/', editorURL], [editorURL, editorURL, 'https://example.invalid/'],
    [editorURL.replace('index.html', 'export3.html'), editorURL, editorURL]]) {
    const original = async () => encoded, run = await setup({readText: original}, url, frame, renderer);
    assert.equal(run.clipboard.readText, original); assert.equal(await run.clipboard.readText(), encoded);
    run.dispose();
  }
});

test('dom-ready is required, repeat events do not stack wrappers, and destroy/uninstall clean listeners', async () => {
  const original = async () => encoded;
  const run = await setup({readText: original}, editorURL, editorURL, editorURL, false);
  assert.equal(run.contents.executions, 0); assert.equal(run.clipboard.readText, original);
  run.contents.emit('dom-ready'); await new Promise(resolve => setImmediate(resolve));
  const first = run.clipboard.readText;
  run.contents.emit('dom-ready'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.clipboard.readText, first);
  run.contents.emit('destroyed'); assert.equal(run.contents.listenerCount('dom-ready'), 0);
  run.dispose(); assert.equal(run.app.listenerCount('web-contents-created'), 0);
});

test('unavailable clipboard methods and write operations are not invented or changed', async () => {
  const writeText = () => assert.fail('The shim must not write the system clipboard');
  const run = await setup({writeText});
  assert.equal(run.clipboard.writeText, writeText); assert.equal(run.clipboard.readText, undefined); assert.equal(run.clipboard.read, undefined);
  run.dispose();
});
