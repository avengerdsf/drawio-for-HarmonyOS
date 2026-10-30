import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../harmony-electron/web_engine/src/main/ets');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const log = {info() {}, error() {}};

function fixture() {
  const values = new Map(), exports = {};
  const AppStorage = {setOrCreate(key, value) { if (!values.has(key)) values.set(key, value); },
    link: key => ({get: () => values.get(key)})};
  const imports = {inversify: {injectable: () => value => value}, './Constants': {ConfigData: {WINDOW_PREFIX: 'browser'}},
    '../utils/LogUtil': {default: log}};
  const managerCode = ts.transpileModule(source('common/AbilityManager.ets'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true}
  }).outputText;
  vm.runInNewContext(managerCode, {exports, AppStorage, require: name => {
    assert.ok(name in imports, 'Unexpected manager dependency: ' + name); return imports[name];
  }});
  const manager = new exports.AbilityManager();
  const parsed = ts.createSourceFile('DialogAdapter.ts', source('adapter/DialogAdapter.ets'), ts.ScriptTarget.Latest, true);
  const klass = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'DialogAdapter');
  const method = klass.members.find(node => node.name?.getText(parsed) === 'showMessageBox');
  const dialogCode = ts.transpileModule('export class DialogCase {' + method.getText(parsed).replace(/^@LogMethod\s*/, '') + '}', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const dialogExports = {};
  vm.runInNewContext(dialogCode, {exports: dialogExports, LogUtil: log, TAG: 'Dialog'});
  const dialog = new dialogExports.DialogCase(); dialog.abilityManager = manager; dialog.convertImagePixelMap = () => undefined;
  function register(id = 'browser7', options = {}) {
    const calls = [], host = {id, setMessageBoxParams: params => { host.params = params; },
      dialogController: {open() { calls.push('open'); }, close() {
        calls.push('close'); options.close?.(); if (options.throwClose) throw Error('Window already destroyed');
      }}};
    manager.addMessageBox(host); return {host, calls};
  }
  function show(callback, extra = {}) {
    const settings = {parent_id: 7, type: 'question', title: 'Unsaved', message: 'Save changes?', detail: '',
      checkbox_label: '', checkbox_checked: true, cancel_id: 2, default_id: 0, buttons: ['Save', 'Discard', 'Cancel'], ...extra};
    dialog.showMessageBox(JSON.stringify(settings), new ArrayBuffer(0), 0, 0, callback);
  }
  return {manager, register, show};
}

test('destroyed message box completes the original native cancel id once and removes its registry entry', () => {
  const run = fixture(), {host, calls} = run.register(), results = [];
  run.show((...args) => results.push(args)); const lateClick = host.params.callback;
  run.manager.removeMessageBox(7); run.manager.removeMessageBox('browser7'); lateClick(1, false);
  assert.deepEqual(results, [[2, true]], 'Destruction must report Cancel, never Discard');
  assert.deepEqual(calls, ['open', 'close']); assert.equal(run.manager.getMessageBox(7), undefined);
});

test('a destroyed native controller throwing during close still cancels its pending callback once', () => {
  const run = fixture(), {host} = run.register('browser7', {throwClose: true}), results = [];
  run.show((...args) => results.push(args));
  assert.doesNotThrow(() => run.manager.removeMessageBox(7)); host.params.callback(0, false);
  assert.deepEqual(results, [[2, true]]);
});

test('a normal foreground button response is preserved and later destruction cannot cancel it again', () => {
  const run = fixture(), {host} = run.register(), results = [];
  run.show((...args) => results.push(args)); host.params.callback(1, false); host.params.callback(0, true);
  run.manager.removeMessageBox(7);
  assert.deepEqual(results, [[1, false]], 'The real Discard click must keep its original response');
});

test('cancel callback reentry may register a fresh host with the same id without removing it', () => {
  const run = fixture(); run.register(); let replacement;
  run.show(() => { replacement = run.register().host; }); run.manager.removeMessageBox(7);
  assert.ok(replacement); assert.equal(run.manager.getMessageBox(7), replacement);
});

test('a missing parent resolves to the provided cancel id instead of leaving the native caller suspended', () => {
  const run = fixture(), results = [];
  run.show((...args) => results.push(args), {cancel_id: 0, checkbox_checked: false});
  assert.deepEqual(results, [[0, false]]);
});

test('replacing a pending message box settles the former request and keeps the new callback independent', () => {
  const run = fixture(), {host} = run.register(), first = [], second = [];
  run.show((...args) => first.push(args)); const lateClick = host.params.callback;
  run.show((...args) => second.push(args), {cancel_id: 0, checkbox_checked: false});
  assert.deepEqual(first, [[2, true]]); lateClick(1, false); assert.equal(first.length, 1);
  host.params.callback(1, false); run.manager.removeMessageBox(7);
  assert.deepEqual(second, [[1, false]]);
});

test('replacement cancellation that destroys its host cannot reopen a detached controller', () => {
  const run = fixture(), {calls} = run.register(), second = [];
  run.show(() => run.manager.removeMessageBox(7));
  run.show((...args) => second.push(args));
  assert.deepEqual(second, [[2, true]]); assert.equal(calls.filter(name => name === 'open').length, 1);
});

test('component disappearance and main stage destruction both invoke message-box cleanup', () => {
  const nodeHandle = source('components/WebNodeHandleWindow.ets');
  const disappearance = nodeHandle.slice(nodeHandle.indexOf('aboutToDisappear()'), nodeHandle.indexOf('  build()'));
  assert.match(disappearance, /this\.abilityManager\.removeMessageBox\(this\.xComponentId\)/);
  const ability = source('ability/WebAbility.ets');
  const destroy = ability.slice(ability.indexOf('  onWindowStageDestroy()'), ability.indexOf('  onNewWant('));
  assert.match(destroy, /this\.abilityManager\?\.removeMessageBox\(this\.xcomponentId\)/);
  assert.ok(destroy.indexOf('removeMessageBox') < destroy.indexOf('removeProxy'));
});
