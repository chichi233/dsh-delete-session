## 0.2.0 — 2026-11-10

改名：

- npm 上 `dsh-delete-session` 已被第三方占用（`0.2.5`，维护者 `dddmuc`，仓库 `DDDMUC/dsh-delete-session`），因此包名、插件 id、locale 命名空间、HTTP 路由前缀、设置目录统一改成 **`dsh-session-delete`**。GitHub 仓库名保持 `dsh-delete-session`。
- 路由前缀随之变为 `/dsh-session-delete/api/{settings,state,delete}`；设置文件位置变为 `~/.dsh/plugin-data/dsh-session-delete/settings.json`（旧目录里的设置不会自动迁移，默认值仍是「删除前再次确认」= 开）。

## 0.1.5 — 2026-11-10

修复：

- **会话菜单里出现两条「删除会话」**。另一条来自 `@michengai/dsh-archive-manager`（它也注册 `sidebar.workspaces.session.menu.item`，`order: 500`，点开永远弹它自己的确认框）。slots 没有「摘掉别人注册条目」的 API，因此改为：自己的菜单项在文字外面套一个 `data-dshds-menu` 标记；菜单一打开，用 `MutationObserver` 把同文案、没有该标记的那一条 `display: none`，只留一个入口。若我们自己的条目没挂上则**不做任何隐藏**，避免把用户唯一可用的删除入口也藏掉。
- 去重真的发生时向 `GET /dsh-session-delete/api/state` 回报 `stage=dedupe|hidden=<n>|label=…`，不用截图就能确认菜单只剩一条。
- 顺手把测试期间被改成的 `confirmBeforeDelete: false` 恢复成 `true`（默认仍然「删除前再次确认」）。

# Changelog

## 0.1.4 — 2026-11-10

修复：

- **菜单里显示 `menu.deleteSession` 这种原始键**。两处原因：① `ctx.locale` 属于「必须声明依赖才能取」的服务，直接读会抛 `cannot get property "locale" without inject`，所以词条一次都没注册成功；② 插槽渲染器给的 `t` 在词条缺失时会把 key 原样返回，组件又原样显示。现在改成 `ctx.inject(['locale'], …)` 注册语言包（`zh`/`zh-CN`/`zh-TW`/`zh-Hans`/`en`/`en-US`/`en-GB` 全注册，避免 active locale 是 `zh-CN` 时整条回退链命中不到），并且三个组件统一走 `guardT()`：宿主 t 返回 key 时自动退回内置字典，不会再出现原始键。
- 语言包注册拿到的 disposer 会随 `cleanup` 撤销，HMR 重新 apply 时不会因「already has locale」失败。

新增：

- `GET /dsh-session-delete/api/state` 的自检串多了 `locale=1|0`、`localeErr=…`、`label=…`、`lang=…`：`label` 是菜单项最终渲染出的字，等于 `删除会话` 就说明文案链路通了，不用截图。

## 0.1.3 — 2026-11-10

修复：

- **插件在列表里能看到、却是灰的 / 界面完全不出现**。根因不在插件：装了插件控制台（`@noob-stupid/dsh-plugin-console`）时，它的补丁自愈会把 profile `cordis.patch.yml` 里手写的第三方 `insert` 行判成「模块缺失」，往文件尾追加 `- id: dsh-session-delete` / `disabled: true` 把插件停掉，且对已停用的行不再复查，于是永久失效。
  正确装法只有一条：依赖写进 `dependencies` + 名字写进 `dsh.profile.bundles`，由本包自带的 `cordis.patch.yml` 经 bundle 层应用，**不在 profile 补丁里写 insert**。README / README.en.md 的安装小节都加了醒目说明和手动抢救步骤。

新增：

- 前端注册完成后回报 `stage=ui-registered menu=1,overlay=1,settings=1,menuDeclared=1`：`GET /dsh-session-delete/api/state` 一眼就能看出三个界面入口是否都挂上了。

## 0.1.2 — 2026-11-10

修复：

- **装上了但界面没反应**。`apply()` 里若拿不到 `slots` 服务（插槽服务可能比自己晚就绪），旧代码直接 `return` 并只留一条 console 警告，结果是菜单项、确认框、设置开关全都不出现。现在改为：`slots` 已就绪就立刻注册；没就绪先走 `ctx.inject(['slots'], …)` 等回调；再不行用 5 秒短轮询兜底。
- 自检打点提前到 `apply()` 最前面，并带上阶段标记（`slots-ok` / `slots-missing` / `ui-ready`），排错时不用截图就能判断前端跑到哪一步。

新增：

- `GET /dsh-session-delete/api/state` 多一个 `graph` 字段：向宿主 `clientModules` 服务核对本插件是否已进入前端模块图（`graph.self`），用于区分「没加载」和「加载了但服务缺失」。
- `scripts/test-client.cjs`：用 vm 沙箱跑浏览器端 factory，验证「插槽立刻可用」和「插槽晚到」两条路径都注册满 3 个插槽。

## 0.1.1 — 2026-11-09

修复：

- **启动崩溃**。浏览器端 factory 里用了 `module` / `exports`，但加载器只传 `require`，factory 一执行就 `ReferenceError: exports is not defined`，导致 `web boot: 1 entry did not activate`。现在在 factory 内自建 `module.exports`。
- README 新增「排错」小节，写清这个坑的正确骨架。

## 0.1.0 — 2026-11-09

首个版本。

- 侧栏会话菜单新增「删除会话」（插槽 `sidebar.workspaces.session.menu.item`，order 500）。
- 确认卡片（插槽 `shell.overlay`），支持 Esc / 点击背景关闭、Tab 焦点循环、失败原因回显。
- 设置 → 通用新增「删除前再次确认」开关（插槽 `settings.general.item`），关掉后直接删除。
- 宿主侧完整清理：停活会话 → 清投影缓存 → 级联子代理（≤8 层）→ 清 spill → 删转录目录（符号链接防护）→ 广播 `api-session/removed`。
- 设置持久化到 `~/.dsh/plugin-data/dsh-session-delete/settings.json`。
- HTTP 接口：`GET/POST /dsh-session-delete/api/settings`、`POST /dsh-session-delete/api/delete`。
- 中英文案与图标。
