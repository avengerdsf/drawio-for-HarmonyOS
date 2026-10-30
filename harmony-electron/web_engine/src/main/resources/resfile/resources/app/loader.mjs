const facadeURL = new URL('./electron-facade.mjs', import.meta.url).href;
const disabledUpdateURL = new URL('./disable-update.mjs', import.meta.url).href;
const childProcessURL = new URL('./child-process-facade.mjs', import.meta.url).href;

export function createHostHooks(originalMainURL) {
  return {
    resolve(specifier, context, nextResolve) {
      if (new Set(context.conditions).has('import')) {
        if (specifier === 'child_process' && context.parentURL === originalMainURL) {
          return {url: childProcessURL, shortCircuit: true};
        }
        if (specifier === 'electron' && context.parentURL !== facadeURL) {
          return {url: facadeURL, shortCircuit: true};
        }
        if (specifier === './disableUpdate.js' && context.parentURL === originalMainURL) {
          return {url: disabledUpdateURL, shortCircuit: true};
        }
      }
      return nextResolve(specifier, context);
    }
  };
}
