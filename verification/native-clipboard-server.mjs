import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}

export function createClipboardFixture() {
  const runId = crypto.randomUUID();
  const marker = 'drawio-owned-' + runId;
  const width = 64, height = 48, pixels = Buffer.alloc(width * height * 4);
  const seed = crypto.createHash('sha256').update(runId).digest();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, alternate = ((x >> 3) + (y >> 3)) % 2;
    pixels[at] = alternate ? seed[0] : 240;
    pixels[at + 1] = alternate ? 200 : seed[1];
    pixels[at + 2] = alternate ? seed[2] : 40;
    pixels[at + 3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.concat(Array.from({length: height}, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4)])));
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const htmlToken = marker + ' HTML';
  const html = `<div data-drawio-owned="${runId}"><b>${htmlToken}</b> <i>中文富文本</i></div>`;
  return {png, config: {runId, marker, cases: {
    text: {text: marker + ' 中文纯文本'},
    html: {text: htmlToken + ' 中文富文本', html, token: htmlToken},
    png: {width, height, pixelSha256: hash(pixels), pngSha256: hash(png), dataUrl: 'data:image/png;base64,' + png.toString('base64')},
    graph: {labels: [marker + ' 节点甲', marker + ' 节点乙'], edge: marker + ' 连线'}
  }}};
}

export function sanitizeClipboardResult(value, runId) {
  if (!value || value.runId !== runId || !['text', 'html', 'png', 'graph'].includes(value.case) ||
    !['browser-copy', 'browser-read', 'browser-paste', 'browser-recopy-graph'].includes(value.operation)) throw Error('Invalid fixture result identity');
  const allowed = new Set(['runId', 'case', 'operation', 'ok', 'owned', 'reason', 'types', 'width', 'height', 'sha256', 'pixelSha256', 'vertices', 'edges', 'bold', 'italic', 'htmlPresent', 'textPresent']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw Error('Only result metadata is accepted');
  const result = {runId, case: value.case, operation: value.operation, ok: value.ok === true, owned: value.owned === true};
  if (!result.owned) return {...result, ok: false, reason: 'not-owned'};
  for (const key of ['width', 'height', 'vertices', 'edges']) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 100000) result[key] = value[key];
  for (const key of ['sha256', 'pixelSha256']) if (/^[a-f0-9]{64}$/.test(value[key])) result[key] = value[key];
  for (const key of ['bold', 'italic', 'htmlPresent', 'textPresent']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Array.isArray(value.types) && value.types.every(type => ['text/plain', 'text/html', 'image/png'].includes(type))) result.types = value.types;
  if (['api-unavailable', 'permission-or-api-error', 'not-owned', 'type-missing', 'pixel-mismatch', 'graph-mismatch'].includes(value.reason)) result.reason = value.reason;
  return result;
}

