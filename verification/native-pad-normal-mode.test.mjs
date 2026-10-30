import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const root = new URL('../harmony-electron/web_engine/src/main/ets/', import.meta.url);
const tick = () => new Promise(setImmediate);
const status = {UNDEFINED: 0, FULL_SCREEN: 1, MAXIMIZE: 2, FLOATING: 4, MINIMIZE: 3};
function members(file, className, names) {
  const text = fs.readFileSync(new URL(file, root), 'utf8').replace('export struct ' + className, 'export class ' + className);
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === className).members
    .filter(node => names.includes(node.name?.getText(parsed)))
    .map(node => node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
}
function compile(source, globals) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText,
    {exports, ...globals});
  return exports;
}
function fixture(options = {}) {
  const calls = [], listeners = new Map(), keyObservers = [], errors = [];
  let free = options.free === true, cachedFree = false, decorVisible = true, sharedStorage, initialStatusBarHeight;
  let nativeRect = {left: 0, top: 0, width: 2880, height: 1920};
  const geometry = {rect: [], size: []};
  const context = {};
  const deviceInfo = {deviceType: options.deviceType ?? 'tablet', sdkApiVersion: 26};
  const settings = {domainName: {USER_PROPERTY: 1},
    getValueSync(_context, key) { return key === 'window_pcmode_switch_status' ? String(free) : ''; },
    registerKeyObserver(_context, _key, _domain, callback) { keyObservers.push(callback); return true; }};
  class LocalStorage extends Map { setOrCreate(key, value) { this.set(key, value); } constructor(data) { super(Object.entries(data ?? {})); } }
  const native = {
    getWindowStatus: () => status.FULL_SCREEN,
    getWindowProperties: () => ({id: 1320, displayId: 0, windowRect: {...nativeRect},
      drawableRect: {left: 0, top: 0, width: nativeRect.width, height: nativeRect.height}}),
    getWindowAvoidArea: () => ({topRect: {height: options.statusBarHeight ?? 78}}),
    on(event, callback) { listeners.set(event, callback); calls.push(['on', event]); },
    setWindowDecorVisible(value) { calls.push(['decor', value]); if (options.decorUnsupported) throw {code: 801}; decorVisible = value; },
    setWindowTitleButtonVisible(...args) { calls.push(['buttons', ...args]); if (!free) throw {code: 801}; },
    setWindowTitleMoveEnabled(value) { calls.push(['move', value]); if (!free) throw {code: 801}; },
    setResizeByDragEnabled(value) { calls.push(['resize', value]); if (!free) throw {code: 801}; return Promise.resolve(); },
    setWindowLayoutFullScreen(value) { calls.push(['layout', value]); return Promise.resolve(); },
    setSpecificSystemBarEnabled(name, visible) { calls.push(['bar', name, visible]); return Promise.resolve(); },
    setWindowSystemBarProperties() { return Promise.resolve(); },
    getWindowLimits: () => ({}), getUIContext: () => ({px2vp: value => value}),
    setTitleAndDockHoverShown: () => Promise.resolve()
  };
  const globals = {TAG: 'normal-pad-test', window: {WindowStatusType: status, WindowEventType: {WINDOW_SHOWN: 1}, AvoidAreaType: {TYPE_SYSTEM: 0}, MaximizePresentation: {EXIT_IMMERSIVE: 1}},
    WindowStatus: status, deviceInfo, settings, LocalStorage, getContext: () => context, vp2px: value => value,
    WindowModeCatalog: {subscribe(_context, callback) {
      keyObservers.push(callback);
      return () => { const index = keyObservers.indexOf(callback); if (index >= 0) keyObservers.splice(index, 1); };
    }},
    LogUtil: {info() {}, warn() {}, error(...args) { errors.push(args); }},
    WindowStyle: {registerUpdateStyleFunction() {}, removeUpdateStyleFunction() {}}, ConfigData: {DEFAULT_WINDOW_ID: 'browser0'}};
  const baseCode = members('ability/WebBaseAbility.ets', 'WebBaseAbility', ['updateAvoidAreaStatus']);
  const abilityCode = members('ability/WebAbility.ets', 'WebAbility', ['onWindowStageCreate', 'onPadWindowStageCreate', 'configureWindowDecor',
    'getWindowContentBounds', 'updateContentStatusBarHeight']);
  const {Subject} = compile('class WebBaseAbility {' + baseCode + '\nonWindowStageCreate() {}}\nexport class Subject extends WebBaseAbility {' + abilityCode + '}', globals);
  const subject = new Subject();
  Object.assign(subject, {context, xcomponentId: 'browser3', hideTitleBar: options.framed !== true, show: options.visible !== false,
    resizable: true, maximizable: true, minimizable: true, closable: true, cmdArgs: [], isModal: false, isPanel: false,
    nativeContext: {RegisterWindowEventFilter() {}, SetSystemWindowLimits() {}, OnWindowEvent() {}, OnAvoidAreaChangeCallback() {},
      OnWindowRectChange(_id, bounds) { geometry.rect.push(JSON.parse(JSON.stringify(bounds))); },
      OnWindowSizeChange(_id, bounds) { geometry.size.push(JSON.parse(JSON.stringify(bounds))); }},
    getWindow: () => native, checkSingleInstance: () => false, getContentPath: () => 'pages/NodeHandleWindow',
    getWindowPreferences: () => ({hideTitleBar: options.framed !== true}),
    abilityManager: {addProxy() {}},
    contextAdapter: {updateWindowPcmodeSwitchStatus() { calls.push(['refresh-mode', free]); cachedFree = free; },
      isPadNormalModel: () => deviceInfo.deviceType === 'tablet' && !cachedFree}});
  const stage = {getMainWindowSync: () => native, getMainWindow: callback => callback({code: 0}, native),
    loadContent(_path, storage, callback) { sharedStorage = storage; initialStatusBarHeight = storage.get('statusBarHeight'); calls.push(['loaded']); callback({code: 0}); }, on() {},
    setWindowModal: () => Promise.resolve()};
  return {subject, stage, native, calls, listeners, errors, deviceInfo, settings, geometry,
    getInitialStatusBarHeight: () => initialStatusBarHeight, setRect(rect) { nativeRect = {...rect}; }, getDecor: () => decorVisible, getStorage: () => sharedStorage,
    switchMode(value) { free = value; decorVisible = true; for (const callback of keyObservers) callback(); }};
}

