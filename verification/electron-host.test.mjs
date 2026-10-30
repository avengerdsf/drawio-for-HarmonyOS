import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(project, 'harmony-electron/web_engine/src/main/resources/resfile/resources/app');
const upstream = path.join(host, 'upstream');
const hostModule = name => import(pathToFileURL(path.join(host, name)).href);
const source = name => fs.readFileSync(path.join(upstream, name), 'utf8');
console.log('Electron host tests use Node ' + process.version + '; no real Electron/main or GUI is executed');

function legacyClipboard() {
  const calls = [];
  const clipboard = {
    calls,
    write(data, type) { assert.equal(this, clipboard); calls.push({data, type}); return 'sync-write'; },
    readText(type) { assert.equal(this, clipboard); return 'sync-text:' + type; },
    writeText(text) { assert.equal(this, clipboard); return 'sync-set:' + text; },
    clear() { assert.equal(this, clipboard); return 73; }
  };
  return clipboard;
}

const nativeImage = {
  createFromDataURL(value) { return {toPNG: () => Buffer.from(value.split(',')[1], 'base64')}; },
  createFromBuffer(value) { return {nativeImage: true, bytes: Buffer.from(value)}; }
};

function extractFunction(file, name) {
  const match = new RegExp('^function ' + name + '\\([^\\n]*\\)\\r?\\n\\{[\\s\\S]*?^\\}', 'm').exec(source(file));
  assert.ok(match, 'Real upstream function not found: ' + name);
  return match[0];
}

function fixture(action) {
  const temporary = path.join(project, 'tmp');
  fs.mkdirSync(temporary, {recursive: true});
  const directory = fs.mkdtempSync(path.join(temporary, '.electron-host-test-'));
  try { return action(directory); }
  finally {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(temporary));
    assert.ok(path.basename(absolute).startsWith('.electron-host-test-'));
    assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false);
    fs.rmSync(absolute, {recursive: true, force: true});
  }
}

const fakeElectron = `
class BrowserWindow {
  constructor(options) { this.options = options; }
  static getAllWindows() { return []; }
}
BrowserWindow.staticToken = {original: true};
exports.BrowserWindow = BrowserWindow;
exports.app = Object.assign(new (require('node:events').EventEmitter)(), {
  setAppPath(value) { this.appPath = value; },
  getAppPath() { return this.appPath; },
  setName(value) { this.name = value; },
  getPath(name) { if (name !== 'userData') throw Error('Unexpected path request'); this.lastPathRequest = name; return __dirname; }
});
exports.dialog = {native: true};
exports.ipcMain = new (require('node:events').EventEmitter)();
exports.extraToken = {preserved: true};
exports.clipboard = {
  write(data) { this.lastWrite = data; return 'legacy-sync'; },
  readText() { return this.lastWrite?.text || 'legacy-read'; }
};
exports.nativeImage = {createFromBuffer(value) { return {png: Buffer.from(value)}; }};
`;

