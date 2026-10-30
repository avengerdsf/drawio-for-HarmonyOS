const localBase = 'if (window.DRAWIO_SERVER_URL === ".") { window.DRAWIO_SERVER_URL = "./"; }';

export function installLocalEditorResources(app, editorURL) {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('dom-ready', () => {
      if (contents.getURL().split(/[?#]/, 1)[0] !== editorURL) return;
      contents.executeJavaScript(localBase).catch(error => {
        console.error('Local editor resource configuration failed:', error.message);
      });
    });
  });
}
