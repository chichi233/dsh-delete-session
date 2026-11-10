/**
 * 主机端纯逻辑测试：直接 import index.js 的 __test，用临时根目录跑，
 * 不碰真实的 ~/.dsh/sessions，也不依赖 DSH 桌面端是否在跑。
 *
 * 跑法：node scripts/test-host.mjs
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zlib = require('node:zlib')

const cases = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  cases.push({ label, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

function header(id, extra = {}) {
  return JSON.stringify({ version: 4, id, cwd: 'C:\\tmp\\ws', createdAt: 1, ...extra })
}

async function makeSession(root, project, id, body, { zstd = false, extra = {} } = {}) {
  const dir = join(root, project, id)
  await mkdir(dir, { recursive: true })
  const lines = [header(id, extra), JSON.stringify({ type: 'message', text: `hello ${id}` })].join('\n') + '\n'
  if (zstd) {
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))
  } else {
    await writeFile(join(dir, 'session.v4.jsonl'), lines, 'utf8')
  }
  return dir
}

const root = await mkdtemp(join(tmpdir(), 'dshds-'))
process.env.DSH_SESSIONS_ROOT = root
const isolatedHome = await mkdtemp(join(tmpdir(), 'dshds-home-'))
process.env.DSH_HOME = isolatedHome

const { __test } = await import('../index.js')
const { encodeSegment, findSessionDirs, readHeader, collectTargets, deleteSessionTree, loadSettings, saveSettings } = __test

// 1) 目录名转义规则
check('encodeSegment 原样保留安全字符', encodeSegment('session-abc_1.2'), 'session-abc_1.2')
check('encodeSegment 转义路径分隔符', encodeSegment('a/b:c'), 'a~002Fb~003Ac')
check('encodeSegment 单点', encodeSegment('.'), '~002E')
check('encodeSegment 双点', encodeSegment('..'), '~002E~002E')

// 2) 级联删除：A ← B ← C，D 无关
const project = '--C-Users-tester-tmp-ws--'
await makeSession(root, project, 'session-aaaa', 0)
await makeSession(root, project, 'session-bbbb', 0, { zstd: true, extra: { parentSession: 'session-aaaa' } })
await makeSession(root, project, 'session-cccc', 0, { extra: { parentSession: 'session-bbbb' } })
await makeSession(root, '--C-Users-tester-other--', 'session-dddd', 0)

check('按 id 找到唯一目录', (await findSessionDirs(root, 'session-aaaa')).length, 1)
check('读 zstd 头部拿到 id', (await readHeader(join(root, project, 'session-bbbb')))?.id, 'session-bbbb')

const plan = await collectTargets(root, 'session-aaaa')
check('级联计划含三个会话（子先父后）', plan.map((item) => item.header?.id), ['session-cccc', 'session-bbbb', 'session-aaaa'])

const emitted = []
const scope = { get: () => undefined, emit: (event, id) => emitted.push([event, id]) }
const result = await deleteSessionTree(scope, 'session-aaaa')
check('删除返回三个 id', result.deleted.sort(), ['session-aaaa', 'session-bbbb', 'session-cccc'])
check('未标记 skipped', result.skipped, false)
check('目录真的没了', await readdir(join(root, project)).catch(() => []), [])
check('无关会话保留', (await findSessionDirs(root, 'session-dddd')).length, 1)
check('逐个广播 api-session/removed', emitted.filter(([event]) => event === 'api-session/removed').length, 3)

// 3) 不存在的会话 = 空操作
const noop = await deleteSessionTree(scope, 'session-ffff')
check('未知会话 skipped', noop.skipped, true)
check('未知会话 deleted 为空', noop.deleted, [])

// 4) 非法 id 直接拒绝
let rejected = ''
try {
  await deleteSessionTree(scope, '../escape')
} catch (error) {
  rejected = String(error.message)
}
check('非法 id 抛错', rejected.startsWith('会话 id 不合法'), true)

// 5) 设置读写（隔离的 DSH_HOME）
check('默认开启再次确认', (await loadSettings()).confirmBeforeDelete, true)
await saveSettings({ confirmBeforeDelete: false })
__test.resetSettingsMemo()
check('关掉后回读为 false', (await loadSettings()).confirmBeforeDelete, false)

await rm(root, { recursive: true, force: true })
await rm(isolatedHome, { recursive: true, force: true })

const failed = cases.filter((item) => !item.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
