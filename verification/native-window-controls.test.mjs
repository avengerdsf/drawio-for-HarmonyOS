import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleURL = new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/native-window-controls.mjs', import.meta.url);
const {installNativeWindowControls} = fs.existsSync(moduleURL) ? await import(moduleURL.href) : {};
const editorURL = 'file:///bundle/upstream/drawio/src/main/webapp/index.html';
const requestChannel = '__diagramdesk_window_controls_request_v1', replyChannel = '__diagramdesk_window_controls_reply_v1';
const icons = Object.fromEntries(['minimize', 'maximize', 'restore', 'close'].map(name => [name, 'data:image/svg+xml,' + encodeURIComponent('<svg id="' + name + '"/>')]));

function fixture(modeFilePath) {
  assert.equal(typeof installNativeWindowControls, 'function', 'Trusted native window controls are not implemented');
  const app = new EventEmitter(), ipcMain = new EventEmitter(), windows = new Map();
  const BrowserWindow = {fromWebContents: contents => windows.get(contents)};
  const dispose = installNativeWindowControls(app, ipcMain, BrowserWindow, editorURL, icons, modeFilePath);
  function create(url = editorURL + '?mode=device', frameURL = url, render = false) {
    const contents = new EventEmitter(), window = new EventEmitter(), calls = [], executions = [];
    const flags = {maximized: false, fullscreen: false, minimizable: true, maximizable: true, closable: true, zoom: 1};
    window.isMaximized = () => flags.maximized; window.isFullScreen = () => flags.fullscreen;
    window.isMinimizable = () => flags.minimizable; window.isMaximizable = () => flags.maximizable; window.isClosable = () => flags.closable;
    window.isDestroyed = () => false;
    for (const name of ['minimize', 'maximize', 'unmaximize', 'setFullScreen', 'close', 'setWindowButtonVisibility', 'setBackgroundColor']) {
      window[name] = (...args) => { calls.push([name, ...args]); if (name === 'maximize') flags.maximized = true;
        if (name === 'unmaximize') flags.maximized = false; if (name === 'setFullScreen') flags.fullscreen = args[0]; };
    }
    window.destroy = () => assert.fail('Close must retain the original confirmation flow');
    contents.getURL = () => url; contents.mainFrame = {url: frameURL, frameTreeNodeId: windows.size + 1}; contents.getZoomFactor = () => flags.zoom;
    const replies = new EventEmitter(), document = makeDocument(), rendererWindow = {location: {href: url}, addEventListener() {}, removeEventListener() {}};
    rendererWindow.top = rendererWindow;
    const observers = [];
    class MutationObserver {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(node, options) { this.targets.push({node, options}); }
      disconnect() { this.disconnected = true; }
    }
    const context = vm.createContext({window: rendererWindow, document, console, MutationObserver,
      getComputedStyle: node => ({backgroundColor: node.backgroundColor || 'rgba(0, 0, 0, 0)'}), electron: {
      listenOnce: (channel, callback) => replies.once(channel, callback),
      sendMessage: (channel, message) => ipcMain.emit(channel, {sender: contents, senderFrame: contents.mainFrame, reply: (name, value) => replies.emit(name, value)}, message)
    }});
    rendererWindow.electron = vm.runInContext('electron', context);
    contents.executeJavaScript = async source => { executions.push(source); if (render) return vm.runInContext(source, context); };
    windows.set(contents, window); app.emit('web-contents-created', {}, contents);
    return {contents, window, calls, executions, flags, document, rendererWindow, observers};
  }
  function request(view, action, senderFrame = view.contents.mainFrame, extra = {}) {
    let reply;
    ipcMain.emit(requestChannel, {sender: view.contents, senderFrame, reply: (channel, value) => { assert.equal(channel, replyChannel); reply = value; }}, {action, ...extra});
    return reply;
  }
  return {app, ipcMain, windows, dispose, create, request};
}

