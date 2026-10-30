import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
function fixture(normalPadMode, foreground = true) {
  const source = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/ets/ability/WebAbility.ets', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('WebAbility.ets', source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'WebAbility');
  const method = declaration.members.find(node => node.name?.getText(parsed) === 'onPrepareToTerminate');
  const code = ts.transpileModule('export class Subject {' + method.getText(parsed) + '}', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {}, close = [];
  vm.runInNewContext(code, {exports, WebAbility: {WINDOW_CLOSE: 1000}});
  const subject = new exports.Subject();
  Object.assign(subject, {xcomponentId: 'browser7', lifecycleTraceForeground: foreground,
    contextAdapter: normalPadMode === undefined ? undefined : {isPadNormalModel: () => normalPadMode},
    nativeContext: {OnWindowEvent: (...args) => close.push(args)}});
  return {subject, close};
}

for (const foreground of [true, false]) {
  test('normal Pad task removal proceeds without starting a document-close dialog while foreground=' + foreground, () => {
    const run = fixture(true, foreground);
    assert.equal(run.subject.onPrepareToTerminate(), false);
    assert.deepEqual(run.close, []);
  });
}

for (const mode of ['free-window Pad', 'PC']) {
  test(mode + ' termination keeps the original Electron close confirmation route', () => {
    const run = fixture(false);
    assert.equal(run.subject.onPrepareToTerminate(), true);
    assert.deepEqual(run.close, [['browser7', 1000]]);
  });
}

test('unavailable mode information preserves the existing close-confirmation behavior', () => {
  const run = fixture(undefined);
  assert.equal(run.subject.onPrepareToTerminate(), true);
  assert.deepEqual(run.close, [['browser7', 1000]]);
});
