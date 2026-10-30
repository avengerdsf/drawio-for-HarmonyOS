import { typeScriptPath, arktsLoaderPath } from './sdk-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'harmony-electron/web_engine/src/main/ets');
const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const source = file => fs.readFileSync(path.join(native, file), 'utf8');
const statuses = {UNDEFINED: 0, FLOATING: 4, MAXIMIZE: 2, FULL_SCREEN: 1, MINIMIZE: 3};
const touchTypes = {Down: 0, Up: 1, Move: 2, Cancel: 3};
console.log('Native caption logic tests use Node ' + process.version + '; no build, GUI or device is started');

function load(file, imports, globals = {}) {
  const result = ts.transpileModule(source(file), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true}
  });
  const exports = {};
  vm.runInNewContext(result.outputText, {exports, ...globals, require(name) {
    assert.ok(name in imports, 'Unexpected native dependency: ' + name);
    return imports[name];
  }});
  return exports;
}

function fixture() {
  const calls = [];
  const window = {status: statuses.FLOATING};
  const adapter = Object.fromEntries(['maximize', 'unMaximize', 'minimize', 'startWindowMoving'].map(name =>
    [name, id => calls.push([name, id])]));
  adapter.setFullScreen = (enabled, id) => calls.push(['setFullScreen', enabled, id]);
  adapter.getWindowStatus = id => { assert.equal(id, 7); return window.status; };
  const context = {OnWindowEvent: (...args) => calls.push(['OnWindowEvent', ...args])};
  const {WindowCaptionController} = load('common/WindowCaptionController.ets', {
    '@ohos.window': {default: {WindowStatusType: statuses}},
    './Constants': {ConfigData: {WINDOW_PREFIX: 'browser'}}
  }, {TouchType: touchTypes});
  const controller = new WindowCaptionController('browser7', adapter, context);
  return {controller, window, calls};
}

function adapterFixture(globals = {}) {
  const parsed = ts.createSourceFile('AppWindowAdapter.ts', source('adapter/AppWindowAdapter.ets'), ts.ScriptTarget.Latest, true);
  const adapter = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppWindowAdapter');
  const names = new Set(['boundsGeneration', 'normalBounds', 'rememberNormalBounds', 'getWindow', 'setBounds', 'applyBounds', 'setFullScreen', 'unMaximize',
    'maximize', 'syncCaptionStatus', 'closeWindow']);
  const methods = adapter.members.filter(node => names.has(node.name?.getText(parsed)))
    .map(node => node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
  const compiled = ts.transpileModule('export class AdapterCase { ' + methods + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, deviceInfo: {deviceType: '2in1'}, window: {WindowStatusType: statuses, MaximizePresentation: {EXIT_IMMERSIVE: 1, ENTER_IMMERSIVE: 2}},
    TAG: 'test', LogUtil: {info() {}, error() {}}, ...globals});
  const preferences = {hideTitleBar: true, maximizable: true, minimizable: false, closable: true};
  const moved = [], resized = [], recovered = [], captionStatus = [], terminated = [];
  let actualStatus = statuses.FLOATING;
  const nativeWindow = {
    getWindowProperties: () => ({displayId: 2, drawableRect: {left: 0, top: 0}}),
    getUIContext: () => ({getSharedLocalStorage: () => ({get: () => true, set: (key, value) => captionStatus.push([key, value])})}),
    getWindowStatus: () => actualStatus,
    moveWindowToAsync: (...values) => { moved.push(values); return Promise.resolve(); },
    resizeAsync: (...values) => { resized.push(values); return Promise.resolve(); }
  };
  nativeWindow.recover = () => { recovered.push(true); actualStatus = statuses.FLOATING; return Promise.resolve(); };
  nativeWindow.maximize = mode => { actualStatus = mode === 1 ? statuses.MAXIMIZE : statuses.FULL_SCREEN; return Promise.resolve(); };
  nativeWindow.setTitleAndDockHoverShown = () => Promise.resolve();
  const proxy = {getWindowPreferences: () => preferences, getWindow: () => nativeWindow,
    getWindowContext: () => ({terminateSelf: () => { terminated.push(true); return Promise.resolve(); }})};
  const subject = new exports.AdapterCase();
  subject.abilityManager = {getProxy: () => proxy};
  subject.deviceInfoAdapter = {isPcMode: () => true};
  return {subject, preferences, nativeWindow, moved, resized, recovered, captionStatus, terminated};
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return {promise, resolve, reject};
}

