import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {installLocalEditorResources} from '../harmony-electron/web_engine/src/main/resources/resfile/resources/app/renderer-resources.mjs';

const editor=new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/upstream/drawio/src/main/webapp/index.html',import.meta.url).href;
function setup(url,base){
  const app=new EventEmitter(),contents=new EventEmitter(),context={window:{DRAWIO_SERVER_URL:base}};
  contents.getURL=()=>url;
  contents.calls=0;
  contents.executeJavaScript=async source=>{contents.calls++;return vm.runInNewContext(source,context);};
  installLocalEditorResources(app,editor);
  app.emit('web-contents-created',{},contents);
  return {contents,context};
}
test('original Electron local base resolves the actual bundled Gliffy converter after document initialization',async()=>{
  const {contents,context}=setup(editor+'?dev=0','.');
  contents.emit('dom-ready');
  await new Promise(resolve=>setImmediate(resolve));
  const requested=new URL(context.window.DRAWIO_SERVER_URL+'js/gliffy/drawio-gliffy.min.js',editor);
  assert.ok(fs.existsSync(fileURLToPath(requested)),requested.href);
  assert.equal(contents.calls,1);
});
test('local editor reloads keep explicit resource bases and external configuration intact',async()=>{
  for(const base of ['./','https://example.invalid/resources/']){
    const {contents,context}=setup(editor,base);
    contents.emit('dom-ready');contents.emit('dom-ready');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(context.window.DRAWIO_SERVER_URL,base);
  }
});
test('external pages and the separate export renderer do not receive editor configuration injection',()=>{
  for(const url of ['https://example.invalid/index.html',new URL('export3.html',editor).href]){
    const {contents,context}=setup(url,'.');contents.emit('dom-ready');
    assert.equal(contents.calls,0);assert.equal(context.window.DRAWIO_SERVER_URL,'.');
  }
});
