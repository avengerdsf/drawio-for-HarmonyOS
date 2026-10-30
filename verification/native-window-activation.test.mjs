import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const tick = () => new Promise(resolve => setImmediate(resolve));

function activationCase({ability = 'EntryAbility', id = 3, proxyMissing = false, contextMissing = false,
  start = () => Promise.resolve()} = {}) {
  const source = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/ets/adapter/AppWindowAdapter.ets', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('AppWindowAdapter.ets', source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppWindowAdapter');
  const methods = declaration.members.filter(node => ['showWindow', 'activateWindow'].includes(node.name?.getText(parsed)))
    .map(node => node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
  const code = ts.transpileModule('export class Subject {' + methods + '}', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const calls = [], flags = [], errors = [], exports = {};
  let trayCalls = 0;
  const context = {
    abilityInfo: {name: ability},
    startAbility(...args) {calls.push(JSON.parse(JSON.stringify(args))); return start();},
    showAbility() {trayCalls++; return Promise.reject({code: 16000067});}
  };
  const proxy = {getWindowContext: () => contextMissing ? undefined : context, getWindowId: () => 'browser' + id};
  vm.runInNewContext(code, {exports, TAG: 'window-activation',
    LogUtil: {info() {}, error(...args) {errors.push(args);}}});
  const subject = new exports.Subject();
  Object.assign(subject, {bundleName: 'com.example.diagramdesk',
    abilityManager: {getProxy: value => value === id && !proxyMissing ? proxy : undefined},
    getWindow: value => ({getUIContext: () => ({getSharedLocalStorage: () => ({set: (key, value) => flags.push({id, key, value})})})})});
  return {subject, calls, flags, errors, trayCalls: () => trayCalls};
}

test('an ordinary editor reuses its specified UIAbility without the status-bar-only show API', async () => {
  let ready;
  const run = activationCase({start: () => new Promise(resolve => {ready = resolve;})});
  run.subject.showWindow(3);
  assert.deepEqual(run.calls, [[{bundleName: 'com.example.diagramdesk', abilityName: 'EntryAbility',
    parameters: {instanceKey: 'browser3'}}]]);
  assert.equal(run.trayCalls(), 0);
  assert.deepEqual(run.flags, []);
  ready();
  await tick();
  assert.deepEqual(run.flags, [{id: 3, key: 'nativeCaptionVisible', value: true}]);
});

test('activation preserves the target ability identity and instance instead of creating another editor', async () => {
  const run = activationCase({ability: 'StatelessAbility', id: 11});
  run.subject.activateWindow(11);
  assert.deepEqual(run.calls, [[{bundleName: 'com.example.diagramdesk', abilityName: 'StatelessAbility',
    parameters: {instanceKey: 'browser11'}}]]);
  await tick();
  assert.equal(run.flags.length, 1);
});

test('failed foreground activation leaves the caption hidden and reports the API error', async () => {
  const run = activationCase({start: () => Promise.reject({code: 16000050})});
  run.subject.showWindow(3);
  await tick();
  assert.equal(run.calls.length, 1);
  assert.equal(run.trayCalls(), 0);
  assert.deepEqual(run.flags, []);
  assert.ok(run.errors.length > 0);
});

test('missing proxies, contexts or ability names cannot start an unrelated instance', async () => {
  for (const options of [{proxyMissing: true}, {contextMissing: true}, {ability: ''}]) {
    const run = activationCase(options);
    assert.doesNotThrow(() => run.subject.showWindow(3));
    await tick();
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.flags, []);
    assert.equal(run.trayCalls(), 0);
  }
});
