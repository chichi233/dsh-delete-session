
const fs = require('fs')
const vm = require('vm')
const src = fs.readFileSync('client.js', 'utf8')
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { captured = def } } },
  document: {
    createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
    head: { appendChild() {} },
  },
  console,
  setInterval: () => 1,
  clearInterval: () => {},
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })
if (!captured) throw new Error('no load() call')
if (captured.id !== 'dsh-delete-session') throw new Error('bad id ' + captured.id)
const mod = captured.factory((name) => {
  if (name === 'react') {
    const r = {
      createElement: () => null,
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useCallback: (f) => f,
      useRef: () => ({ current: null }),
      useSyncExternalStore: () => undefined,
    }
    return r
  }
  if (name === 'react-dom') return { createPortal: (n) => n }
  throw new Error('unexpected require ' + name)
})
if (mod.name !== 'dsh-delete-session') throw new Error('bad exports.name')
if (typeof mod.apply !== 'function') throw new Error('apply missing')

// 1) slots 立刻可用 -> 立刻注册
const registered = []
const slotsNow = {
  register: (meta) => { registered.push(meta.name); return () => {} },
  inject: (name, cb) => { cb(); return () => {} },
  entries: () => [{ children: { 'sidebar.workspaces.session.menu.item': {} } }],
}
let effectRegistered = false
const ctxNow = {
  slots: slotsNow,
  locale: { register() {} },
  on: () => () => {},
  effect: () => { effectRegistered = true },
}
mod.apply(ctxNow)
if (registered.length !== 3) throw new Error('expected 3 slot registrations, got ' + JSON.stringify(registered))
if (!effectRegistered) throw new Error('effect not registered for cleanup')
console.log('PASS  立刻可用时注册 3 个插槽', registered.join(' / '))

// 2) slots 晚到（ctx.inject 回调） -> 延迟注册
const lateRegistered = []
const ctxLate = {
  inject: (deps, cb) => {
    if (deps[0] !== 'slots') throw new Error('unexpected inject ' + deps)
    setTimeout(() => cb({
      slots: {
        register: (meta) => { lateRegistered.push(meta.name); return () => {} },
        inject: (n, f) => { f(); return () => {} },
        entries: () => [{ children: { 'sidebar.workspaces.session.menu.item': {} } }],
      },
    }), 0)
    return () => {}
  },
  locale: { register() {} },
  on: () => () => {},
  effect: () => {},
}
const realSetTimeout = setTimeout
mod.apply(ctxLate)
realSetTimeout(() => {
  if (lateRegistered.length !== 3) throw new Error('late path registered ' + lateRegistered.length)
  console.log('PASS  插槽晚到时延迟注册 3 个插槽', lateRegistered.join(' / '))
  console.log('ALL CLIENT CHECKS PASSED')
}, 20)
