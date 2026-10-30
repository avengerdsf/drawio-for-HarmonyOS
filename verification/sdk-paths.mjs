import path from 'node:path';

function studioPath(relative) {
  if (!process.env.DEVECO_PATH) throw new Error('Set DEVECO_PATH to your DevEco Studio installation directory.');
  return path.join(process.env.DEVECO_PATH, relative);
}

export function typeScriptPath() {
  return process.env.ARKTS_TYPESCRIPT || studioPath('tools/hvigor/hvigor-ohos-plugin/node_modules/typescript/lib/typescript.js');
}

export function arktsLoaderPath() {
  return process.env.ARKTS_LOADER || studioPath('sdk/default/openharmony/ets/build-tools/ets-loader');
}