function runFixture(directory, body) {
  const nativePath = path.join(directory, 'fake-electron.cjs');
  fs.writeFileSync(nativePath, fakeElectron);
  const nativeURL = pathToFileURL(nativePath).href;
  const runner = path.join(directory, 'runner.mjs');
  fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
import {registerHooks, createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
const nativeURL = ${JSON.stringify(nativeURL)};
registerHooks({resolve(specifier, context, nextResolve) {
  return specifier === 'electron' ? {url: nativeURL, shortCircuit: true} : nextResolve(specifier, context);
}});
const require = createRequire(import.meta.url);
${body}
`);
  const environment = {...process.env, USERPROFILE: path.join(directory, 'home'),
    LOCALAPPDATA: path.join(directory, 'home/AppData/Local'), APPDATA: path.join(directory, 'home/AppData/Roaming'),
    TEMP: path.join(directory, 'temp'), TMP: path.join(directory, 'temp'), NODE_DISABLE_COMPILE_CACHE: '1',
    NODE_COMPILE_CACHE: path.join(directory, 'node-cache'), npm_config_cache: path.join(directory, 'npm-cache')};
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP']) fs.mkdirSync(environment[name], {recursive: true});
  const result = spawnSync(process.execPath, [runner], {cwd: directory, env: environment, encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}

test('HostRoot retains all 4068 original upstream files byte for byte', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'verification/windows-app-32.6.1-manifest.json')));
  let files = 0;
  function walk(relative = '') {
    for (const item of fs.readdirSync(path.join(upstream, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + item.name : item.name;
      assert.equal(fs.lstatSync(path.join(upstream, name)).isSymbolicLink(), false);
      if (item.isDirectory()) walk(name); else files++;
    }
  }
  walk();
  assert.equal(files, manifest.fileCount);
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(upstream, item.path));
    assert.equal(bytes.length, item.bytes, item.path);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path);
  }
});

test('HostRoot package is only original application identity and host entry', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(host, 'package.json'))),
    {name: 'draw.io', version: '32.6.1', type: 'module', main: 'bootstrap.mjs'});
});

test('ClipboardItem exposes the MIME types/getType interface used by the facade', async () => {
  const {ClipboardItem} = await hostModule('electron-compat.mjs');
  const item = new ClipboardItem({'text/plain': '中文'});
  assert.deepEqual(item.types, ['text/plain']);
  assert.equal(await (await item.getType('text/plain')).text(), '中文');
  await assert.rejects(item.getType('missing'), /missing|MIME|type/i);
});

test('real upstream clipboardAction writes PNG bytes and HTML in one legacy call', async () => {
  const {ClipboardItem, createClipboardAdapter} = await hostModule('electron-compat.mjs');
  const legacy = legacyClipboard();
  const clipboard = createClipboardAdapter(legacy, nativeImage);
  const action = vm.runInNewContext('(' + extractFunction('src/main/electron.js', 'clipboardAction') + ')',
    {clipboard, ClipboardItem, Blob, nativeImage});
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=', 'base64');
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  await action('writeImage', {dataUrl, w: 120, h: 60});
  assert.equal(legacy.calls.length, 1);
  assert.ok(legacy.calls[0].data.image.bytes.equals(png));
  assert.equal(legacy.calls[0].data.html, '<img src="' + dataUrl + '" width="120" height="60">');
  assert.equal(action('readText'), 'sync-text:undefined');
  assert.equal(action('writeText', '测试'), 'sync-set:测试');
});

test('real context-menu default-object bookmark writes legacy text/bookmark atomically', async () => {
  const {ClipboardItem, createClipboardAdapter} = await hostModule('electron-compat.mjs');
  const legacy = legacyClipboard();
  const match = /^const writeBookmark = async[\s\S]*?^\]\);/m.exec(source('node_modules/electron-context-menu/index.js'));
  assert.ok(match, 'Real writeBookmark function is missing');
  const bookmark = vm.runInNewContext(match[0] + '\nwriteBookmark;',
    {electron: {ClipboardItem, clipboard: createClipboardAdapter(legacy, nativeImage)}});
  await bookmark('标题', 'https://example.test/diagram');
  assert.equal(legacy.calls.length, 1);
  assert.deepEqual(legacy.calls[0].data, {text: 'https://example.test/diagram', bookmark: '标题'});
});

test('legacy clipboard methods keep their native this and synchronous results', async () => {
  const {createClipboardAdapter} = await hostModule('electron-compat.mjs');
  const legacy = legacyClipboard(), clipboard = createClipboardAdapter(legacy, nativeImage);
  assert.equal(clipboard.readText('selection'), 'sync-text:selection');
  assert.equal(clipboard.writeText('原文'), 'sync-set:原文');
  assert.equal(clipboard.clear(), 73);
  const oldPayload = {text: 'old interface'};
  assert.equal(clipboard.write(oldPayload, 'selection'), 'sync-write');
  assert.equal(legacy.calls[0].data, oldPayload);
  assert.equal(legacy.calls[0].type, 'selection');
});

test('wrong ClipboardItem shape and unsupported MIME do not mutate native clipboard', async () => {
  const {ClipboardItem, createClipboardAdapter} = await hostModule('electron-compat.mjs');
  const legacy = legacyClipboard(), clipboard = createClipboardAdapter(legacy, nativeImage);
  await assert.rejects(clipboard.write([{data: {'text/plain': 'wrong shape'}}]), /ClipboardItem|types|getType/);
  await assert.rejects(clipboard.write([{types: ['text/plain'], getType: async () => 'wrong return'}]), /Blob|getType/);
  await assert.rejects(clipboard.write([new ClipboardItem({'application/unsupported': 'x'})]), /unsupported|Unsupported/);
  await assert.rejects(clipboard.write([]), /one ClipboardItem/);
  await assert.rejects(clipboard.write([new ClipboardItem({}), new ClipboardItem({})]), /one ClipboardItem/);
  assert.equal(legacy.calls.length, 0);
});

test('wrong facade ClipboardItem interface fails the real upstream image action', async () => {
  const {createClipboardAdapter} = await hostModule('electron-compat.mjs');
  const legacy = legacyClipboard();
  class WrongClipboardItem { constructor(data) { this.data = data; } }
  const action = vm.runInNewContext('(' + extractFunction('src/main/electron.js', 'clipboardAction') + ')',
    {clipboard: createClipboardAdapter(legacy, nativeImage), ClipboardItem: WrongClipboardItem, Blob, nativeImage});
  await assert.rejects(action('writeImage', {dataUrl: 'data:image/png;base64,iVBORw0KGgo=', w: 1, h: 1}), /types|getType/);
  assert.equal(legacy.calls.length, 0);
});

test('window Proxy preserves native instances/statics and changes only frame', async () => {
  const {withoutSystemFrame} = await hostModule('electron-compat.mjs');
  class NativeWindow { constructor(options) { this.options = options; } static marker() { return 41; } }
  NativeWindow.token = {};
  const Window = withoutSystemFrame(NativeWindow);
  const preferences = {preload: '/original/electron-preload.js', contextIsolation: true};
  const options = Object.freeze({width: 1200, height: 800, frame: true, show: false, webPreferences: preferences});
  const win = new Window(options);
  assert.ok(win instanceof NativeWindow && win instanceof Window);
  assert.equal(Object.getPrototypeOf(win), NativeWindow.prototype);
  assert.deepEqual(win.options, {...options, frame: false});
  assert.equal(win.options.webPreferences, preferences);
  assert.equal(options.frame, true);
  assert.equal(Window.marker, NativeWindow.marker);
  assert.equal(Window.token, NativeWindow.token);
});

test('loader redirects import electron but passes require and facade native import through', async () => {
  const {createHostHooks} = await hostModule('loader.mjs');
  const mainURL = pathToFileURL(path.join(upstream, 'src/main/electron.js')).href;
  const facadeURL = pathToFileURL(path.join(host, 'electron-facade.mjs')).href;
  const hook = createHostHooks(mainURL);
  let nextCalls = 0;
  const nativeResult = {url: 'native:electron'};
  const next = () => { nextCalls++; return nativeResult; };
  assert.deepEqual(hook.resolve('electron', {conditions: ['node', 'import'], parentURL: mainURL}, next),
    {url: facadeURL, shortCircuit: true});
  assert.equal(hook.resolve('electron', {conditions: new Set(['node', 'require']), parentURL: mainURL}, next), nativeResult);
  assert.equal(hook.resolve('electron', {conditions: ['import'], parentURL: facadeURL}, next), nativeResult);
  assert.equal(hook.resolve('node:fs', {conditions: ['import'], parentURL: mainURL}, next), nativeResult);
  assert.equal(nextCalls, 3);
});

test('update override is callable and only the original main import is remapped', async () => {
  const {createHostHooks} = await hostModule('loader.mjs');
  const disabled = await hostModule('disable-update.mjs');
  assert.equal(typeof disabled.disableUpdate, 'function');
  const text = source('src/main/electron.js');
  const start = text.indexOf('const disableUpdate = disUpPkg()');
  assert.ok(start >= 0, 'Original main callable update contract changed');
  const expression = text.slice(start, text.indexOf(';', start) + 1);
  assert.equal(vm.runInNewContext(expression + '\ndisableUpdate;',
    {disUpPkg: disabled.disableUpdate, process: {env: {}, argv: []}}), true);
  const mainURL = pathToFileURL(path.join(upstream, 'src/main/electron.js')).href;
  const hook = createHostHooks(mainURL), sentinel = {native: true}, next = () => sentinel;
  assert.deepEqual(hook.resolve('./disableUpdate.js', {conditions: ['import'], parentURL: mainURL}, next),
    {url: pathToFileURL(path.join(host, 'disable-update.mjs')).href, shortCircuit: true});
  assert.equal(hook.resolve('./disableUpdate.js', {conditions: ['import'], parentURL: mainURL + '?other'}, next), sentinel);
  assert.equal(hook.resolve('./disableUpdate.js', {conditions: ['require'], parentURL: mainURL}, next), sentinel);
  assert.equal(hook.resolve('../disableUpdate.js', {conditions: ['import'], parentURL: mainURL}, next), sentinel);
});

test('real facade import preserves other named exports and leaves CJS electron native', async () => {
  await fs.promises.access(path.join(host, 'electron-facade.mjs'));
  fixture(directory => runFixture(directory, `
const {createHostHooks} = await import(${JSON.stringify(pathToFileURL(path.join(host, 'loader.mjs')).href)});
registerHooks(createHostHooks('file:///upstream/src/main/electron.js'));
const api = await import('electron');
const native = require('electron');
assert.equal(api.extraToken, native.extraToken);
assert.equal(api.app, native.app);
assert.equal(api.default.dialog, native.dialog);
assert.equal(api.default.ClipboardItem, api.ClipboardItem);
assert.equal(api.default.clipboard, api.clipboard);
assert.equal(api.default.BrowserWindow, api.BrowserWindow);
assert.equal(api.BrowserWindow.staticToken, native.BrowserWindow.staticToken);
assert.notEqual(api.BrowserWindow, native.BrowserWindow);
const win = new api.BrowserWindow({frame: true, width: 500});
assert.ok(win instanceof native.BrowserWindow && win instanceof api.BrowserWindow);
assert.deepEqual(win.options, {frame: false, width: 500});
await api.default.clipboard.write([new api.default.ClipboardItem({'text/plain':'测试'})]);
assert.equal(native.clipboard.lastWrite.text, '测试');
assert.equal(api.clipboard.readText(), '测试');
assert.equal(require('electron').BrowserWindow, native.BrowserWindow);
console.log('facade import/export/require contract passed');
`));
});

test('missing facade reproduces the original ClipboardItem named-export startup failure', () => {
  fixture(directory => {
    const entry = path.join(directory, 'missing-clipboard-export.mjs');
    fs.writeFileSync(entry, "import {ClipboardItem} from 'electron'; export {ClipboardItem};");
    runFixture(directory, `
await assert.rejects(import(${JSON.stringify(pathToFileURL(entry).href)}), /ClipboardItem.*not found|does not provide.*ClipboardItem/s);
console.log('missing facade correctly fails during ESM linking');
`);
  });
});

test('bootstrap sets original app path/name and imports original main by its file URL', async () => {
  const names = ['bootstrap.mjs', 'loader.mjs', 'electron-facade.mjs', 'electron-compat.mjs', 'disable-update.mjs',
    'child-process-facade.mjs', 'font-catalog.mjs', 'renderer-resources.mjs', 'native-input-state.mjs', 'native-clipboard-text.mjs', 'native-window-controls.mjs'];
  for (const name of names) await fs.promises.access(path.join(host, name));
  fixture(directory => {
    for (const name of names) fs.copyFileSync(path.join(host, name), path.join(directory, name));
    fs.mkdirSync(path.join(directory, 'window-controls'));
    for (const name of ['minimize', 'maximize', 'restore', 'close']) {
      fs.copyFileSync(path.join(host, 'window-controls/window_' + name + '.svg'), path.join(directory, 'window-controls/window_' + name + '.svg'));
    }
    const original = path.join(directory, 'upstream');
    fs.mkdirSync(path.join(original, 'src/main'), {recursive: true});
    fs.writeFileSync(path.join(original, 'package.json'), JSON.stringify({name: 'draw.io', version: '32.6.1', type: 'module', main: 'src/main/electron.js'}));
    fs.writeFileSync(path.join(original, 'src/main/disableUpdate.js'), 'export function disableUpdate() { return false; }');
    fs.writeFileSync(path.join(original, 'src/main/electron.js'), `
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import electron, {ClipboardItem, BrowserWindow} from 'electron';
import {disableUpdate} from './disableUpdate.js';
assert.equal(electron.app.getAppPath(), fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\\\/]$/, ''));
assert.equal(electron.app.name, 'draw.io');
assert.equal(electron.app.lastPathRequest, 'userData');
assert.equal(electron.app.listenerCount('web-contents-created'), 3);
assert.equal(electron.app.listenerCount('browser-window-created'), 1);
assert.equal(electron.ClipboardItem, ClipboardItem);
assert.equal(disableUpdate(), true);
assert.equal(new BrowserWindow({frame: true}).options.frame, false);
console.log('original main fixture URL: ' + import.meta.url);
`);
    const output = runFixture(directory, `await import(${JSON.stringify(pathToFileURL(path.join(directory, 'bootstrap.mjs')).href)});`);
    assert.ok(output.includes(pathToFileURL(path.join(original, 'src/main/electron.js')).href));
    assert.ok(!output.includes('data:'));
  });
});
