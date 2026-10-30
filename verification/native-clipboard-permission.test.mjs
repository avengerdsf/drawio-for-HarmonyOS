import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const project = new URL('../', import.meta.url);
const readJson = name => JSON.parse(fs.readFileSync(new URL(name, project), 'utf8'));

test('clipboard reads declare one foreground user permission for the actual UI abilities', () => {
  const module = readJson('harmony-electron/electron/src/main/module.json5').module;
  const har = readJson('harmony-electron/web_engine/src/main/module.json5').module;
  const requested = (module.requestPermissions ?? []).filter(item => item.name === 'ohos.permission.READ_PASTEBOARD');
  assert.equal(requested.length, 1, 'native clipboard reads require a declared permission before a system prompt can appear');
  assert.equal(requested[0].reason, '$string:access_pasteboard');
  assert.equal(requested[0].usedScene.when, 'inuse');
  const abilities = module.abilities;
  assert.deepEqual(new Set(requested[0].usedScene.abilities), new Set(abilities.map(ability => ability.name)));
  assert.equal(har.requestPermissions.filter(item => item.name === 'ohos.permission.READ_PASTEBOARD').length, 0,
    'the HAR must not repeat the entry permission declaration');
  assert.deepEqual(module.deviceTypes, ['2in1']);
  assert.deepEqual(har.deviceTypes, ['2in1']);
});

test('every supported language provides a paste-purpose permission reason without implementation details', () => {
  for (const locale of ['base', 'en_US', 'zh_CN']) {
    const entries = readJson(`harmony-electron/web_engine/src/main/resources/${locale}/element/string.json`).string;
    const reasons = entries.filter(item => item.name === 'access_pasteboard');
    assert.equal(reasons.length, 1, locale);
    assert.ok(reasons[0].value.trim().length > 10, locale);
    assert.doesNotMatch(reasons[0].value, /user_grant|ohos\.permission|ACL/i, locale);
    assert.match(reasons[0].value, /粘贴|paste/i, locale);
  }
});