function makeDocument() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    removeEventListener(name) { delete this.listeners[name]; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
    click() { if (!this.disabled) this.listeners.click?.({preventDefault() {}, stopPropagation() {}}); }
  }
  const body = new Element('body'), head = new Element('head'), documentElement = new Element('html');
  documentElement.appendChild(head); documentElement.appendChild(body);
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
  const document = {body, head, documentElement, createElement: tag => new Element(tag),
    getElementById: id => find(body, id) || find(head, id)};
  document.querySelector = () => document.menubar;
  return document;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function modeFile(t, normalPadMode) {
  const temporaryRoot = fileURLToPath(new URL('../tmp/', import.meta.url));
  fs.mkdirSync(temporaryRoot, {recursive: true});
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'window-mode-test-'));
  const filename = path.join(directory, 'diagramdesk-window-mode.json');
  fs.writeFileSync(filename, JSON.stringify({normalPadMode}));
  t.after(() => { if (fs.existsSync(filename)) fs.unlinkSync(filename); fs.rmdirSync(directory); });
  return filename;
}

async function until(condition) {
  for (let count = 0; count < 40 && !condition(); count++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(condition(), true, 'OS mode update did not arrive');
}

test('the synchronous OS mode file hides normal Pad controls before first render and restores them in free mode', async t => {
  const filename = modeFile(t, true), run = fixture(filename); t.after(run.dispose);
  const view = run.create(editorURL, editorURL, true);
  view.document.menubar = view.document.createElement('div'); view.document.menubar.backgroundColor = 'rgb(27, 29, 30)';
  view.contents.emit('dom-ready'); await tick();
  const bar = view.document.getElementById('drawio-caption-controls'), title = view.document.getElementById('drawio-caption-title');
  assert.equal(run.request(view, 'state').state.normalPadMode, true);
  assert.equal(bar.style.display, 'none'); assert.equal(title.style.display, 'none');
  assert.equal(bar.attributes['aria-hidden'], 'true');
  for (const button of bar.children) assert.equal(button.disabled, true);
  const before = view.calls.length; title.listeners.dblclick({button: 0}); assert.equal(view.calls.length, before);
  assert.equal(run.request(view, 'toggle').accepted, false);
  fs.writeFileSync(filename, JSON.stringify({normalPadMode: false}));
  await until(() => bar.style.display === 'flex');
  assert.equal(title.style.display, 'block'); assert.equal(bar.attributes['aria-hidden'], 'false');
  for (const button of bar.children) assert.equal(button.disabled, false);
  assert.equal(view.calls.filter(call => call[0] === 'setBackgroundColor').length, 2, 'OS mode changes reapply the same theme color');
});

test('missing or malformed mode data retains the last valid OS mode and disposal removes its file watcher', async t => {
  const filename = modeFile(t, true), run = fixture(filename), view = run.create(); t.after(run.dispose);
  assert.equal(run.request(view, 'state').state.normalPadMode, true);
  for (const invalid of ['{}', '{"normalPadMode":"false"}', '{']) {
    fs.writeFileSync(filename, invalid); await new Promise(resolve => setTimeout(resolve, 260));
    assert.equal(run.request(view, 'state').state.normalPadMode, true);
  }
  fs.unlinkSync(filename); await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(run.request(view, 'state').state.normalPadMode, true);
  run.dispose(); const count = view.executions.length;
  fs.writeFileSync(filename, JSON.stringify({normalPadMode: false}));
  await new Promise(resolve => setTimeout(resolve, 260)); assert.equal(view.executions.length, count);
});

test('appearance IPC accepts only the original own main frame and exact opaque hex schema without a control reply', () => {
  const run = fixture(), view = run.create();
  assert.equal(run.request(view, 'appearance', undefined, {color: '#1b1d1e'}), undefined);
  assert.deepEqual(view.calls, [['setBackgroundColor', '#1b1d1e']]);
  for (const extra of [{color: 'red'}, {color: '#123'}, {color: '#12345678'}, {color: '#abcdef', windowId: 1}]) {
    assert.equal(run.request(view, 'appearance', undefined, extra), undefined);
  }
  run.request(view, 'appearance', {...view.contents.mainFrame, frameTreeNodeId: 999}, {color: '#ffffff'});
  const foreign = run.create('https://example.invalid/'); run.request(foreign, 'appearance', undefined, {color: '#ffffff'});
  assert.equal(view.calls.length, 1); assert.deepEqual(foreign.calls, []); run.dispose();
});

test('renderer appearance follows inherited header color and theme changes without consuming control replies', async () => {
  const run = fixture(), view = run.create(editorURL, editorURL, true);
  const header = view.document.createElement('div'), parent = view.document.createElement('div');
  header.parentElement = parent; parent.backgroundColor = 'rgb(27, 29, 30)'; view.document.menubar = header;
  view.contents.emit('dom-ready'); await tick();
  assert.ok(view.calls.some(call => call[0] === 'setBackgroundColor' && call[1] === '#1b1d1e'));
  for (const target of view.observers.flatMap(observer => observer.targets)) {
    if ([view.document.body, view.document.documentElement].includes(target.node)) {
      assert.equal(target.options.attributes, true); assert.equal(target.options.subtree, undefined);
      assert.equal(target.options.childList, target.node === view.document.body ? true : undefined);
    }
  }
  const count = view.calls.length; for (const observer of view.observers) observer.callback([]); await tick();
  assert.equal(view.calls.length, count, 'Unchanged appearance must not loop');
  parent.backgroundColor = 'rgb(240, 240, 240)'; for (const observer of view.observers) observer.callback([]); await tick();
  assert.deepEqual(view.calls.at(-1), ['setBackgroundColor', '#f0f0f0']);
  view.document.getElementById('drawio-caption-最大化').click(); await tick();
  assert.ok(view.document.getElementById('drawio-caption-还原'));
  view.rendererWindow.__diagramdeskNativeWindowControls.dispose();
  assert.ok(view.observers.every(observer => observer.disconnected)); run.dispose();
});

test('a header created after dom-ready updates appearance through shallow body child changes only', async () => {
  const run = fixture(), view = run.create(editorURL, editorURL, true);
  view.contents.emit('dom-ready'); await tick();
  assert.equal(view.calls.some(call => call[0] === 'setBackgroundColor'), false);
  const observer = view.observers.find(item => item.targets.some(target =>
    target.node === view.document.body && target.options.childList === true));
  assert.ok(observer, 'Late editor creation must be observed on the direct body children');
  const target = observer.targets.find(item => item.node === view.document.body);
  assert.equal(target.options.subtree, undefined, 'Canvas and SVG descendants must not be observed');
  view.document.menubar = view.document.createElement('div');
  view.document.menubar.backgroundColor = 'rgb(27, 29, 30)';
  observer.callback([{type: 'childList', target: view.document.body}]); await tick();
  assert.deepEqual(view.calls.at(-1), ['setBackgroundColor', '#1b1d1e']);
  view.rendererWindow.__diagramdeskNativeWindowControls.dispose(); run.dispose();
});

test('only the original own main frame may request known commands', () => {
  const run = fixture(), view = run.create();
  assert.equal(run.request(view, 'state').accepted, true);
  assert.equal(run.request(view, 'unknown').accepted, false);
  assert.equal(run.request(view, 'state', {...view.contents.mainFrame, frameTreeNodeId: 999}).accepted, false);
  assert.equal(run.request(view, 'state', undefined, {windowId: 999}).accepted, false);
  for (const external of [run.create('https://example.invalid/'), run.create(editorURL, 'https://example.invalid/')]) {
    assert.equal(run.request(external, 'maximize').accepted, false);
    assert.equal(run.request(external, 'state').accepted, false);
  }
  run.dispose();
});

test('commands route by sender webContents and invoke positive BrowserWindow APIs', () => {
  const run = fixture(), first = run.create(), second = run.create();
  run.request(first, 'minimize'); run.request(first, 'toggle'); run.request(first, 'toggle');
  first.flags.fullscreen = true; run.request(first, 'toggle'); run.request(first, 'close');
  assert.deepEqual(first.calls, [['minimize'], ['maximize'], ['unmaximize'], ['setFullScreen', false], ['close']]);
  assert.deepEqual(second.calls, []);
  run.dispose();
});

test('state is read from actual native APIs including capabilities and zoom', () => {
  const run = fixture(), view = run.create();
  Object.assign(view.flags, {maximized: true, fullscreen: true, minimizable: false, maximizable: false, closable: false, zoom: 1.5});
  const reply = run.request(view, 'state');
  assert.equal(reply.state.isMaximized, true); assert.equal(reply.state.isFullScreen, true);
  assert.equal(reply.state.isMinimizable, false); assert.equal(reply.state.isMaximizable, false); assert.equal(reply.state.isClosable, false);
  assert.equal(reply.state.zoomFactor, 1.5);
  assert.equal(run.request(view, 'minimize').accepted, false); assert.equal(run.request(view, 'close').accepted, false);
  run.dispose();
});

test('only original editor dom-ready hides Ark buttons and installs renderer controls', async () => {
  const run = fixture(), view = run.create(), foreign = run.create('https://example.invalid/'), wrongFrame = run.create(editorURL, 'https://example.invalid/');
  assert.deepEqual(view.calls, []);
  for (const item of [view, foreign, wrongFrame]) item.contents.emit('dom-ready');
  await tick();
  assert.deepEqual(view.calls, [['setWindowButtonVisibility', false]]); assert.equal(view.executions.length, 1);
  assert.deepEqual(foreign.calls, []); assert.deepEqual(wrongFrame.calls, []);
  run.dispose();
});

test('renderer creates three real HDS image buttons at native DIP dimensions and reacts to actual state', async () => {
  const run = fixture(), view = run.create(editorURL, editorURL, true);
  view.flags.zoom = 1.25; view.contents.emit('dom-ready'); await tick();
  const min = view.document.getElementById('drawio-caption-最小化'), max = view.document.getElementById('drawio-caption-最大化');
  const close = view.document.getElementById('drawio-caption-关闭');
  assert.equal(min.tagName, 'BUTTON'); assert.equal(max.tagName, 'BUTTON'); assert.equal(close.tagName, 'BUTTON');
  for (const control of [min, max, close]) {
    assert.equal(control.style.width, '36px'); assert.equal(control.style.height, '32px');
    assert.equal(control.children[0].style.width, '20px'); assert.equal(control.children[0].style.height, '20px');
    assert.equal(control.children[0].style.pointerEvents, 'none');
  }
  assert.equal(max.parentNode.style.width, '108px'); assert.equal(max.parentNode.style.height, '32px');
  assert.equal(max.children[0].tagName, 'IMG'); assert.equal(max.children[0].src, icons.maximize);
  assert.equal(max.children[0].style.width, '20px'); assert.equal(max.parentNode.style.transform, 'scale(0.8)');
  let prevented = 0, stopped = 0;
  max.listeners.click({preventDefault: () => prevented++, stopPropagation: () => stopped++});
  await tick(); assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.ok(view.document.getElementById('drawio-caption-还原'));
  view.flags.fullscreen = true; view.window.emit('enter-full-screen'); await tick();
  const exit = view.document.getElementById('drawio-caption-退出全屏'); assert.equal(exit.children[0].src, icons.restore);
  exit.click(); await tick(); assert.ok(view.calls.some(call => call[0] === 'setFullScreen' && call[1] === false));
  run.dispose();
});

test('blank title single click does nothing and double click uses the same native toggle as the HDS button', async () => {
  const run = fixture(), view = run.create(editorURL, editorURL, true);
  view.contents.emit('dom-ready'); await tick(); view.calls.length = 0;
  const title = view.document.getElementById('drawio-caption-title');
  assert.ok(title, 'The blank title region must receive renderer double clicks');
  title.click(); await tick();
  assert.deepEqual(view.calls, []);
  const event = {button: 0, preventDefault() {}, stopPropagation() {}};
  title.listeners.dblclick(event); await tick();
  assert.deepEqual(view.calls, [['maximize']]);
  assert.ok(view.document.getElementById('drawio-caption-还原'));
  title.listeners.dblclick(event); await tick();
  assert.deepEqual(view.calls, [['maximize'], ['unmaximize']]);
  view.flags.fullscreen = true;
  title.listeners.dblclick(event); await tick();
  assert.deepEqual(view.calls.at(-1), ['setFullScreen', false]);
  title.listeners.dblclick({...event, button: 2}); await tick();
  assert.equal(view.calls.length, 3, 'Right-button double clicks must not toggle the window');
  run.dispose();
});

test('blank title hit area follows native DIP geometry at different renderer zoom levels and is disposed', async () => {
  const run = fixture(), view = run.create(editorURL, editorURL, true);
  view.flags.zoom = 1.25; view.contents.emit('dom-ready'); await tick();
  const title = view.document.getElementById('drawio-caption-title');
  assert.ok(title);
  assert.equal(title.style.left, '192px'); assert.equal(title.style.right, '86.4px');
  assert.equal(title.style.height, '25.6px'); assert.equal(title.style.webkitAppRegion, 'no-drag');
  view.flags.zoom = 2; view.contents.emit('zoom-changed'); await tick();
  assert.equal(title.style.left, '120px'); assert.equal(title.style.right, '54px');
  assert.equal(title.style.height, '16px');
  view.rendererWindow.__diagramdeskNativeWindowControls.dispose();
  assert.equal(view.document.getElementById('drawio-caption-title'), undefined);
  run.dispose();
});

test('the renderer uses byte-identical original HDS SVG resources through the bootstrap asset loader', () => {
  for (const name of ['minimize', 'maximize', 'restore', 'close']) {
    const original = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/resources/base/media/window_' + name + '.svg', import.meta.url));
    const copied = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/window-controls/window_' + name + '.svg', import.meta.url));
    assert.ok(copied.equals(original), 'HDS SVG bytes changed: ' + name);
  }
  const bootstrap = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /\.\/window-controls\/window_/);
  assert.match(bootstrap, /installNativeWindowControls\(electron\.app, electron\.ipcMain, electron\.BrowserWindow/);
});

test('resize, maximize, fullscreen and focus listeners update state without duplicate listeners', async () => {
  const run = fixture(), view = run.create();
  view.contents.emit('dom-ready'); view.contents.emit('dom-ready'); await tick();
  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus']) {
    assert.equal(view.window.listenerCount(event), 1);
    const before = view.executions.length; view.window.emit(event); await tick(); assert.ok(view.executions.length > before);
  }
  run.dispose();
});

