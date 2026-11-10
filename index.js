/**
 * dsh-session-delete — 宿主端（Host half）。
 *
 * 职责：
 *   1. 提供删除接口 POST /dsh-session-delete/api/delete；
 *   2. 提供设置读写 GET/POST /dsh-session-delete/api/settings（「删除前再次确认」开关）；
 *   3. 真正把会话从磁盘上抹掉。
 *
 * 为什么是纯文件系统实现（不调 sessionPersistence.list/locate）：
 *   · 官方没有暴露「删除会话」的 API，`sessionPersistence` 只有 list/locate/read 这套读接口；
 *   · 会话目录的命名规则是公开且稳定的（`<root>/<projectKey(cwd)>/<encodeSegment(id)>`），
 *     按 id 扫同名目录就能定位，不需要反查 cwd；
 *   · 少了服务依赖，删除链路在命令行里也能直接跑测试，不会因为宿主作用域拿不到服务而静默跳过。
 *   仍在时（服务可用就顺手用一下，不可用也不影响删除）：
 *   `sessions` 用来 flush/detach 活会话，`sessionProjectionCache` 清投影行，
 *   `spillStore` 清临时文件，最后 emit `api-session/removed` 让官方客户端把那一行撤掉。
 */
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

export const name = 'dsh-session-delete'

/** 不声明硬依赖：服务缺失时路由照常注册，删除靠文件系统自己完成。 */
export const inject = []

const DEFAULTS = { confirmBeforeDelete: true }
/** 单次级联的最大层数，防止异常的 parentSession 自引用把递归拖死。 */
const MAX_CASCADE_DEPTH = 8
/** 接受的会话 id 形状（官方 id 是 uuid，这里放宽到安全字符集）。 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/
/** 单个会话日志头部最多读这么多字节，防止把整个大日志读进内存。 */
const HEADER_READ_LIMIT = 256 * 1024
/** 扫头部时的并发上限。 */
const SCAN_CONCURRENCY = 8

let settingsMemo = null

/** 前端加载成功后打点的时间戳（毫秒）。0 = 本轮还没收到过 ping。 */
let lastClientPing = 0
/** 前端打点时报上来的阶段标记（slots-ok / slots-missing …），用于区分「没加载」和「加载了但服务缺失」。 */
let lastClientStage = ''

/**
 * 查前端模块图里有没有本插件。宿主侧 `clientModules` 服务（ClientModuleRegistry）
 * 的 graph() 就是浏览器拿到的 `window.__DSH_BOOT__`，所以这是「前端到底装没装我」
 * 的权威答案，不用猜、不用截图。
 * @param scope 插件作用域
 * @returns {{available: boolean, self?: boolean, count?: number, ids?: string[], error?: string}}
 */