for (const olderResult of ['resolve', 'reject']) {
  for (const newerResult of ['resolve', 'reject']) {
    test('latest bounds request wins when B ' + newerResult + ' completes before delayed A ' + olderResult, async () => {
      const older = deferred(), newer = deferred();
      const pending = [older, newer];
      const {subject, moved, resized} = adapterFixture({display: {getDisplayByIdSync() {
        return {getAvailableArea: () => pending.shift().promise};
      }}});
      subject.setBounds(7, false, {left: 100, top: 100, width: 800, height: 600});
      subject.setBounds(7, false, {left: 200, top: 200, width: 900, height: 650});
      const area = {left: 0, top: 0, width: 2000, height: 1400};
      newer[newerResult](newerResult === 'resolve' ? area : new Error('newer area unavailable'));
      await new Promise(setImmediate);
      older[olderResult](olderResult === 'resolve' ? area : new Error('older area unavailable'));
      await new Promise(setImmediate);
      assert.deepEqual(moved, [[200, 200]]);
      assert.deepEqual(resized, [[900, 650]]);
    });
  }
}

test('an older completed move cannot resize over a newer bounds request', async () => {
  const olderMove = deferred();
  const {subject, nativeWindow, moved, resized} = adapterFixture({display: {getDisplayByIdSync() {
    return {getAvailableArea: async () => ({left: 0, top: 0, width: 2000, height: 1400})};
  }}});
  nativeWindow.moveWindowToAsync = (...values) => {
    moved.push(values);
    return values[0] === 100 ? olderMove.promise : Promise.resolve();
  };
  subject.setBounds(7, false, {left: 100, top: 100, width: 800, height: 600});
  await new Promise(setImmediate);
  subject.setBounds(7, false, {left: 200, top: 200, width: 900, height: 650});
  await new Promise(setImmediate);
  olderMove.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(moved, [[100, 100], [200, 200]]);
  assert.deepEqual(resized, [[900, 650]]);
});

test('visible caption programmatic bounds fit the actual window display physical work area', async () => {
  const displays = [];
  const {subject, moved, resized} = adapterFixture({display: {getDisplayByIdSync(id) {
    displays.push(id);
    return {getAvailableArea: async () => ({left: 2880, top: 78, width: 1920, height: 1080})};
  }}});
  const requested = {left: 4800, top: -100, width: 2880, height: 1598};
  subject.setBounds(7, false, requested);
  await new Promise(setImmediate);
  assert.deepEqual(displays, [2]);
  assert.deepEqual(moved, [[2880, 78]]);
  assert.deepEqual(resized, [[1920, 1080]]);
  assert.deepEqual(requested, {left: 4800, top: -100, width: 2880, height: 1598});
});

test('normal floating bounds remain exact and show:false export windows retain oversized capture bounds', async () => {
  const {subject, nativeWindow, moved, resized} = adapterFixture({display: {getDisplayByIdSync(id) {
    assert.equal(id, 2);
    return {getAvailableArea: async () => ({left: 2880, top: 78, width: 1920, height: 1080})};
  }}});
  subject.setBounds(7, false, {left: 3000, top: 100, width: 1200, height: 800});
  await new Promise(setImmediate);
  assert.deepEqual(moved, [[3000, 100]]);
  assert.deepEqual(resized, [[1200, 800]]);
  nativeWindow.getUIContext = () => ({getSharedLocalStorage: () => ({get: () => false})});
  subject.setBounds(7, false, {left: -10, top: -20, width: 6000, height: 4000});
  await new Promise(setImmediate);
  assert.deepEqual(moved.at(-1), [-10, -20]);
  assert.deepEqual(resized.at(-1), [6000, 4000]);
});