test('destroy and uninstall remove all host listeners', async () => {
  const run = fixture(), first = run.create(), second = run.create();
  first.contents.emit('dom-ready'); second.contents.emit('dom-ready'); await tick();
  first.contents.emit('destroyed');
  assert.equal(first.contents.listenerCount('dom-ready'), 0); assert.equal(first.window.listenerCount('resize'), 0);
  run.dispose(); run.dispose();
  assert.equal(second.contents.listenerCount('dom-ready'), 0); assert.equal(second.window.listenerCount('focus'), 0);
  assert.equal(run.app.listenerCount('web-contents-created'), 0); assert.equal(run.ipcMain.listenerCount(requestChannel), 0);
});

test('initial capabilities are sampled before hiding Ark buttons and are never changed', async () => {
  const run = fixture(), view = run.create(); let hidden = false, sampled = 0;
  for (const name of ['isMinimizable', 'isMaximizable', 'isClosable']) {
    view.window[name] = () => { assert.equal(hidden, false); sampled++; return true; };
  }
  view.window.setWindowButtonVisibility = visible => { assert.equal(visible, false); assert.equal(sampled, 3); hidden = true; };
  view.contents.emit('dom-ready'); await tick();
  assert.equal(hidden, true); assert.equal(sampled, 3);
  run.dispose();
});

