/**
 * 路由层测试：不需要 DSH 在跑，用假的 ctx + 假的 webServer 把 apply() 注册出来的
 * 三个 handler 取出来直接调用，验证 HTTP 语义（状态码、JSON 形状、错误分支）。
 *
 * 跑法：node scripts/test-routes.mjs
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cases = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  cases.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

const root = await mkdtemp(join(tmpdir(), 'dshds-routes-'))
const home = await mkdtemp(join(tmpdir(), 'dshds-routes-home-'))
process.env.DSH_SESSIONS_ROOT = root
process.env.DSH_HOME = home

const project = '--C-Users-tester-tmp-ws--'
const dir = join(root, project, 'session-deadbeef')
await mkdir(dir, { recursive: true })
await writeFile(
  join(dir, 'session.v4.jsonl'),
  `${JSON.stringify({ version: 4, id: 'session-deadbeef', cwd: 'C:\\tmp\\ws' })}\n`,
  'utf8',
)

const routes = new Map()
const fakeCtx = {
  get: () => undefined,
  emit: () => {},
  inject: (services, callback) => {
    check('inject 声明了 webServer', services, ['webServer'])
    callback({ webServer: { register: (definition) => routes.set(definition.path, definition.handler) } })
  },
}

const { apply } = await import('../index.js')
apply(fakeCtx)
check('注册了三条路由', [...routes.keys()].sort(), [
  '/dsh-session-delete/api/delete',
  '/dsh-session-delete/api/settings',
  '/dsh-session-delete/api/state',
])

function request(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  const holder = { status: 0, headers: {}, body: '' }
  return {
    holder,
    writeHead(status, headers) {
      holder.status = status
      holder.headers = headers ?? {}
    },
    end(text) {
      holder.body = text ?? ''
    },
  }
}

async function call(path, method, url, body) {
  const res = response()
  await routes.get(path)(request(method, url, body), res)
  return { ...res.holder, json: JSON.parse(res.holder.body) }
}

const settingsGet = await call('/dsh-session-delete/api/settings', 'GET', '/dsh-session-delete/api/settings')
check('GET settings 200', settingsGet.status, 200)
check('默认开启再次确认', settingsGet.json.settings.confirmBeforeDelete, true)

const settingsPost = await call('/dsh-session-delete/api/settings', 'POST', '/dsh-session-delete/api/settings', { confirmBeforeDelete: false })
check('POST settings 关闭', settingsPost.json.settings.confirmBeforeDelete, false)
const settingsAgain = await call('/dsh-session-delete/api/settings', 'GET', '/dsh-session-delete/api/settings')
check('设置已持久化', settingsAgain.json.settings.confirmBeforeDelete, false)

const state = await call('/dsh-session-delete/api/state', 'GET', '/dsh-session-delete/api/state?id=session-deadbeef')
check('state 200', state.status, 200)
check('state 报告根目录', state.json.root, root)
check('state 探针命中', state.json.probe.exists, true)

const bad = await call('/dsh-session-delete/api/delete', 'POST', '/dsh-session-delete/api/delete', { sessionId: '../etc/passwd' })
check('非法 id 返回 400', bad.status, 400)

const wrongMethod = await call('/dsh-session-delete/api/delete', 'GET', '/dsh-session-delete/api/delete')
check('GET delete 返回 405', wrongMethod.status, 405)

const removed = await call('/dsh-session-delete/api/delete', 'POST', '/dsh-session-delete/api/delete', { sessionId: 'session-deadbeef' })
check('删除 200', removed.status, 200)
check('删除报告 deleted', removed.json.deleted, ['session-deadbeef'])
check('目录已消失', await readdir(join(root, project)).catch(() => []), [])

const after = await call('/dsh-session-delete/api/state', 'GET', '/dsh-session-delete/api/state?id=session-deadbeef')
check('删除后探针为 false', after.json.probe.exists, false)

await rm(root, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

const failed = cases.filter((item) => !item.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