test('runtime fullscreen exit uses the real adapter recover path', async () => {
  const {subject, recovered} = adapterFixture();
  subject.setFullScreen(false, 7);
  await new Promise(setImmediate);
  assert.deepEqual(recovered, [true]);
});

test('frameless caption fullscreen disables title and dock hover after maximize finishes, before syncing status', async () => {
  const entered = deferred(), hoverSet = deferred();
  const {subject, nativeWindow} = adapterFixture();
  const calls = [];
  nativeWindow.maximize = mode => { assert.equal(mode, 2); calls.push('maximize'); return entered.promise; };
  nativeWindow.setTitleAndDockHoverShown = (title, dock) => {
    calls.push(['hover', title, dock]);
    return hoverSet.promise;
  };
  subject.syncCaptionStatus = (id, rawWindow) => {
    assert.equal(id, 7);
    assert.equal(rawWindow, nativeWindow);
    calls.push('sync');
  };
  subject.setFullScreen(true, 7);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['maximize']);
  entered.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['maximize', ['hover', false, false]]);
  hoverSet.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['maximize', ['hover', false, false], 'sync']);
});

for (const mode of ['framed', 'hidden-export', 'no-native-caption']) {
  test('fullscreen leaves title and dock hover unchanged for ' + mode + ' windows', async () => {
    const {subject, nativeWindow, preferences} = adapterFixture();
    let hovered = 0, synced = 0;
    if (mode === 'framed') preferences.hideTitleBar = false;
    else {
      const storage = nativeWindow.getUIContext().getSharedLocalStorage();
      nativeWindow.getUIContext = () => ({getSharedLocalStorage: () => ({...storage,
        get: key => key === 'nativeCaptionVisible' ? (mode === 'hidden-export' ? false : undefined) : storage.get(key)})});
    }
    nativeWindow.setTitleAndDockHoverShown = () => { hovered++; return Promise.resolve(); };
    subject.syncCaptionStatus = () => { synced++; };
    subject.setFullScreen(true, 7);
    await new Promise(setImmediate);
    assert.equal(hovered, 0);
    assert.equal(synced, 1);
  });
}

test('a rejected hover setting still publishes the actual fullscreen status', async () => {
  const {subject, nativeWindow, captionStatus} = adapterFixture();
  let attempted = false;
  nativeWindow.setTitleAndDockHoverShown = () => { attempted = true; return Promise.reject(new Error('not supported')); };
  subject.setFullScreen(true, 7);
  await new Promise(setImmediate);
  assert.equal(attempted, true);
  assert.deepEqual(captionStatus, [['nativeCaptionStatus', statuses.FULL_SCREEN]]);
});

test('successful window operations publish the raw native status enum to caption storage', async () => {
  const {subject, captionStatus} = adapterFixture();
  subject.maximize(7);
  await new Promise(setImmediate);
  subject.unMaximize(7);
  await new Promise(setImmediate);
  subject.setFullScreen(true, 7);
  await new Promise(setImmediate);
  subject.setFullScreen(false, 7);
  await new Promise(setImmediate);
  assert.deepEqual(captionStatus, [['nativeCaptionStatus', statuses.MAXIMIZE], ['nativeCaptionStatus', statuses.FLOATING],
    ['nativeCaptionStatus', statuses.FULL_SCREEN], ['nativeCaptionStatus', statuses.FLOATING]]);
});