test('a destroyed native sender is rejected without throwing into the IPC dispatcher', () => {
  const run = fixture(), view = run.create();
  view.contents.getURL = () => { throw Error('Object destroyed'); };
  assert.doesNotThrow(() => assert.equal(run.request(view, 'toggle').accepted, false));
  assert.deepEqual(view.calls, []);
  run.dispose();
});

test('OHOS without the macOS-only JS visibility setter still initializes without an uncaught exception', async () => {
  const run = fixture(), view = run.create();
  delete view.window.setWindowButtonVisibility;
  assert.doesNotThrow(() => view.contents.emit('dom-ready'));
  await tick();
  assert.equal(view.executions.length, 1);
  assert.deepEqual(view.calls, []);
  run.dispose();
});

test('a visibility adapter error cannot escape the dom-ready event', async () => {
  const run = fixture(), view = run.create();
  view.window.setWindowButtonVisibility = () => { throw Error('Native widget is not ready'); };
  assert.doesNotThrow(() => view.contents.emit('dom-ready'));
  await tick();
  assert.equal(view.executions.length, 1);
  run.dispose();
});

test('synchronous renderer evaluation failure cannot terminate the main process', t => {
  t.mock.method(console, 'error', () => {});
  const run = fixture(), view = run.create();
  view.contents.executeJavaScript = () => { throw Error('Renderer destroyed during initialization'); };
  assert.doesNotThrow(() => view.contents.emit('dom-ready'));
  run.dispose();
});