test('normal Pad initialization does not call free-window-only buttons, resize or move APIs', async () => {
  const run = fixture(); assert.doesNotThrow(() => run.subject.onWindowStageCreate(run.stage)); await tick();
  assert.equal(run.calls.some(call => ['buttons', 'resize', 'move'].includes(call[0])), false);
  assert.equal(run.getDecor(), false); assert.ok(run.listeners.has('avoidAreaChange'));
  assert.deepEqual(run.calls.filter(call => call[0] === 'bar' && call[1] === 'status').at(-1), ['bar', 'status', true]);
  assert.equal(run.getStorage().get('nativeCaptionNormalPadMode'), true);
});

test('an unsupported decoration API cannot prevent normal Pad immersive layout and listeners', async () => {
  const run = fixture({decorUnsupported: true}); assert.doesNotThrow(() => run.subject.onWindowStageCreate(run.stage)); await tick();
  assert.ok(run.listeners.has('avoidAreaChange'));
  assert.ok(run.calls.some(call => call[0] === 'layout' && call[1] === true));
  assert.deepEqual(run.calls.filter(call => call[0] === 'bar' && call[1] === 'status').at(-1), ['bar', 'status', true]);
});

test('actual free-window setting is loaded before capability guards run', async () => {
  const run = fixture({free: true}); run.subject.onWindowStageCreate(run.stage); await tick();
  const refreshed = run.calls.findIndex(call => call[0] === 'refresh-mode');
  const buttons = run.calls.findIndex(call => call[0] === 'buttons');
  assert.ok(refreshed >= 0 && refreshed < buttons);
  assert.ok(run.calls.some(call => call[0] === 'move' && call[1] === false));
  assert.equal(run.getStorage().get('nativeCaptionNormalPadMode'), false);
});

test('mode switch back to normal preserves the clock and hides custom caption areas', async () => {
  const run = fixture({free: true}); run.subject.onWindowStageCreate(run.stage); await tick();
  run.calls.length = 0; run.switchMode(false); await tick();
  assert.equal(run.getDecor(), false);
  assert.deepEqual(run.calls.filter(call => call[0] === 'bar' && call[1] === 'status').at(-1), ['bar', 'status', true]);
  assert.equal(run.getStorage().get('nativeCaptionNormalPadMode'), true);
  assert.equal(run.calls.some(call => ['buttons', 'resize', 'move'].includes(call[0])), false);
});