function clientGraphSelf(scope, withIds) {
  const registry = safeGet(scope, 'clientModules')
  if (registry === undefined || typeof registry.graph !== 'function') return { available: false }
  try {
    const graph = registry.graph()
    const rows = Array.isArray(graph?.entries) ? graph.entries : []
    const ids = rows.map((row) => row?.id ?? row?.name).filter((id) => typeof id === 'string')
    const result = { available: true, self: ids.includes(name), count: ids.length }
    if (withIds) result.ids = ids
    return result
  } catch (error) {
    return { available: false, error: String(error?.message ?? error) }
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function settingsFile() {
  return join(dshHome(), 'plugin-data', name, 'settings.json')
}

async function loadSettings() {
  if (settingsMemo !== null) return settingsMemo
  try {
    const raw = await readFile(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw)
    settingsMemo = { confirmBeforeDelete: parsed?.confirmBeforeDelete !== false }
  } catch {
    settingsMemo = { ...DEFAULTS }
  }
  return settingsMemo
}

async function saveSettings(patch) {
  const current = await loadSettings()
  const next = {
    confirmBeforeDelete:
      patch?.confirmBeforeDelete === undefined ? current.confirmBeforeDelete : patch.confirmBeforeDelete === true,
  }
  settingsMemo = next
  const file = settingsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function safeGet(scope, service) {
  try {
    return scope?.get?.(service)
  } catch {
    return undefined
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 官方 JSONL 布局的转义规则：非 [A-Za-z0-9._-] 一律 ~XXXX；"." / ".." 特判。 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    out += code < 128 && /[A-Za-z0-9._-]/.test(raw[i]) ? raw[i] : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 会话存储根目录。优先问 sessionPersistence（用户可能改过 root），
 * 其次环境变量，最后是默认的 `~/.dsh/sessions`。
 */
function sessionsRoot(scope) {
  const persistence = safeGet(scope, 'sessionPersistence')
  const fromService = typeof persistence?.root === 'string' ? persistence.root : persistence?.config?.root
  if (typeof fromService === 'string' && fromService !== '' && isAbsolute(fromService)) return resolve(fromService)
  const fromEnv = process.env.DSH_SESSIONS_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(join(dshHome(), 'sessions'))
}

/** 列出根下的项目目录（`--cwd-slug--` 或 `_no-cwd`）。 */
async function listProjectDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** 列出所有会话目录：<root>/<project>/<encoded id>。 */
async function listSessionDirs(root) {
  const projects = await listProjectDirs(root)
  const dirs = []
  for (const project of projects) {
    let entries
    try {
      entries = await readdir(project, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) dirs.push(join(project, entry.name))
  }
  return dirs
}

/** 在根下按 id 找会话目录：目录名就是 encodeSegment(id)，同名目录可能有多个（cwd 变过）。 */
async function findSessionDirs(root, sessionId) {
  const wanted = encodeSegment(sessionId)
  const dirs = await listSessionDirs(root)
  return dirs.filter((dir) => dir.slice(dir.lastIndexOf(dir.includes('\\') ? '\\' : '/') + 1) === wanted)
}

/** 目录里最新的 `session.v<N>.jsonl[.zstd]`。 */
async function latestLog(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^session\.v[1-9][0-9]*\.jsonl(\.zstd)?$/.test(entry.name))
    .map((entry) => entry.name)
  if (candidates.length === 0) return undefined
  candidates.sort((left, right) => {
    const version = (text) => Number(text.match(/^session\.v([1-9][0-9]*)\./)?.[1] ?? 0)
    return version(right) - version(left)
  })
  return join(dir, candidates[0])
}

/** 读日志第一行（会话头）。zstd 用流式解压，读到换行就停，绝不整份读入。 */
async function readFirstLine(file) {
  if (!file.endsWith('.zstd')) {
    const raw = await readFile(file, 'utf8')
    const newline = raw.indexOf('\n')
    return newline === -1 ? raw : raw.slice(0, newline)
  }
  const source = createReadStream(file)
  const inflate = createZstdDecompress()
  source.pipe(inflate)
  let text = ''
  try {
    for await (const chunk of inflate) {
      text += chunk.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline !== -1) return text.slice(0, newline)
      if (text.length > HEADER_READ_LIMIT) break
    }
    return text.trim() === '' ? '' : text
  } catch {
    return ''
  } finally {
    source.destroy()
    inflate.destroy()
  }
}

/** 读一个会话目录的头部；读不到就返回 undefined（坏会话照样要能删）。 */
async function readHeader(dir) {
  const file = await latestLog(dir)
  if (file === undefined) return undefined
  const line = await readFirstLine(file)
  if (typeof line !== 'string' || line === '') return undefined
  try {
    const value = JSON.parse(line)
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string') return undefined
    return value
  } catch {
    return undefined
  }
}

/** 并发受限地跑 map。 */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 收集要删的会话目录：目标本身 + `parentSession` 指向它的子代理会话（逐层，最多 MAX_CASCADE_DEPTH 层）。
 * 返回后序顺序（子在前、父在后），这样父目录不在中途被写回。
 */
async function collectTargets(root, sessionId) {
  const dirs = await listSessionDirs(root)
  const scan = await mapLimit(dirs, SCAN_CONCURRENCY, async (dir) => ({ dir, header: await readHeader(dir) }))
  const byId = new Map()
  for (const item of scan) if (item.header !== undefined) byId.set(item.header.id, item)
  const childrenOf = new Map()
  for (const item of scan) {
    const parent = item.header?.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(item)
  }
  const order = []
  const seen = new Set()
  const walk = (id, depth) => {
    if (seen.has(id) || depth > MAX_CASCADE_DEPTH) return
    seen.add(id)
    for (const child of childrenOf.get(id) ?? []) walk(child.header.id, depth + 1)
    const item = byId.get(id)
    if (item !== undefined) order.push(item)
  }
  walk(sessionId, 0)
  // 头部读不到的目标目录也要删：按目录名兜底。
  if (!seen.has(sessionId)) {
    for (const dir of await findSessionDirs(root, sessionId)) order.push({ dir, header: undefined })
  }
  return order
}

/** 拒绝顺着符号链接删到别处。 */
async function assertNotSymlink(path, message) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(message)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}

/** 停掉活会话（能停就停；停不掉照样删磁盘）。 */
async function detachLive(scope, sessionId) {
  const sessions = safeGet(scope, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return false
  let live
  try {
    live = sessions.get(sessionId)
  } catch {
    return false
  }
  if (live === undefined) return false
  try {
    if (typeof sessions.flush === 'function') await sessions.flush(live)
  } catch {
    /* 落盘失败也要继续删，否则用户永远删不掉一个坏会话 */
  }
  try {
    if (typeof sessions.liveEntryFor === 'function' && typeof sessions.detachEntered === 'function') {
      const entry = sessions.liveEntryFor(live)
      if (entry !== undefined) sessions.detachEntered(entry)
    }
  } catch {
    /* detach 失败不阻塞磁盘清理 */
  }
  return true
}

/** 清投影缓存行与 spill 目录（两个都是缓存，失败不算删除失败）。 */
async function cleanAuxiliary(scope, sessionId) {
  const projCache = safeGet(scope, 'sessionProjectionCache')
  if (projCache !== undefined && typeof projCache.requireTable === 'function') {
    try {
      await projCache.requireTable().delete(sessionId)
    } catch {
      /* 投影缓存会在下次读取时重建 */
    }
  }
  const spill = safeGet(scope, 'spillStore')
  const spillRoot = typeof spill?.root === 'string' ? spill.root : undefined
  if (spillRoot !== undefined && spillRoot !== '' && SAFE_ID.test(sessionId)) {
    try {
      await rm(join(spillRoot, sessionId), { recursive: true, force: true })
    } catch {
      /* spill 只是临时文件 */
    }
  }
}

async function deleteSessionTree(scope, sessionId) {
  if (!SAFE_ID.test(sessionId)) throw new Error(`会话 id 不合法：${sessionId}`)
  const root = sessionsRoot(scope)
  const targets = await collectTargets(root, sessionId)
  const deleted = []
  const failures = []
  const wasLive = await detachLive(scope, sessionId)
  for (const target of targets) {
    try {
      await assertNotSymlink(dirname(target.dir), `拒绝删除：项目目录是符号链接（${dirname(target.dir)}）`)
      await assertNotSymlink(target.dir, `拒绝删除：会话目录是符号链接（${target.dir}）`)
      await rm(target.dir, { recursive: true, force: true })
      deleted.push(target.header?.id ?? sessionId)
      await cleanAuxiliary(scope, target.header?.id ?? sessionId)
    } catch (error) {
      failures.push({ sessionId: target.header?.id ?? sessionId, message: String(error?.message ?? error) })
    }
  }
  for (const id of deleted) {
    try {
      scope.emit('api-session/removed', id)
    } catch {
      /* 事件没人听也无所谓 */
    }
  }
  if (deleted.length === 0 && failures.length > 0) throw new Error(failures[0].message)
  return { deleted, failures, skipped: targets.length === 0, wasLive, root }
}

/** 只读体检：根目录、会话数、目标是否在盘上——排查用，也方便别人复用。 */
async function inspectSession(scope, sessionId) {
  const root = sessionsRoot(scope)
  const dirs = await findSessionDirs(root, sessionId)
  return { root, exists: dirs.length > 0, dirs }
}

export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    const route = (path, handler) =>
      scope.webServer.register({
        name: `${name}-${path.replace(/[^a-z0-9]+/gi, '-')}`,
        kind: 'exact',
        path: `/dsh-session-delete/api/${path}`,
        handler,
      })

    route('settings', async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, settings: await loadSettings() })
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 200, { ok: true, settings: await saveSettings(await readJsonBody(req)) })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })

    route('state', async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.searchParams.get('ping') !== null) {
          lastClientPing = Date.now()
          lastClientStage = url.searchParams.get('stage') ?? 'unspecified'
        }
        const probe = url.searchParams.get('id') ?? ''
        const root = sessionsRoot(ctx)
        const payload = {
          ok: true,
          root,
          count: (await listSessionDirs(root)).length,
          client: {
            lastPingAt: lastClientPing === 0 ? null : new Date(lastClientPing).toISOString(),
            stage: lastClientStage === '' ? null : lastClientStage,
          },
          graph: clientGraphSelf(ctx, url.searchParams.get('graph') === '1'),
        }
        if (probe !== '' && SAFE_ID.test(probe)) payload.probe = await inspectSession(ctx, probe)
        sendJson(res, 200, payload)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })

    route('delete', async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!SAFE_ID.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: 'invalid sessionId' })
          return
        }
        sendJson(res, 200, { ok: true, ...(await deleteSessionTree(ctx, sessionId)) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })
  })
}

/** 给测试脚本用的内部函数（不参与插件生命周期）。 */
export const __test = {
  encodeSegment,
  sessionsRoot,
  listSessionDirs,
  findSessionDirs,
  readHeader,
  collectTargets,
  deleteSessionTree,
  inspectSession,
  settingsFile,
  loadSettings,
  saveSettings,
  resetSettingsMemo: () => {
    settingsMemo = null
  },
}
