import { readFileSync } from 'node:fs'

const SRC_PATH = 'E:/AI/Workspace/wechat-neuron/client.js'

/** 在 Node 里加载 client.js：stub 掉 window/React，只取 factory 的返回值。 */
export function loadClient({ test = false } = {}) {
  const previous = globalThis.__WNEUR_TEST__
  if (test) globalThis.__WNEUR_TEST__ = true
  else delete globalThis.__WNEUR_TEST__
  try {
    const source = readFileSync(SRC_PATH, 'utf8')
    let module = null
    const fakeReact = new Proxy(function noop() {}, {
      get: (target, key) => (key === 'createElement' ? () => null : () => () => null),
      apply: () => null,
    })
    const stubRequire = (id) => (id === 'react'
      ? fakeReact
      : new Proxy({}, { get: () => () => null }))
    const stubWindow = {
      __ModuleLoader__: { load: (config) => { module = config.factory(stubRequire) } },
    }
    new Function('window', source)(stubWindow)
    return module
  } finally {
    if (previous === undefined) delete globalThis.__WNEUR_TEST__
    else globalThis.__WNEUR_TEST__ = previous
  }
}