test('ordinary normal Pad updates keep the system clock visible', async () => {
  const run = fixture(); run.subject.updateAvoidAreaStatus(false); await tick();
  assert.deepEqual(run.calls.filter(call => call[0] === 'bar'), [['bar', 'navigationIndicator', false], ['bar', 'status', true]]);
});

test('explicit fullscreen still hides the system clock', async () => {
  const run = fixture(); run.subject.updateAvoidAreaStatus(true); await tick();
  assert.deepEqual(run.calls.filter(call => call[0] === 'bar' && call[1] === 'status'), [['bar', 'status', false]]);
});

test('normal Pad native drag row is excluded by the actual local-storage mode', () => {
  const source = fs.readFileSync(new URL('components/NativeWindowCaption.ets', root), 'utf8');
  assert.match(source, /@LocalStorageProp\('nativeCaptionNormalPadMode'\)\s+normalPadMode:\s*boolean/);
  assert.match(source, /if\s*\(this\.visible\s*&&\s*this\.preferences\.hideTitleBar\s*&&\s*!this\.normalPadMode\)/);
});

function backgroundFixture(normal = true, legacyStyle) {
  const calls = [];
  const style = {getStyleData: () => legacyStyle, decimalColorToHex: value => (value >>> 0).toString(16).padStart(8, '0'),
    getUpdateStyleFunc: () => data => calls.push(['legacy-update', data.backgroundColor]),
    updateStyleData: (_id, data) => calls.push(['legacy-store', data.backgroundColor])};
  const code = members('adapter/AppWindowAdapter.ets', 'AppWindowAdapter', ['setBackgroundColor']);
  const {Adapter} = compile('export class Adapter {' + code + '}', {TAG: 'test', WindowStyle: style, LogUtil: {info() {}, error() {}}});
  const native = {setWindowBackgroundColor: color => calls.push(['background', color]),
    setWindowSystemBarProperties: properties => { calls.push(['status-properties', JSON.parse(JSON.stringify(properties))]); return Promise.resolve(); }};
  const adapter = new Adapter(); adapter.getWindow = () => native;
  adapter.ctxAdapter = {isPadNormalModel: () => normal};
  return {adapter, calls};
}

test('NodeHandle native background is updated without legacy WindowStyle registration', async () => {
  const run = backgroundFixture(); run.adapter.setBackgroundColor(3, 0xff1b1d1e); await tick();
  assert.deepEqual(run.calls.filter(call => call[0] === 'background'), [['background', '#ff1b1d1e']]);
});

for (const [color, lightIcons] of [[0xff1b1d1e, true], [0xfff0f0f0, false]]) {
  test('normal Pad transparent status foreground follows actual native background ' + color.toString(16), async () => {
    const run = backgroundFixture(); run.adapter.setBackgroundColor(3, color); await tick();
    assert.deepEqual(run.calls.filter(call => call[0] === 'status-properties'), [['status-properties', {
      statusBarColor: '#00000000', isStatusBarLightIcon: lightIcons
    }]]);
  });
}

test('free-window backgrounds keep their system status styling unchanged', async () => {
  const run = backgroundFixture(false); run.adapter.setBackgroundColor(3, 0xfff0f0f0); await tick();
  assert.deepEqual(run.calls, [['background', '#fff0f0f0']]);
});

test('registered legacy styles still update alongside the native window background', async () => {
  const run = backgroundFixture(false, {backgroundColor: 'ffffffff', opacity: 1});
  run.adapter.setBackgroundColor(3, 0xff1b1d1e); await tick();
  assert.deepEqual(run.calls, [['legacy-update', 'ff1b1d1e'], ['legacy-store', 'ff1b1d1e'], ['background', '#ff1b1d1e']]);
});

for (const options of [{free: true}, {deviceType: '2in1'}, {framed: true}]) {
  test('existing status visibility is retained outside normal frameless Pad ' + JSON.stringify(options), async () => {
    const run = fixture(options); run.subject.updateAvoidAreaStatus(false); await tick();
    assert.deepEqual(run.calls.filter(call => call[0] === 'bar' && call[1] === 'status'), [['bar', 'status', true]]);
  });
}

