# dsh-session-delete

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的会话侧栏加一个**真删除**：`⋯` 菜单里多一项「删除会话」，点下去就把会话从磁盘上清掉，行立即消失。

官方只提供「归档会话」，归档不删文件。这个插件补上缺失的那一半。

## 功能

- **侧栏 `⋯` → 删除会话**：排在「归档会话」下面，图标是垃圾桶。
- **确认框可关**：设置 → 通用 → 「删除前再次确认」。关掉后点删除直接生效，不再弹窗。
- **删干净，不留孤儿**：会话转录目录、子代理会话（递归）、投影缓存行、spill 临时文件一起清掉。
- **删完立刻消失**：宿主广播官方的 `api-session/removed` 事件，侧栏无需手动刷新。
- **安全防护**：只删 `~/.dsh/sessions/<project>/<encodeSegment(id)>` 这种会话目录；目录名不匹配官方转义规则的一律不碰，路径里出现符号链接直接拒绝，避免顺着链接删到别处。
- **中英双语**，跟随界面语言。

## 安装

### A. 从 GitHub 装（推荐）

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:chichi233/dsh-delete-session
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加一行：

```json
"dsh-session-delete"
```

### B. 从本地目录装（开发）

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-session-delete
```

同样把 `"dsh-session-delete"` 加进 `dsh.profile.bundles`。

### C. 手动放置

1. 把整个目录复制到 `~/.dsh/profiles/desktop/node_modules/dsh-session-delete/`。
2. `dependencies` 里写 `"dsh-session-delete": "file:../../plugins/dsh-session-delete"`。
3. `dsh.profile.bundles` 里加 `"dsh-session-delete"`。

装完**必须重启 DSH 桌面端**：宿主端是 ESM 模块，进程内的模块缓存不会因为改文件或插件控制台 toggle 而失效，只有重启才会加载新代码。重启后设置页「插件」列表里就能看到它。

> **别在 profile 的 `cordis.patch.yml` 里手写 `insert` 条目。** 本包自带 `cordis.patch.yml`，加进
> `dsh.profile.bundles` 后由 bundle 层自动应用，这是唯一正确的启用方式。
> 手写 insert 会被插件控制台（`@noob-stupid/dsh-plugin-console`）的补丁自愈判成「模块缺失」：
> 它只用框架安装树（`.pnpm` 里那层 `node_modules`）当解析基准，第三方包（尤其 `link:` 装的）必然解析不到，
> 于是自动追加 `- id: dsh-session-delete` / `disabled: true` 把插件压下去；而且它一旦写过就不再复查，
> 这条禁用记录会一直留着 —— 表现就是「装上去了、列表里能看到、但界面完全没反应」。
> 真的遇到了：删掉 `cordis.patch.yml` 末尾那段 `- id: dsh-session-delete / disabled: true`，重启。

卸载：从 `dsh.profile.bundles` 删掉这一行，再从 `dependencies` 删掉，重启即可。`~/.dsh/plugin-data/dsh-session-delete/` 可以一起删掉。

## 与 「归档会话」插件共存

如果你同时装了 `@michengai/dsh-archive-manager`（归档/恢复/收藏），它也会往同一个三点菜单注册一条「删除会话」，而且点开永远弹它自己的确认框。本插件会**把自己那条留下、把它的那条隐藏**，所以菜单里只有一个「删除会话」，删不删、要不要确认全部听本插件设置。它没挂上时本插件不隐藏任何东西。

## 使用

1. 鼠标移到侧栏任一任务会话，点右侧 `⋯`。
2. 选「删除会话」。
3. 默认弹确认框，点「删除会话」才真正删；不想每次确认就去设置里关掉开关。

## 它到底删了什么

| 目标 | 说明 |
| --- | --- |
| 会话转录目录 | `~/.dsh/sessions/--<cwd>--/<sessionId>/`，含 `session.v4.jsonl.zstd`；同一 id 在多个 cwd 目录下都有时全部删掉 |
| 子代理会话 | `parentSession` 指向被删会话的所有会话，逐层递归（最多 8 层） |
| 投影缓存行 | `sessionProjectionCache` 表里的一行（服务存在时才清） |
| spill 临时文件 | `<spillStore.root>/<sessionId>/`（服务存在时才清） |
| 运行时句柄 | 会话若还活着，先 `flush` 再 `detachEntered` |

删完对每个 id `emit('api-session/removed', id)`。官方客户端本来就监听这个事件，所以侧栏自己就刷新了。

## 工作原理

官方没有暴露删除会话的 API，`sessionPersistence` 只有 list/locate/read 这套读接口。所以删除走文件系统：会话目录命名规则是公开稳定的 `<root>/<projectKey(cwd)>/<encodeSegment(id)>`，按 id 扫同名目录就能定位，不必反查 cwd。这样做的两个好处：

- 服务拿不到时删除照样成功（官方服务只用来顺手清缓存、停活会话、发事件）；
- 逻辑能在命令行直接测，不需要 DSH 在跑。

## 设置存放位置

`~/.dsh/plugin-data/dsh-session-delete/settings.json`

```json
{ "confirmBeforeDelete": true }
```

直接改文件也生效（下次读设置时以文件为准，宿主有内存缓存，需重载插件）。

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-session-delete/api/settings` | 读设置 |
| POST | `/dsh-session-delete/api/settings` | 写设置，body `{ "confirmBeforeDelete": false }` |
| GET | `/dsh-session-delete/api/state` | 体检：返回会话根目录与目录总数；带 `?id=<sessionId>` 时返回该会话是否存在 |
| POST | `/dsh-session-delete/api/delete` | 删除会话，body `{ "sessionId": "..." }` |