test('accepted window close clears its bounds generation and invalidates a delayed area result', async () => {
  const pending = deferred();
  const {subject, moved, resized, terminated} = adapterFixture({display: {getDisplayByIdSync() {
    return {getAvailableArea: () => pending.promise};
  }}});
  subject.setBounds(7, false, {left: 100, top: 100, width: 800, height: 600});
  assert.equal(subject.boundsGeneration.size, 1);
  subject.closeWindow(7);
  assert.equal(subject.boundsGeneration.size, 0);
  pending.resolve({left: 0, top: 0, width: 2000, height: 1400});
  await new Promise(setImmediate);
  assert.deepEqual(terminated, [true]);
  assert.deepEqual(moved, []);
  assert.deepEqual(resized, []);
});

test('the existing WebAbility raw status callback publishes primitive status and preserves native forwarding', () => {
  const parsed = ts.createSourceFile('WebAbility.ts', source('ability/WebAbility.ets'), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'on' &&
      node.arguments[0]?.text === 'windowStatusChange') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(callback);
  const compiled = ts.transpileModule('export class Owner { callback = ' + callback.getText(parsed) + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, window: {WindowStatusType: statuses}});
  const owner = new exports.Owner();
  const forwarded = [], published = [];
  owner.xcomponentId = 'browser1';
  owner.nativeContext = {OnWindowStatusChange: (...args) => forwarded.push(args)};
  owner.captionStorage = {set: (...args) => published.push(args)};
  const rawWindow = new EventEmitter();
  rawWindow.on('windowStatusChange', owner.callback);
  for (const status of [statuses.MAXIMIZE, statuses.FULL_SCREEN, statuses.FLOATING]) rawWindow.emit('windowStatusChange', status);
  assert.deepEqual(forwarded, [['browser1', 2], ['browser1', 1], ['browser1', 4]]);
  assert.deepEqual(published, [['nativeCaptionStatus', 2], ['nativeCaptionStatus', 1], ['nativeCaptionStatus', 4]]);
  assert.match(source('ability/WebAbility.ets'), /'nativeCaptionStatus': windowStage\.getMainWindowSync\(\)\.getWindowStatus\(\)/);
});

test('native caption minimizes and toggles maximize / recover through the existing adapter', () => {
  const {controller, window, calls} = fixture();
  controller.minimize();
  controller.toggleMaximize();
  window.status = statuses.MAXIMIZE;
  controller.toggleMaximize();
  window.status = statuses.FULL_SCREEN;
  controller.toggleMaximize();
  assert.deepEqual(calls, [['minimize', 7], ['maximize', 7], ['unMaximize', 7], ['setFullScreen', false, 7]]);
});

