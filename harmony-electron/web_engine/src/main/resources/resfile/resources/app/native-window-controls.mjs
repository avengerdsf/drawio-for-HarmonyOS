import fs from 'node:fs';

const requestChannel = '__diagramdesk_window_controls_request_v1';
const replyChannel = '__diagramdesk_window_controls_reply_v1';
const baseURL = value => typeof value === 'string' ? value.split(/[?#]/, 1)[0] : '';

function renderControls(editorURL, icons, initial, requestChannel, replyChannel) {
  if (window.top !== window || window.location.href.split(/[?#]/, 1)[0] !== editorURL) return;
  if (window.__diagramdeskNativeWindowControls) { window.__diagramdeskNativeWindowControls.update(initial); return; }
  const bar = document.createElement('div'); bar.id = 'drawio-caption-controls';
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '窗口控件');
  Object.assign(bar.style, {position: 'fixed', right: '0', top: '0', width: '108px', height: '32px', display: 'flex',
    zIndex: '2147483647', background: 'transparent', transformOrigin: 'top right', webkitAppRegion: 'no-drag'});
  const title = document.createElement('div'); title.id = 'drawio-caption-title';
  Object.assign(title.style, {position: 'fixed', top: '0', zIndex: '2147483646', background: 'transparent', webkitAppRegion: 'no-drag'});
  let busy = false, disposed = false, normalPadMode, lastColor;
  function appearance(force = false) {
    if (disposed) return;
    for (let node = document.querySelector('.geMenubarContainer'); node; node = node.parentElement) {
      const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(getComputedStyle(node).backgroundColor);
      if (!match || match[4] !== undefined && Number(match[4]) !== 1) continue;
      const rgb = match.slice(1, 4).map(Number);
      if (rgb.some(value => value > 255)) continue;
      const color = '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
      if (force || color !== lastColor) {
        lastColor = color; window.electron.sendMessage(requestChannel, {action: 'appearance', color});
      }
      return;
    }
  }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => appearance()) : undefined;
  if (observer) {
    observer.observe(document.body, {attributes: true, attributeFilter: ['class', 'style'], childList: true});
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'style']});
    observer.observe(document.head, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled']});
  }
  function request(action) {
    if (busy || disposed) return;
    busy = true;
    window.electron.listenOnce(replyChannel, reply => {
      busy = false;
      if (!disposed && reply.accepted && reply.state) update(reply.state);
    });
    window.electron.sendMessage(requestChannel, {action});
  }
  function button(action) {
    const node = document.createElement('button'); node.type = 'button';
    Object.assign(node.style, {width: '36px', height: '32px', padding: '0', border: '0', borderRadius: '0',
      background: 'transparent', display: 'grid', placeItems: 'center', flex: '0 0 36px', webkitAppRegion: 'no-drag'});
    const image = document.createElement('img'); image.alt = ''; image.draggable = false;
    Object.assign(image.style, {width: '20px', height: '20px', pointerEvents: 'none', filter: 'brightness(0) invert(0.5333333333)'});
    node.appendChild(image);
    node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); request(action); });
    bar.appendChild(node);
    return {node, image};
  }
  const minimize = button('minimize'), toggle = button('toggle'), close = button('close');
  title.addEventListener('dblclick', event => {
    if (event.button !== 0 || normalPadMode) return;
    event.preventDefault(); event.stopPropagation(); request('toggle');
  });
  function set(control, label, icon, enabled) {
    control.node.id = 'drawio-caption-' + label; control.node.title = label;
    control.node.setAttribute('aria-label', label); control.node.disabled = !enabled; control.image.src = icon;
  }
  function update(state) {
    if (disposed) return;
    const modeChanged = normalPadMode !== state.normalPadMode;
    normalPadMode = state.normalPadMode;
    bar.style.display = normalPadMode ? 'none' : 'flex'; title.style.display = normalPadMode ? 'none' : 'block';
    bar.setAttribute('aria-hidden', String(normalPadMode)); title.setAttribute('aria-hidden', String(normalPadMode));
    bar.style.transform = 'scale(' + (1 / state.zoomFactor) + ')';
    Object.assign(title.style, {left: (240 / state.zoomFactor) + 'px', right: (108 / state.zoomFactor) + 'px', height: (32 / state.zoomFactor) + 'px'});
    set(minimize, '最小化', icons.minimize, !normalPadMode && state.isMinimizable);
    const restored = state.isFullScreen || state.isMaximized;
    set(toggle, state.isFullScreen ? '退出全屏' : state.isMaximized ? '还原' : '最大化',
      restored ? icons.restore : icons.maximize, !normalPadMode && (restored || state.isMaximizable));
    set(close, '关闭', icons.close, !normalPadMode && state.isClosable);
    appearance(modeChanged);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; observer?.disconnect(); bar.remove(); title.remove(); window.removeEventListener('unload', dispose);
    delete window.__diagramdeskNativeWindowControls;
  }
  window.__diagramdeskNativeWindowControls = {update, dispose};
  window.addEventListener('unload', dispose, {once: true});
  document.body.appendChild(title); document.body.appendChild(bar); update(initial);
}