## 兼容性

- 依赖官方插槽 `sidebar.workspaces.session.menu.item`、`shell.overlay`、`settings.general.item`。
  侧栏插槽不存在时插件不注册菜单项（不会报错），其余功能照常。
- 官方服务 `sessionPersistence`、`sessions`、`sessionProjectionCache`、`spillStore` 都是可选增强项：
  有就顺手停活会话 / 清缓存 / 发事件，没有也不影响磁盘删除。只有 `webServer` 是必须的。
- 会话目录名依赖官方 `encodeSegment` 转义规则（`.`/`..` 特判，其余非法字符转 `~XXXX`）。
  官方若改这条规则，插件需要同步改 `index.js` 里的 `encodeSegment`。
- 只在 `platform: web` 生效（桌面端内置的就是 web 前端）。

## 排错

**启动卡在 `web boot: 1 entry did not activate` / `dsh-session-delete: import failed`。**
原因是浏览器端 bundle 的 factory 抛了异常。最常见的一种：`factory(require)` 只传 `require`，
`module` 和 `exports` 都不是全局变量，必须自己在 factory 里造：

```js
factory(require) {
  const module = { exports: {} }
  const exports = module.exports
  // ...
  return module.exports
}
```

写自己的插件时照这个骨架抄。0.1.1 已修掉这个 bug。

**侧栏菜单里没有「删除会话」。**
先看 `GET /dsh-session-delete/api/state`：

- `graph.self` = `false` → 前端模块图里没有本插件，检查 profile 依赖和 `dsh.profile.bundles` 是否都写了（**不要**靠补丁层 insert）。
- `graph.self` = `true` 但 `client.lastPingAt` 为 `null` → 前端模块加载了但 `apply()` 没跑到打点，看 `client.stage`。
- `client.stage` = `slots-missing` → 插槽服务没就绪；0.1.2 起会自动等（`ctx.inject(['slots'])` + 5 秒轮询兜底）。
- `client.stage` = `ui-registered menu=1,overlay=1,settings=1,menuDeclared=1,locale=1,localeErr=-,label=删除会话,lang=zh-CN` → 三个界面入口都挂上了、语言包注册成功、菜单项渲染出的是中文；某项是 `0` 说明该环节没成功，`localeErr` 写明原因。
- 菜单里显示 `menu.deleteSession` 这类原始键 → 语言包没注册上（`locale=0`）。0.1.4 起组件自带 `guardT()` 兜底，即使注册失败也显示正常文案。

官方插槽 `sidebar.workspaces.session.menu.item` 不存在时插件会静默跳过。装完新插件必须**重启 DSH 桌面端**
（ESM 模块缓存，热更新不会重新 import）。

## 开发

```
dsh-session-delete/
├── index.js            # 宿主：路由 + 删除逻辑
├── client.js           # 浏览器：菜单项 / 确认框 / 设置开关
├── cordis.patch.yml    # bundle 层：insert 插件条目
├── locale/{zh,en}.json # 文案
├── scripts/            # 测试（不发布到 npm）
├── icon.svg
└── package.json        # dsh.bundle.patch + dsh.client
```

宿主是纯 ESM（`export const name / inject / apply`）；浏览器端是懒加载 CJS（`window.__ModuleLoader__.load`），只用 `react` 和 `@deepseek-ai/dsh-client-ui-primitives`，没有别的依赖。

```bash
npm test   # 32 条断言：目录转义 / zstd 头部 / 级联删除 / 路由与状态码 / 设置持久化
```

测试用临时目录，不碰真实的 `~/.dsh/sessions`。

## 许可

MIT。见 [LICENSE](./LICENSE)。