test('native overlay keeps only the drag region and passes the right 108 DIP through to renderer controls', () => {
  const loader = arktsLoaderPath();
  const arkts = require(path.join(loader, 'node_modules/typescript/lib/typescript.js'));
  const config = arkts.readConfigFile(path.join(loader, 'tsconfig.json'), file => fs.readFileSync(file, 'utf8')).config;
  const text = source('components/NativeWindowCaption.ets');
  const parsed = arkts.createSourceFile('NativeWindowCaption.ets', text, arkts.ScriptTarget.Latest, true,
    arkts.ScriptKind.ETS, config.compilerOptions);
  const component = parsed.statements.find(node => arkts.isStructDeclaration(node));
  assert.doesNotMatch(text, /captionButton|isExpanded|nativeCaptionStatus|\bButton\(|\bImage\(/);
  assert.match(text, /Blank\(\)\.width\(240\)\.hitTestBehavior\(HitTestMode\.None\)/);
  assert.match(text, /Blank\(\)\.width\(108\)\.height\(32\)\.hitTestBehavior\(HitTestMode\.None\)/);
  assert.match(text, /this\.visible && this\.preferences\.hideTitleBar/);
  assert.match(text, /\.hitTestBehavior\(HitTestMode\.Transparent\)/);
  const handlers = [];
  function visit(node) {
    if (arkts.isCallExpression(node) && arkts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'onTouch') handlers.push(node.arguments[0]);
    arkts.forEachChild(node, visit);
  }
  visit(component);
  assert.equal(handlers.length, 1, 'Only the native drag region handles touch');
  const compiled = ts.transpileModule('export class Drag { handler = ' + handlers[0].getText(parsed) + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {}, TouchType = {Down: 0, Up: 1, Move: 2};
  vm.runInNewContext(compiled, {exports, TouchType});
  const forwarded = [];
  const drag = new exports.Drag();
  drag.controller = {handleTouch: event => forwarded.push(event)};
  const events = [TouchType.Move, TouchType.Up, TouchType.Down].map(type => ({type}));
  for (const event of events) drag.handler(event);
  assert.deepEqual(forwarded, events);
  assert.match(text, /\.id\('drawio-caption-drag'\)\s*\.hitTestBehavior\(HitTestMode\.Transparent\)/);
});

test('setBounds captures an immutable narrowed Window reference for asynchronous callbacks', () => {
  const parsed = ts.createSourceFile('AppWindowAdapter.ts', source('adapter/AppWindowAdapter.ets'), ts.ScriptTarget.Latest, true);
  const adapter = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppWindowAdapter');
  const bounds = adapter.members.find(node => node.name?.getText(parsed) === 'setBounds');
  const declaration = bounds.body.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(value => value.name.getText(parsed) === 'windowClass'));
  assert.ok(declaration.declarationList.flags & ts.NodeFlags.Const);
});

test('close follows the existing windowStageClose Electron event instead of terminating the ability', () => {
  const {controller, calls} = fixture();
  controller.close();
  assert.deepEqual(calls, [['OnWindowEvent', 'browser7', 1000]]);
  assert.match(source('ability/WebAbility.ets'), /WINDOW_CLOSE: number = 1000/);
  assert.match(source('ability/WebAbility.ets'), /OnWindowEvent\(this\.xcomponentId, WebAbility\.WINDOW_CLOSE\)/);
});

test('caption drag delegates to the existing native moving API', () => {
  const {controller, calls} = fixture();
  controller.startMoving();
  assert.deepEqual(calls, [['startWindowMoving', 7]]);
});

test('title press, release and pointer jitter never start moving or restore an expanded window', () => {
  const {controller, window, calls} = fixture();
  const touch = (type, displayX, displayY) => ({type, touches: [{id: 1, displayX, displayY}]});
  for (const status of [statuses.FLOATING, statuses.MAXIMIZE, statuses.FULL_SCREEN]) {
    window.status = status;
    controller.handleTouch(touch(touchTypes.Down, 100, 40));
    controller.handleTouch(touch(touchTypes.Move, 102, 41));
    controller.handleTouch(touch(touchTypes.Up, 102, 41));
  }
  assert.deepEqual(calls, []);
});

test('title drag starts once only after a held pointer crosses the movement threshold', () => {
  const {controller, calls} = fixture();
  const touch = (type, displayX, displayY) => ({type, touches: [{id: 1, displayX, displayY}]});
  controller.handleTouch(touch(touchTypes.Move, 200, 100));
  controller.handleTouch(touch(touchTypes.Down, 100, 40));
  controller.handleTouch(touch(touchTypes.Move, 109, 40));
  controller.handleTouch(touch(touchTypes.Move, 120, 45));
  assert.deepEqual(calls, [['startWindowMoving', 7]]);
  controller.handleTouch(touch(touchTypes.Up, 120, 45));
  controller.handleTouch(touch(touchTypes.Move, 140, 50));
  assert.equal(calls.length, 1);
});

test('cancelled, empty or multi-pointer title input cannot resume a previous drag', () => {
  const {controller, calls} = fixture();
  const touch = (type, displayX, displayY) => ({type, touches: [{id: 1, displayX, displayY}]});
  for (const ending of [{type: touchTypes.Cancel, touches: []}, {type: touchTypes.Move, touches: []},
    {type: touchTypes.Move, touches: [{id: 1, displayX: 100, displayY: 40}, {id: 2, displayX: 120, displayY: 50}]}]) {
    controller.handleTouch(touch(touchTypes.Down, 100, 40));
    controller.handleTouch(ending);
    controller.handleTouch(touch(touchTypes.Move, 150, 80));
  }
  assert.deepEqual(calls, []);
});

test('caption lifecycle shares a lazy adapter singleton without storing or listening to a NAPI Window', () => {
  assert.doesNotMatch(source('components/NativeWindowCaption.ets'), /@LocalStorage(?:Link|Prop)\('window'\)/);
  require(path.join(root, 'harmony-electron/web_engine/oh_modules/reflect-metadata/Reflect.js'));
  const inversify = require(path.join(root, 'harmony-electron/web_engine/oh_modules/inversify/lib/inversify.js'));
  const {default: Inject} = load('common/InjectModule.ets', {
    inversify,
    './ModuleType': {MODULE_TYPE: {Context: Symbol('test-context')}}
  }, {Reflect});
  let created = 0;
  class AppWindowAdapter { constructor() { created++; } }
  inversify.decorate(inversify.injectable(), AppWindowAdapter);
  Inject.inject({createDependency: () => ({
    getContext: () => ({}),
    getCommonModule: () => new inversify.ContainerModule(() => {}),
    getAdapterModule: () => new inversify.ContainerModule(() => {})
  })});
  assert.throws(() => Inject.get(AppWindowAdapter), /No matching bindings found for serviceIdentifier: AppWindowAdapter/);
  const loader = arktsLoaderPath();
  const arkts = require(path.join(loader, 'node_modules/typescript/lib/typescript.js'));
  const config = arkts.readConfigFile(path.join(loader, 'tsconfig.json'), file => fs.readFileSync(file, 'utf8')).config;
  const parsed = arkts.createSourceFile('NativeWindowCaption.ets', source('components/NativeWindowCaption.ets'),
    arkts.ScriptTarget.Latest, true, arkts.ScriptKind.ETS, config.compilerOptions);
  const component = parsed.statements.find(node => arkts.isStructDeclaration(node));
  const appearance = component.members.find(node => node.name?.getText(parsed) === 'aboutToAppear');
  assert.ok(appearance);
  const disappearance = component.members.find(node => node.name?.getText(parsed) === 'aboutToDisappear');
  const compiled = ts.transpileModule('export class CaptionLifecycle { ' + appearance.getText(parsed) + '\n' +
    disappearance.getText(parsed) + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {};
  const {WindowCaptionController} = load('common/WindowCaptionController.ets', {
    '@ohos.window': {default: {WindowStatusType: statuses}},
    './Constants': {ConfigData: {WINDOW_PREFIX: 'browser'}}
  });
  vm.runInNewContext(compiled, {exports, Inject, AppWindowAdapter, ContextType: {kMainProcess: 0},
    JsBindingUtils: {getNativeContext: () => ({})}, LogUtil: {info() {}},
    WindowCaptionController
  });
  try {
    const first = new exports.CaptionLifecycle();
    Object.assign(first, {xComponentId: 'browser1'});
    assert.doesNotThrow(() => first.aboutToAppear());
    assert.equal(first.controller.adapter, Inject.get(AppWindowAdapter));
    assert.equal(first.controller.window, undefined);
    assert.equal(first.controller.attach, undefined);
    assert.equal(first.controller.detach, undefined);
    const second = new exports.CaptionLifecycle();
    Object.assign(second, {xComponentId: 'browser2'});
    second.aboutToAppear();
    assert.equal(second.controller.adapter, first.controller.adapter);
    assert.equal(created, 1);
    first.aboutToDisappear();
    second.aboutToDisappear();
    assert.equal(first.controller, undefined);
    assert.equal(second.controller, undefined);
  } finally {
    Inject.destroy();
  }
});

test('frameless windows retain their Electron capabilities and propagate preference changes', () => {
  const {WebBaseAbility} = load('ability/WebBaseAbility.ets', {
    '@ohos.app.ability.UIAbility': {default: class {}},
    '@kit.BasicServicesKit': {deviceInfo: {deviceType: '2in1'}, settings: {}},
    '../utils/LogUtil': {default: {}},
    '../utils/JsBindingUtils': {default: {getNativeContext: () => ({})}},
    '../common/Constants': {ContextType: {kMainProcess: 0}},
    '../interface/CommonInterface': {WindowStatus: {FLOATING: 4}},
    '../utils/CheckEmptyUtils': {default: {}},
    '../application/WebAbilityStage': {WebAbilityStage: {}}
  });
  const ability = new WebBaseAbility();
  assert.deepEqual(JSON.parse(JSON.stringify(ability.getWindowPreferences())), {
    hideTitleBar: true, maximizable: true, minimizable: true, closable: true
  });
  const updates = [];
  ability.getWindow = () => ({getUIContext: () => ({getSharedLocalStorage: () => ({set: (...args) => updates.push(args)})})});
  ability.setWindowPreferences({hideTitleBar: true, maximizable: false, minimizable: true, closable: false});
  assert.equal(updates[0][0], 'nativeCaptionPreferences');
  assert.equal(updates[0][1].closable, false);
});

test('only main-window roots mount the overlay; hidden creations and explicit show/hide control its visibility', () => {
  for (const file of ['components/WebNodeHandleWindow.ets', 'components/WebWindow.ets']) {
    assert.match(source(file), /NativeWindowCaption\(\)/);
    assert.match(source(file), /Stack\(\{ alignContent: Alignment\.TopEnd \}\)/);
  }
  const adapter = source('adapter/AppWindowAdapter.ets');
  assert.match(adapter, /'show': param\.show/);
  assert.match(adapter, /set\('nativeCaptionVisible', true\)/);
  assert.match(adapter, /set\('nativeCaptionVisible', false\)/);
  assert.match(source('ability/WebAbility.ets'), /'nativeCaptionVisible': this\.show/);
  const caption = source('components/NativeWindowCaption.ets');
  assert.match(caption, /this\.visible && this\.preferences\.hideTitleBar/);
  assert.match(caption, /this\.controller\?\.handleTouch\(event\)/);
  assert.match(caption, /\.height\(32\)/);
  assert.match(caption, /\.width\(240\)/);
  assert.match(caption, /\.hitTestBehavior\(HitTestMode\.Transparent\)/);
  assert.doesNotMatch(caption, /terminateSelf|destroyWindow|\.closeWindow\(/);
});

test('changed native sources parse with the installed SDK ArkTS parser and its official ArkUI grammar settings', () => {
  const loader = arktsLoaderPath();
  const arkts = require(path.join(loader, 'node_modules/typescript/lib/typescript.js'));
  const config = arkts.readConfigFile(path.join(loader, 'tsconfig.json'), file => fs.readFileSync(file, 'utf8'));
  assert.equal(config.error, undefined);
  for (const file of ['common/WindowCaptionController.ets', 'components/NativeWindowCaption.ets',
    'components/WebNodeHandleWindow.ets', 'components/WebWindow.ets', 'ability/WebBaseAbility.ets',
    'ability/WebAbility.ets', 'adapter/AppWindowAdapter.ets']) {
    const parsed = arkts.createSourceFile(file, source(file), arkts.ScriptTarget.Latest, true,
      arkts.ScriptKind.ETS, config.config.compilerOptions);
    assert.deepEqual(parsed.parseDiagnostics.map(d => arkts.flattenDiagnosticMessageText(d.messageText, '\n')), [], file);
  }
});
