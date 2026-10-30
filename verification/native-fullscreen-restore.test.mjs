import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const statuses = {FLOATING: 4, MAXIMIZE: 2, FULL_SCREEN: 1};
const presentations = {EXIT_IMMERSIVE: 1, ENTER_IMMERSIVE: 2, ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER: 3};
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return {promise, resolve}; }
function fixture(options = {}) {
  const source = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/ets/adapter/AppWindowAdapter.ets', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('AppWindowAdapter.ets', source, ts.ScriptTarget.Latest, true);
  const klass = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppWindowAdapter');
  const names = new Set(['boundsGeneration', 'normalBounds', 'rememberNormalBounds', 'getWindow', 'setBounds', 'applyBounds',
    'setFullScreen', 'setSimpleFullScreen', 'maximize', 'unMaximize', 'syncCaptionStatus', 'closeWindow']);
  const members = klass.members.filter(node => names.has(node.name?.getText(parsed)))
    .map(node => node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
  const compiled = ts.transpileModule('export class Subject {' + members + '}', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {}, moves = [], sizes = [], hover = [], avoid = [], sync = [];
  vm.runInNewContext(compiled, {exports, TAG: 'fullscreen-test', deviceInfo: {deviceType: options.deviceType ?? '2in1'}, LogUtil: {info() {}, error() {}},
    window: {WindowStatusType: statuses, MaximizePresentation: presentations},
    display: {getDisplayByIdSync: () => ({getAvailableArea: async () => options.area ?? {left: 0, top: 78, width: 2880, height: 1842}})}});
  let status = statuses.FLOATING, rect = {left: 130, top: 180, width: 1560, height: 1080};
  const native = {
    getWindowStatus: () => status,
    getWindowProperties: () => ({displayId: 0, drawableRect: {left: 0, top: 0}, windowRect: {...rect}}),
    getUIContext: () => ({getSharedLocalStorage: () => ({get: () => options.visible !== false, set: (...args) => sync.push(args)})}),
    maximize: mode => {
      status = mode === presentations.EXIT_IMMERSIVE ? statuses.MAXIMIZE : statuses.FULL_SCREEN;
      rect = {left: 0, top: 0, width: 2880, height: 1920};
      return options.expand?.promise ?? Promise.resolve();
    },
    // The successful request may precede the final properties notification.
    recover: () => { status = statuses.FLOATING; return options.recover?.promise ?? Promise.resolve(); },
    setTitleAndDockHoverShown: (...args) => { hover.push(args); return options.hover?.promise ?? Promise.resolve(); },
    moveWindowToAsync: (left, top) => { moves.push([left, top]); rect = {...rect, left, top}; return Promise.resolve(); },
    resizeAsync: (width, height) => { sizes.push([width, height]); rect = {...rect, width, height}; return Promise.resolve(); }
  };
  const proxy = {getWindow: () => native, getWindowPreferences: () => ({hideTitleBar: true}),
    updateAvoidAreaStatus: enabled => avoid.push(enabled), getWindowContext: () => ({terminateSelf: async () => {}})};
  const subject = new exports.Subject();
  subject.abilityManager = {getProxy: () => proxy};
  subject.deviceInfoAdapter = {isPcMode: () => options.pc === true};
  return {subject, native, moves, sizes, hover, avoid, sync, setRect(value) { rect = {...value}; }, getRect: () => ({...rect})};
}

for (const method of ['maximize', 'setFullScreen', 'setSimpleFullScreen']) {
  test(method + ' restores the pre-expansion physical size when recover properties are stale', async () => {
    const run = fixture(); const before = run.getRect();
    if (method === 'maximize') run.subject.maximize(7); else run.subject[method](true, 7);
    await tick(); run.subject.unMaximize(7); await tick();
    assert.deepEqual(run.moves, [[before.left, before.top]]);
    assert.deepEqual(run.sizes, [[before.width, before.height]]);
    assert.deepEqual(run.getRect(), before);
  });
}

test('maximized to fullscreen keeps the last floating rectangle', async () => {
  const run = fixture(), before = run.getRect();
  run.subject.maximize(7); await tick(); run.subject.setFullScreen(true, 7); await tick();
  run.subject.setFullScreen(false, 7); await tick();
  assert.deepEqual(run.getRect(), before);
});

test('a new user resize becomes the next restore size', async () => {
  const run = fixture(); run.subject.setFullScreen(true, 7); await tick(); run.subject.setFullScreen(false, 7); await tick();
  const resized = {left: 260, top: 200, width: 1200, height: 900}; run.setRect(resized);
  run.subject.setFullScreen(true, 7); await tick(); run.subject.setFullScreen(false, 7); await tick();
  assert.deepEqual(run.getRect(), resized);
});

test('saved size is clamped only when it no longer fits the current work area', async () => {
  const run = fixture({area: {left: 0, top: 78, width: 1000, height: 800}});
  run.subject.setFullScreen(true, 7); await tick(); run.subject.setFullScreen(false, 7); await tick();
  assert.deepEqual(run.getRect(), {left: 0, top: 78, width: 1000, height: 800});
});

test('fullscreen hides the dock hover and synchronizes Pad system bars', async () => {
  const run = fixture(); run.subject.setFullScreen(true, 7); await tick();
  assert.deepEqual(run.hover, [[false, false]]); assert.deepEqual(run.avoid, [true]);
  run.subject.setFullScreen(false, 7); await tick(); assert.deepEqual(run.avoid, [true, false]);
});

test('simple fullscreen also synchronizes Pad system bars on entry and exit', async () => {
  const run = fixture(); run.subject.setSimpleFullScreen(true, 7); await tick();
  assert.deepEqual(run.avoid, [true]);
  run.subject.setSimpleFullScreen(false, 7); await tick(); assert.deepEqual(run.avoid, [true, false]);
});

test('an earlier recover completion cannot overwrite a newer fullscreen intent', async () => {
  const recover = deferred(), run = fixture({recover});
  run.subject.setFullScreen(true, 7); await tick();
  run.subject.setFullScreen(false, 7); run.subject.setFullScreen(true, 7); await tick();
  recover.resolve(); await tick(); assert.deepEqual(run.moves, []); assert.deepEqual(run.sizes, []);
  assert.equal(run.avoid.at(-1), true);
});

test('an earlier fullscreen completion cannot reapply fullscreen bars after restore', async () => {
  const expand = deferred(), run = fixture({expand});
  run.subject.setFullScreen(true, 7); run.subject.setFullScreen(false, 7); await tick();
  expand.resolve(); await tick(); assert.deepEqual(run.hover, []); assert.deepEqual(run.avoid, [false]);
});

test('hidden export windows retain the native recover behavior without resizing', async () => {
  const run = fixture({visible: false}); run.subject.setFullScreen(true, 7); await tick();
  run.subject.setFullScreen(false, 7); await tick(); assert.deepEqual(run.moves, []); assert.deepEqual(run.sizes, []);
});

test('desktop fullscreen does not apply Pad system bar settings', async () => {
  const run = fixture({pc: true}); run.subject.setFullScreen(true, 7); await tick(); run.subject.setFullScreen(false, 7); await tick();
  assert.deepEqual(run.avoid, []);
});

test('a Pad reporting PC window mode still hides its navigation indicator in fullscreen', async () => {
  const run = fixture({pc: true, deviceType: 'tablet'});
  run.subject.setFullScreen(true, 7); await tick();
  assert.deepEqual(run.avoid, [true]);
  run.subject.setFullScreen(false, 7); await tick(); assert.deepEqual(run.avoid, [true, false]);
});