export function installNativeWindowControls(app, ipcMain, BrowserWindow, editorURL, icons, modeFilePath) {
  for (const name of ['minimize', 'maximize', 'restore', 'close']) {
    if (typeof icons?.[name] !== 'string' || !/^data:image\/svg\+xml[,;]/.test(icons[name])) throw Error('HDS SVG data URLs are required');
  }
  const states = new Map(), events = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus'];
  let normalPadMode = false;
  function refreshMode() {
    try {
      const value = JSON.parse(fs.readFileSync(modeFilePath, 'utf8'));
      if (typeof value?.normalPadMode !== 'boolean' || value.normalPadMode === normalPadMode) return;
      normalPadMode = value.normalPadMode;
      for (const state of states.values()) state.update();
    } catch {}
  }
  if (modeFilePath) {
    refreshMode(); fs.watchFile(modeFilePath, {persistent: false, interval: 200}, refreshMode);
  }
  const isEditor = contents => {
    try { return baseURL(contents.getURL()) === editorURL && baseURL(contents.mainFrame?.url) === editorURL; }
    catch { return false; }
  };
  const snapshot = (window, contents) => ({isMaximized: window.isMaximized(), isFullScreen: window.isFullScreen(),
    isMinimizable: window.isMinimizable(), isMaximizable: window.isMaximizable(), isClosable: window.isClosable(), zoomFactor: contents.getZoomFactor(), normalPadMode});
  function onCreated(_event, contents) {
    if (states.has(contents)) return;
    let window;
    function detach() {
      if (window) for (const event of events) window.removeListener(event, update);
      window = undefined;
    }
    function update() {
      if (!window || !isEditor(contents)) return;
      try {
        const state = snapshot(window, contents);
        contents.executeJavaScript('window.__diagramdeskNativeWindowControls?.update(' + JSON.stringify(state) + ')').catch(() => {});
      } catch {}
    }
    function onReady() {
      if (!isEditor(contents)) {
        if (window) { try { window.setWindowButtonVisibility(true); } catch {} detach(); }
        return;
      }
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner) return;
      let initial;
      try { initial = snapshot(owner, contents); } catch { return; }
      if (owner !== window) { detach(); window = owner; for (const event of events) window.on(event, update); }
      try { if (typeof window.setWindowButtonVisibility === 'function') window.setWindowButtonVisibility(false); } catch {}
      try {
        contents.executeJavaScript('(' + renderControls.toString() + ')(' +
          [editorURL, icons, initial, requestChannel, replyChannel].map(value => JSON.stringify(value)).join(',') + ')').catch(error => {
          console.error('Native window controls initialization failed:', error.message);
        });
      } catch (error) { console.error('Native window controls initialization failed:', error.message); }
    }
    function dispose() {
      detach(); contents.removeListener('dom-ready', onReady); contents.removeListener('zoom-changed', update);
      contents.removeListener('destroyed', dispose); states.delete(contents);
    }
    states.set(contents, {dispose, update});
    contents.on('dom-ready', onReady); contents.on('zoom-changed', update); contents.once('destroyed', dispose);
  }
  function onRequest(event, request) {
    const isAppearance = request?.action === 'appearance';
    const reply = value => { if (!isAppearance) { try { event.reply(replyChannel, value); } catch {} } };
    let frame, main;
    try { frame = event.senderFrame; main = event.sender?.mainFrame; } catch { reply({accepted: false}); return; }
    if (!main || !frame || !isEditor(event.sender) || baseURL(frame.url) !== editorURL ||
        !(frame === main || Number.isInteger(frame.frameTreeNodeId) && frame.frameTreeNodeId === main.frameTreeNodeId) ||
        !request || (isAppearance ? Object.keys(request).some(key => !['action', 'color'].includes(key)) ||
          typeof request.color !== 'string' || !/^#[\da-f]{6}$/i.test(request.color) :
          Object.keys(request).some(key => key !== 'action') || !['state', 'minimize', 'toggle', 'close'].includes(request.action))) {
      reply({accepted: false}); return;
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) { reply({accepted: false}); return; }
    try {
      if (isAppearance) { window.setBackgroundColor(request.color); return; }
      if (normalPadMode && request.action !== 'state') { reply({accepted: false}); return; }
      const before = snapshot(window, event.sender);
      if (request.action === 'minimize') { if (!before.isMinimizable) { reply({accepted: false}); return; } window.minimize(); }
      else if (request.action === 'toggle') {
        if (before.isFullScreen) window.setFullScreen(false);
        else if (before.isMaximized) window.unmaximize();
        else { if (!before.isMaximizable) { reply({accepted: false}); return; } window.maximize(); }
      } else if (request.action === 'close') {
        if (!before.isClosable) { reply({accepted: false}); return; }
        reply({accepted: true, state: before}); window.close(); return;
      }
      reply({accepted: true, state: snapshot(window, event.sender)});
    } catch { reply({accepted: false}); }
  }
  function dispose() {
    app.removeListener('web-contents-created', onCreated); ipcMain.removeListener(requestChannel, onRequest);
    app.removeListener('will-quit', dispose);
    if (modeFilePath) fs.unwatchFile(modeFilePath, refreshMode);
    for (const state of states.values()) state.dispose();
  }
  app.on('web-contents-created', onCreated); ipcMain.on(requestChannel, onRequest); app.once('will-quit', dispose);
  return dispose;
}