export function fixturePage(config) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>draw.io 原生剪贴板验收</title><style>body{font:20px sans-serif;padding:24px;color:#222}button{font:inherit;padding:16px;margin:8px}#sink{border:2px solid #246;padding:20px;min-height:100px}#status{white-space:pre-wrap}img{image-rendering:pixelated;width:128px;height:96px}</style>
<h1>draw.io 原生剪贴板验收</h1><p id="marker"></p><div>
<button id="copy-text">复制文本</button><button id="copy-html">复制HTML</button><button id="copy-png">复制PNG</button></div><div>
<button id="read-text">读取文本</button><button id="read-html">读取HTML</button><button id="read-png">读取PNG</button><button id="read-graph">读取图形</button><button id="recopy-graph" disabled>再复制图形</button></div>
<p>点击相应读取按钮后，也可在下框执行真实粘贴；只显示本次标记，陌生内容不会展示。</p><div id="sink" contenteditable="true" role="textbox" aria-label="粘贴验收接收区"></div><pre id="status">准备中</pre>
<script>
const config=${JSON.stringify(config)}, status=document.getElementById('status'), sink=document.getElementById('sink');
document.getElementById('marker').textContent=config.marker;
let expected='text', graphText=null, pngBlob=null;
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
const post=async result=>{const body={runId:config.runId,...result};await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});status.textContent=JSON.stringify(result,null,2);};
const fail=(kind,operation,reason)=>post({case:kind,operation,ok:false,owned:false,reason});
async function pixels(blob){const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();return{width:canvas.width,height:canvas.height,pixelSha256:await digest(context.getImageData(0,0,canvas.width,canvas.height).data)};}
async function inspect(kind, values, operation){
 const plain=values['text/plain']?await values['text/plain'].text():null, html=values['text/html']?await values['text/html'].text():null;
 let result={case:kind,operation,ok:false,owned:false,types:Object.keys(values)};
 if(kind==='text'){
  if(plain!==config.cases.text.text)return fail(kind,operation,'not-owned');
  result={...result,ok:true,owned:true,textPresent:true,sha256:await digest(new TextEncoder().encode(plain))};sink.textContent=config.cases.text.text;
 }else if(kind==='html'){
  if(!html)return fail(kind,operation,'type-missing');
  const doc=new DOMParser().parseFromString(html,'text/html'),text=doc.body.textContent.replace(/\\s+/g,' ').trim();
  if(text!==config.cases.html.text)return fail(kind,operation,'not-owned');
  const bold=!!doc.querySelector('b,strong'),italic=!!doc.querySelector('i,em');
  result={...result,ok:bold&&italic,owned:true,htmlPresent:true,textPresent:plain===config.cases.html.text,bold,italic,sha256:await digest(new TextEncoder().encode(text))};sink.textContent=config.cases.html.text;
 }else if(kind==='png'){
  if(!values['image/png'])return fail(kind,operation,'type-missing');
  const image=await pixels(values['image/png']);
  if(image.width!==config.cases.png.width||image.height!==config.cases.png.height||image.pixelSha256!==config.cases.png.pixelSha256)return fail(kind,operation,'pixel-mismatch');
  result={...result,...image,ok:true,owned:true};sink.textContent='本次PNG像素匹配';
 }else{
  if(!plain)return fail(kind,operation,'type-missing');
  let xml=plain;try{if(!xml.trim().startsWith('<'))xml=decodeURIComponent(xml);}catch{return fail(kind,operation,'graph-mismatch');}
  const doc=new DOMParser().parseFromString(xml,'text/xml'),cells=Array.from(doc.querySelectorAll('mxCell')),vertices=cells.filter(c=>c.getAttribute('vertex')==='1'),edges=cells.filter(c=>c.getAttribute('edge')==='1');
  const labels=vertices.map(c=>c.getAttribute('value'));
  if(doc.querySelector('parsererror')||doc.documentElement.tagName!=='mxGraphModel'||vertices.length!==2||edges.length!==1||!cells.every(cell=>!cell.getAttribute('value')||[...config.cases.graph.labels,config.cases.graph.edge].includes(cell.getAttribute('value')))||!config.cases.graph.labels.every(label=>labels.includes(label))||edges[0].getAttribute('value')!==config.cases.graph.edge)return fail(kind,operation,'graph-mismatch');
  graphText=plain;document.getElementById('recopy-graph').disabled=false;
  result={...result,ok:true,owned:true,vertices:2,edges:1,sha256:await digest(new TextEncoder().encode(plain))};sink.textContent='本次两节点一连线图形已验证';
 }
 await post(result);
}
async function copy(kind){expected=kind;try{
 if(kind==='text')await navigator.clipboard.writeText(config.cases.text.text);
 else if(kind==='html')await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([config.cases.html.text],{type:'text/plain'}),'text/html':new Blob([config.cases.html.html],{type:'text/html'})})]);
 else{if(!pngBlob)throw Error('not-ready');await navigator.clipboard.write([new ClipboardItem({'image/png':pngBlob})]);}
 await post({case:kind,operation:'browser-copy',ok:true,owned:true});
}catch{await fail(kind,'browser-copy','permission-or-api-error');}}
async function read(kind){expected=kind;try{const values={};for(const item of await navigator.clipboard.read())for(const type of item.types)if(['text/plain','text/html','image/png'].includes(type)&&!values[type])values[type]=await item.getType(type);await inspect(kind,values,'browser-read');}catch{await fail(kind,'browser-read','permission-or-api-error');}}
for(const kind of ['text','html','png'])document.getElementById('copy-'+kind).onclick=()=>copy(kind);
for(const kind of ['text','html','png','graph'])document.getElementById('read-'+kind).onclick=()=>read(kind);
document.getElementById('recopy-graph').onclick=async()=>{try{if(!graphText)throw Error();await navigator.clipboard.writeText(graphText);await post({case:'graph',operation:'browser-recopy-graph',ok:true,owned:true,sha256:await digest(new TextEncoder().encode(graphText))});}catch{await fail('graph','browser-recopy-graph','permission-or-api-error');}};
sink.addEventListener('paste',async event=>{event.preventDefault();const values={},data=event.clipboardData;if(data.types.includes('text/plain'))values['text/plain']=new Blob([data.getData('text/plain')],{type:'text/plain'});if(data.types.includes('text/html'))values['text/html']=new Blob([data.getData('text/html')],{type:'text/html'});for(const item of data.items)if(item.type==='image/png'){values['image/png']=item.getAsFile();break;}try{await inspect(expected,values,'browser-paste');}catch{await fail(expected,'browser-paste','permission-or-api-error');}});
fetch('/owned.png').then(response=>response.blob()).then(blob=>{pngBlob=blob;window.fixtureReady=true;status.textContent='准备完成';});
</script>`;
}

export function createClipboardServer(fixture, output) {
  const results = [];
  const state = () => ({runId: fixture.config.runId, port: 19335, results});
  const save = () => { if (output) fs.writeFileSync(output, JSON.stringify(state(), null, 2)); };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/config') return response.end(JSON.stringify(fixture.config));
    if (request.method === 'GET' && url.pathname === '/state') return response.end(JSON.stringify(state()));
    if (request.method === 'GET' && url.pathname === '/owned.png') { response.setHeader('content-type', 'image/png'); return response.end(fixture.png); }
    if (request.method === 'GET' && ['/', '/fixture'].includes(url.pathname)) { response.setHeader('content-type', 'text/html; charset=utf-8'); return response.end(fixturePage(fixture.config)); }
    if (request.method === 'POST' && url.pathname === '/result') {
      try {
        const chunks = []; let size = 0;
        for await (const part of request) { size += part.length; if (size > 4096) throw Error('Result too large'); chunks.push(part); }
        results.push({...sanitizeClipboardResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), fixture.config.runId), at: new Date().toISOString()});
        save(); return response.end('{"accepted":true}');
      } catch { response.statusCode = 400; return response.end('{"accepted":false}'); }
    }
    response.statusCode = 404; response.end();
  });
  return {server, state, save};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.join(root, 'tmp/native-clipboard'); fs.mkdirSync(directory, {recursive: true});
  const fixture = createClipboardFixture();
  const {server, save} = createClipboardServer(fixture, path.join(directory, 'browser-results.json'));
  server.listen(19335, '127.0.0.1', () => { save(); console.log(JSON.stringify({pid: process.pid, port: 19335, url: 'http://127.0.0.1:19335/fixture', runId: fixture.config.runId})); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { save(); server.close(() => process.exit(0)); });
}