test('avoid-area listener is installed before requests that can emit the zero-height status area', async () => {
  const run = fixture(); run.subject.updateAvoidAreaStatus = () => run.calls.push(['update-avoid']);
  run.subject.onPadWindowStageCreate(run.native, {setOrCreate() {}});
  assert.ok(run.calls.findIndex(call => call[0] === 'on' && call[1] === 'avoidAreaChange') <
    run.calls.findIndex(call => call[0] === 'update-avoid'));
});

test('setUseNativeFrame avoids PC-only button calls in normal Pad', () => {
  const run = fixture();
  const code = members('adapter/AppWindowAdapter.ets', 'AppWindowAdapter', ['setUseNativeFrame']);
  const {Adapter} = compile('export class Adapter {' + code + '}', {TAG: 'test', LogUtil: {info() {}, error() {}}});
  const adapter = new Adapter(); adapter.getWindow = () => run.native;
  adapter.ctxAdapter = {isPadNormalModel: () => true};
  adapter.setUseNativeFrame(3, false);
  assert.equal(run.calls.some(call => call[0] === 'buttons'), false);
  assert.equal(run.getDecor(), false);
});

test('initial NodeHandle viewport receives the existing status height before loadContent', async () => {
  const run = fixture(); run.subject.onWindowStageCreate(run.stage); await tick();
  assert.equal(run.getInitialStatusBarHeight(), 78);
  const code = members('components/WebNodeHandleWindow.ets', 'WebNodeHandleWindow', ['setDefaultBounds']);
  const {NodeHandle} = compile('export class NodeHandle {' + code + '}', {ConfigData: {DEFAULT_WINDOW_ID: 'browser3'}});
  let initialized;
  const component = new NodeHandle(); Object.assign(component, {xComponentId: 'browser3', window: run.native,
    statusBarHeight: run.getInitialStatusBarHeight() ?? 0,
    nativeContext: {OnWindowInitState() {}, OnWindowInitSize(_windowRect, drawable) { initialized = JSON.parse(JSON.stringify(drawable)); }}});
  component.setDefaultBounds();
  assert.deepEqual(initialized, {left: 0, top: 78, width: 2880, height: 1842});
});

test('unchanged initial avoid area still publishes a viewport contained within the native window', async () => {
  const run = fixture({statusBarHeight: 96}); run.subject.onWindowStageCreate(run.stage); await tick();
  assert.deepEqual(run.geometry.rect.at(-1), {left: 0, top: 96, width: 2880, height: 1824});
});

for (const event of ['windowSizeChange', 'windowRectChange', 'windowEvent']) {
  test(event + ' cannot overwrite normal Pad safe-area viewport with the whole window size', async () => {
    const run = fixture(); run.subject.onWindowStageCreate(run.stage); await tick();
    run.geometry.rect.length = 0; run.geometry.size.length = 0;
    if (event === 'windowSizeChange') run.listeners.get(event)({width: 2880, height: 1920});
    else if (event === 'windowRectChange') run.listeners.get(event)({rect: {left: 0, top: 0, width: 2880, height: 1920}, reason: 0});
    else run.listeners.get(event)(1);
    assert.deepEqual((event === 'windowSizeChange' ? run.geometry.size : run.geometry.rect).at(-1),
      {left: 0, top: 78, width: 2880, height: 1842});
  });
}

test('a later status-area update and resize share the same measured content bounds', async () => {
  const run = fixture(); run.subject.onWindowStageCreate(run.stage); await tick();
  run.listeners.get('avoidAreaChange')({type: 0, area: {topRect: {height: 96}}});
  run.setRect({left: 30, top: 50, width: 2400, height: 1600});
  run.listeners.get('windowSizeChange')({width: 2400, height: 1600});
  assert.deepEqual(run.geometry.size.at(-1), {left: 30, top: 146, width: 2400, height: 1504});
});

for (const options of [{free: true}, {visible: false}]) {
  test('free or hidden export viewport keeps zero status-height compensation ' + JSON.stringify(options), async () => {
    const run = fixture(options); run.subject.onWindowStageCreate(run.stage); await tick();
    assert.equal(run.getInitialStatusBarHeight(), 0);
    run.listeners.get('windowSizeChange')({width: 2880, height: 1920});
    assert.deepEqual(run.geometry.size.at(-1), {left: 0, top: 0, width: 2880, height: 1920});
  });
}
