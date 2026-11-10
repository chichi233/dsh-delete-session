/**
 * dsh-session-delete — 浏览器端（Client half）。
 *
 * 加了三样东西：
 *   1. 侧栏每个会话的「⋯」菜单里多一项「删除会话」（插槽
 *      `sidebar.workspaces.session.menu.item`，order 500，排在官方归档之后）；
 *   2. 一个确认卡片（插槽 `shell.overlay`），设置里关掉「再次确认」就不弹；
 *   3. 设置 → 通用里一行开关（插槽 `settings.general.item`）。
 *
 * 删除请求发给宿主 `/dsh-session-delete/api/delete`；宿主删完会广播
 * `api-session/removed`，官方会话控制器收到后自动刷新侧栏，行立即消失。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    /** 本插件自己的 locale 命名空间。 */
    const NS = 'dsh-session-delete'
    /** 侧栏会话菜单插槽。 */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    /** 设置页「通用」分组的行插槽。 */
    const SETTINGS_SLOT = 'settings.general.item'

    // #region locales
    const zh = {
      'menu.deleteSession': '删除会话',
      'confirm.title': '删除会话？',
      'confirm.desc':
        '会话“{name}”会被永久删除：对话记录、子代理会话、投影缓存和临时文件一起清掉，删完无法恢复。',
      'confirm.cancel': '取消',
      'confirm.confirm': '删除会话',
      'confirm.pending': '正在删除…',
      'confirm.failed': '删除失败：{detail}',
      'confirm.unknown': '这个会话已经不存在了，刷新一下列表即可。',
      'settings.title': '删除会话',
      'settings.confirm.title': '删除前再次确认',
      'settings.confirm.desc': '关闭后，在会话菜单里点「删除会话」会立刻删掉，不再弹确认框。',
      'settings.hint': '只影响本机这一份配置；删除仍会连带清理该会话的子代理会话。',
    }

    const en = {
      'menu.deleteSession': 'Delete session',
      'confirm.title': 'Delete session?',
      'confirm.desc':
        'Session “{name}” will be permanently deleted: its transcript, child agent sessions, projection cache and spill files are removed together. This cannot be undone.',
      'confirm.cancel': 'Cancel',
      'confirm.confirm': 'Delete session',
      'confirm.pending': 'Deleting…',
      'confirm.failed': 'Could not delete the session: {detail}',
      'confirm.unknown': 'This session no longer exists. Refresh the list.',
      'settings.title': 'Delete session',
      'settings.confirm.title': 'Ask before deleting',
      'settings.confirm.desc': 'When off, “Delete session” in the session menu deletes right away with no dialog.',
      'settings.hint': 'This switch is local to this machine; deleting still removes the session’s child agents.',
    }
    // #endregion

    /** 按界面语言挑内置字典（拿不到语言就用中文）。 */
    function pickDict() {
      let lang = ''
      try {
        lang = String(document?.documentElement?.lang ?? navigator?.language ?? '')
      } catch {
        lang = ''
      }
      return lang.toLowerCase().startsWith('zh') ? zh : lang === '' ? zh : en
    }

    /** 兜底翻译：宿主没把词条给我们时也能出人话，不显示原始 key。 */
    function fallback(key, params) {
      const template = pickDict()[key] ?? zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, token) =>
        params[token] === undefined ? whole : String(params[token]),
      )
    }

    /**
     * 给宿主传进来的 t 加护栏。
     * 插槽渲染器给的 t 绑的是**注册时的 locale 命名空间**；词条没命中时它把 key 原样返回，
     * 界面就会出现「menu.deleteSession」这种原始键。这里查不到就退回内置字典。
     */
    function guardT(bound) {
      return (key, params) => {
        if (typeof bound === 'function') {
          try {
            const text = bound(key, params)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          } catch {
            /* 落回内置字典 */
          }
        }
        return fallback(key, params)
      }
    }

    function makeT(ctx) {
      let bound
      try {
        const locale = ctx?.locale ?? ctx?.get?.('locale')
        if (locale !== undefined && typeof locale.bind === 'function') bound = locale.bind(NS)
      } catch {
        bound = undefined
      }
      return (key, params) => {
        if (typeof bound === 'function') {
          try {
            const text = bound(key, params)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          } catch {
            /* fall through */
          }
        }
        return fallback(key, params)
      }
    }

    // #region settings store（跨组件共享）
    let settingsState = { confirmBeforeDelete: true, ready: false }
    const settingsListeners = new Set()

    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    }

    function emitSettings() {
      for (const listener of [...settingsListeners]) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不影响其他订阅者 */
        }
      }
    }

    function currentSettings() {
      return settingsState
    }

    function useSettings() {
      return useSyncExternalStore(subscribeSettings, currentSettings, currentSettings)
    }

    async function refreshSettings() {
      try {
        const response = await fetch('/dsh-session-delete/api/settings', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return
        const data = await response.json()
        if (data?.ok === true && data.settings !== undefined && data.settings !== null) {
          settingsState = {
            confirmBeforeDelete: data.settings.confirmBeforeDelete !== false,
            ready: true,
          }
          emitSettings()
        }
      } catch {
        /* 宿主暂时不可达时保留上一次已知值 */
      }
    }

    async function persistSettings(confirmBeforeDelete) {
      settingsState = { confirmBeforeDelete: confirmBeforeDelete === true, ready: true }
      emitSettings()
      try {
        await fetch('/dsh-session-delete/api/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmBeforeDelete: confirmBeforeDelete === true }),
        })
      } catch {
        /* 乐观更新；下次打开设置页会以宿主为准 */
      }
      void refreshSettings()
    }
    // #endregion

    // #region delete request store
    let pendingDelete = null
    const pendingListeners = new Set()

    function subscribePending(listener) {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    }

    function emitPending() {
      for (const listener of [...pendingListeners]) {
        try {
          listener()
        } catch {
          /* 同上 */
        }
      }
    }

    function publishPending(target) {
      pendingDelete = target
      emitPending()
    }

    function usePendingDelete() {
      return useSyncExternalStore(
        subscribePending,
        () => pendingDelete,
        () => null,
      )
    }

    async function callDelete(sessionId) {
      const response = await fetch('/dsh-session-delete/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok !== true) {
        const detail = data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return data
    }
    // #endregion

    // #region 菜单项
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState } = props
      const t = guardT(props.t)
      const settings = useSettings()
      let closeMenu
      try {
        if (typeof useMenuOpenState === 'function') {
          const menuState = useMenuOpenState()
          if (Array.isArray(menuState) && typeof menuState[1] === 'function') closeMenu = menuState[1]
        }
      } catch {
        closeMenu = undefined
      }

      const label = t('menu.deleteSession')
      // 打上标记：菜单可能是好几个插件共用的，去重时要认出哪一条是我们自己。
      const markedLabel = h('span', { 'data-dshds-menu': '1' }, label)
      const onSelect = useCallback(() => {
        if (typeof closeMenu === 'function') {
          try {
            closeMenu(false)
          } catch {
            /* 菜单已经关了 */
          }
        }
        if (settings.confirmBeforeDelete) {
          publishPending({ sessionId, title: typeof displayTitle === 'string' ? displayTitle : '' })
          return
        }
        // 关掉「再次确认」时是直接删；失败就把确认卡片翻出来当错误提示，别让用户以为删成功了
        void callDelete(sessionId).catch((error) => {
          console.warn('[dsh-session-delete] delete failed:', error)
          publishPending({
            sessionId,
            title: typeof displayTitle === 'string' ? displayTitle : '',
            error: String(error?.message ?? error),
          })
        })
      }, [closeMenu, displayTitle, sessionId, settings.confirmBeforeDelete])

      let primitives
      try {
        primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        primitives = {}
      }
      const Icon = primitives.IconTrashOutlineRegular
      const icon = typeof Icon === 'function' ? h(Icon, { size: 14 }) : null
      const MenuItemButton = primitives.MenuItemButton
      if (typeof MenuItemButton === 'function') {
        return h(MenuItemButton, { danger: true, icon, onSelect }, markedLabel)
      }
      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'dshds-menu-item', onClick: onSelect },
        icon,
        markedLabel,
      )
    }
    // #endregion

    // #region 确认卡片
    function DeleteConfirmOverlay(props) {
      const t = guardT(props.t)
      const target = usePendingDelete()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const cardRef = useRef(null)
      const cancelRef = useRef(null)
      const confirmRef = useRef(null)

      useEffect(() => {
        if (target === null) {
          setBusy(false)
          setError(null)
          return
        }
        // 直接删除失败时待办项自带 error，卡片直接带着这条错误打开
        setBusy(false)
        setError(typeof target.error === 'string' && target.error !== '' ? target.error : null)
        const node = confirmRef.current ?? cardRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()
      }, [target])

      useEffect(() => {
        if (target === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            publishPending(null)
            return
          }
          if (event.key !== 'Tab') return
          const cancel = cancelRef.current
          const confirm = confirmRef.current
          if (cancel === null || confirm === null) return
          event.preventDefault()
          if (event.shiftKey) {
            if (document.activeElement === cancel) confirm.focus()
            else cancel.focus()
          } else if (document.activeElement === confirm) cancel.focus()
          else confirm.focus()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [target])

      const close = useCallback(() => {
        if (busy) return
        publishPending(null)
      }, [busy])

      const confirm = useCallback(() => {
        if (target === null || busy) return
        setBusy(true)
        setError(null)
        callDelete(target.sessionId)
          .then(() => {
            setBusy(false)
            publishPending(null)
          })
          .catch((rawError) => {
            setBusy(false)
            const message = String(rawError?.message ?? rawError)
            setError(message)
          })
      }, [busy, target])

      if (target === null) return null

      return h(
        'div',
        { className: 'dshds-overlay' },
        h('div', { className: 'dshds-backdrop', onClick: close }),
        h(
          'div',
          {
            ref: cardRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('confirm.title'),
            tabIndex: -1,
            className: 'dshds-card',
          },
          h('h3', { className: 'dshds-card-title' }, t('confirm.title')),
          h('p', { className: 'dshds-card-desc' }, t('confirm.desc', { name: target.title || target.sessionId })),
          busy ? h('div', { className: 'dshds-card-status', role: 'status' }, t('confirm.pending')) : null,
          error !== null ? h('div', { className: 'dshds-card-error', role: 'alert' }, t('confirm.failed', { detail: error })) : null,
          h(
            'div',
            { className: 'dshds-card-footer' },
            h(
              'button',
              {
                ref: cancelRef,
                type: 'button',
                className: 'dshds-btn',
                disabled: busy,
                onClick: close,
              },
              t('confirm.cancel'),
            ),
            h(
              'button',
              {
                ref: confirmRef,
                type: 'button',
                className: 'dshds-btn dshds-btn-danger',
                disabled: busy,
                onClick: confirm,
              },
              t('confirm.confirm'),
            ),
          ),
        ),
      )
    }
    // #endregion

    // #region 设置行
    function DeleteSessionSettingsItem(props) {
      const t = guardT(props.t)
      const settings = useSettings()
      const onChange = useCallback((event) => {
        void persistSettings(event.target.checked)
      }, [])
      return h(
        'div',
        { className: 'dshds-settings-row' },
        h(
          'div',
          { className: 'dshds-settings-text' },
          h('div', { className: 'dshds-settings-title' }, t('settings.confirm.title')),
          h('div', { className: 'dshds-settings-desc' }, t('settings.confirm.desc')),
          h('div', { className: 'dshds-settings-hint' }, t('settings.hint')),
        ),
        h(
          'label',
          { className: 'dshds-switch' },
          h('input', {
            type: 'checkbox',
            className: 'dshds-switch-input',
            checked: settings.confirmBeforeDelete,
            onChange,
          }),
          h('span', { className: 'dshds-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'dshds-switch-thumb' })),
        ),
      )
    }
    // #endregion

    const style = `
.dshds-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: inherit; text-align: left; cursor: pointer; }
.dshds-menu-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); }
.dshds-overlay { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center; justify-content: center; }
.dshds-backdrop { position: absolute; inset: 0; background: rgba(15, 18, 22, .32); }
.dshds-card { position: relative; width: min(420px, calc(100vw - 32px)); padding: 20px 22px 16px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); box-shadow: 0 18px 48px rgba(15, 18, 22, .22); font-size: 13px; }
.dshds-card:focus { outline: none; }
.dshds-card-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.dshds-card-desc { margin: 0 0 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #5f6672); }
.dshds-card-status { margin-bottom: 10px; color: var(--dsw-alias-label-secondary, #5f6672); }
.dshds-card-error { margin-bottom: 10px; color: var(--dsw-alias-danger, #e5484d); line-height: 1.5; word-break: break-word; }
.dshds-card-footer { display: flex; justify-content: flex-end; gap: 8px; }
.dshds-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; cursor: pointer; }
.dshds-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dshds-btn:disabled { opacity: .6; cursor: default; }
.dshds-btn-danger { border-color: var(--dsw-alias-danger, #e5484d); background: var(--dsw-alias-danger, #e5484d); color: #fff; }
.dshds-btn-danger:hover:not(:disabled) { border-color: var(--dsw-alias-danger, #e5484d); filter: brightness(1.05); }
.dshds-settings-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dshds-settings-text { display: flex; flex-direction: column; gap: 3px; }
.dshds-settings-title { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dshds-settings-desc { color: var(--dsw-alias-label-secondary, #5f6672); line-height: 1.55; }
.dshds-settings-hint { color: var(--dsw-alias-label-secondary, #5f6672); font-size: 11px; opacity: .85; }
.dshds-switch { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; margin-top: 2px; cursor: pointer; }
.dshds-switch-input { position: absolute; opacity: 0; width: 0; height: 0; }
.dshds-switch-track { display: inline-flex; align-items: center; width: 36px; height: 20px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-border-l2, rgba(0,0,0,.2)); transition: background .16s ease; }
.dshds-switch-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .16s ease; }
.dshds-switch-input:checked + .dshds-switch-track { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dshds-switch-input:checked + .dshds-switch-track .dshds-switch-thumb { transform: translateX(16px); }
.dshds-switch-input:focus-visible + .dshds-switch-track { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 2px; }
`

    // 加载器只把 require 传进来（factory(require) → exports），module/exports
    // 不是全局变量，必须自己造，否则 factory 一执行就 ReferenceError。
    const module = { exports: {} }
    const exports = module.exports

    exports.name = NS
    exports.inject = []
    exports.apply = function apply(ctx) {
      let slots
      try {
        slots = ctx.slots ?? ctx.get?.('slots')
      } catch {
        slots = undefined
      }

      // 自检打点必须放在任何 return 之前：宿主 /api/state 里的 client.stage
      // 会告诉我们前端跑到了哪一步（slots-ok = 服务齐了；slots-missing = 拿不到插槽服务），
      // 失败也不影响功能。
      try {
        const stage = slots !== undefined && typeof slots.register === 'function' ? 'slots-ok' : 'slots-missing'
        fetch(`/dsh-session-delete/api/state?ping=1&stage=${stage}`, {
          method: 'GET',
          credentials: 'same-origin',
        }).catch(() => {})
      } catch {
        /* fetch 不可用就跳过 */
      }

      // 语言包：active locale 可能是 zh-CN / en-US，只注册 zh / en 时整条回退链可能都命中不到，
      // 界面就会显示原始 key。常见 tag 全注册一遍；拿到的 disposer 留着给 cleanup 撤销，
      // 否则 HMR 重新 apply 时 register 会抛「already has locale」。
      // `locale` 是「必须声明依赖才能取」的服务：直接 `ctx.locale` 会抛
      // `cannot get property "locale" without inject`（0.1.3 就是这么挂的，菜单显示原始 key）。
      // 用 ctx.inject 拿局部作用域；拿不到就靠组件内置字典，不阻塞 UI。
      let offLocale
      let localeError = ''
      const registerLocale = (scope) => {
        try {
          const locale = scope?.locale ?? scope?.get?.('locale')
          if (locale === undefined || typeof locale.register !== 'function') {
            localeError = 'locale service unavailable'
            return
          }
          offLocale = locale.register(NS, {
            zh,
            'zh-CN': zh,
            'zh-TW': zh,
            'zh-Hans': zh,
            en,
            'en-US': en,
            'en-GB': en,
          })
        } catch (localeFailure) {
          localeError = String(localeFailure?.message ?? localeFailure)
        }
      }
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['locale'], registerLocale)
        else if (slots !== undefined) registerLocale(ctx)
      } catch (localeFailure) {
        localeError = String(localeFailure?.message ?? localeFailure)
      }

      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-session-delete', '')
      styleEl.textContent = style
      document.head.appendChild(styleEl)

      void refreshSettings()

      const startUi = (slots) => {
        try {
          fetch('/dsh-session-delete/api/state?ping=1&stage=ui-ready', { method: 'GET', credentials: 'same-origin' }).catch(() => {})
        } catch {
          /* fetch 不可用就跳过 */
        }

        const t = makeT(ctx)
        const disposers = []
        if (typeof offLocale === 'function') {
          disposers.push(() => {
            try {
              offLocale()
            } catch {
              /* ignore */
            }
          })
        }
        // 菜单里去重：别的插件（例如 @michengai/dsh-archive-manager）也会往同一个菜单注册「删除会话」。
        // slots 没有「摘掉别人注册的条目」的 API，所以在菜单打开后把不带我们标记的那一条隐藏掉，
        // 只留一个入口，行为完全由本插件的「再次确认」设置决定。
        const dedupeMenu = () => {
          try {
            if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
            const wanted = t('menu.deleteSession')
            for (const menu of document.querySelectorAll('[role="menu"]')) {
              if (typeof menu.querySelector !== 'function') continue
              // 我们自己的那条没挂上就别动，否则会把用户唯一可用的删除入口也藏了
              if (menu.querySelector('[data-dshds-menu]') === null) continue
              for (const item of menu.querySelectorAll('[role="menuitem"]')) {
                if (typeof item.querySelector !== 'function') continue
                if (item.querySelector('[data-dshds-menu]') !== null) continue
                if (String(item.textContent ?? '').trim() !== wanted) continue
                item.setAttribute('data-dshds-hidden', '1')
                item.style.display = 'none'
                hiddenDuplicates += 1
              }
            }
            if (hiddenDuplicates !== reportedDuplicates) {
              reportedDuplicates = hiddenDuplicates
              // 去重真的发生了才回报，界面不用截图就能证明「菜单里只剩一条」
              fetch(
                `/dsh-session-delete/api/state?ping=1&stage=dedupe|hidden=${hiddenDuplicates}|label=${encodeURIComponent(wanted)}`,
                { method: 'GET', credentials: 'same-origin' },
              ).catch(() => {})
            }
          } catch (error) {
            console.warn('[dsh-session-delete] duplicate menu cleanup failed:', error)
          }
        }
        let hiddenDuplicates = 0
        let reportedDuplicates = 0
        let dedupeQueued = false
        const queueDedupe = () => {
          if (dedupeQueued) return
          dedupeQueued = true
          const run = () => {
            dedupeQueued = false
            dedupeMenu()
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else setTimeout(run, 16)
        }
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
          try {
            const menuObserver = new MutationObserver(queueDedupe)
            menuObserver.observe(document.body, { childList: true, subtree: true })
            disposers.push(() => {
              try {
                menuObserver.disconnect()
              } catch {
                /* ignore */
              }
            })
            queueDedupe()
          } catch (error) {
            console.warn('[dsh-session-delete] menu observer failed:', error)
          }
        }
        let menuOff
        let overlayOff
        let settingsOff

        const sidebarDeclaresMenu = () => {
          try {
            if (typeof slots.entries !== 'function') return true
            const entries = slots.entries('sidebar.workspaces') ?? []
            return entries.some((entry) => entry?.children?.[MENU_SLOT] !== undefined)
          } catch {
            return true
          }
        }

        const ensure = () => {
          try {
            if (menuOff === undefined && sidebarDeclaresMenu()) {
              menuOff = slots.inject(MENU_SLOT, () =>
                slots.register(
                  {
                    name: MENU_SLOT,
                    id: `${NS}.menu`,
                    order: 500,
                    locale: NS,
                    inject: () => ({ t }),
                  },
                  DeleteSessionMenuItem,
                ),
              )
              disposers.push(() => menuOff?.())
            }
            if (overlayOff === undefined) {
              overlayOff = slots.inject('shell.overlay', () =>
                slots.register(
                  {
                    name: 'shell.overlay',
                    id: `${NS}.confirm`,
                    locale: NS,
                    inject: () => ({ t }),
                  },
                  DeleteConfirmOverlay,
                ),
              )
              disposers.push(() => overlayOff?.())
            }
            if (settingsOff === undefined) {
              settingsOff = slots.inject(SETTINGS_SLOT, () =>
                slots.register(
                  {
                    name: SETTINGS_SLOT,
                    id: NS,
                    locale: NS,
                    inject: () => ({ t }),
                  },
                  DeleteSessionSettingsItem,
                ),
              )
              disposers.push(() => settingsOff?.())
            }
          } catch (error) {
            console.warn('[dsh-session-delete] slot registration failed:', error)
          }
        }

        ensure()

        // 注册结果自报：宿主 /api/state 的 client.flags 能直接看出三个插槽是否都挂上了，
        // 不用截图判断（menu=1 说明「删除会话」已在会话菜单里）。
        try {
          const flags = [
            `menu=${menuOff !== undefined ? 1 : 0}`,
            `overlay=${overlayOff !== undefined ? 1 : 0}`,
            `settings=${settingsOff !== undefined ? 1 : 0}`,
            `menuDeclared=${sidebarDeclaresMenu() ? 1 : 0}`,
            `locale=${typeof offLocale === 'function' ? 1 : 0}`,
            `localeErr=${localeError === '' ? '-' : localeError.slice(0, 80)}`,
            `label=${t('menu.deleteSession')}`,
            `lang=${String(document.documentElement.lang || '')}`,
          ].join(',')
          fetch(
            `/dsh-session-delete/api/state?ping=1&stage=${encodeURIComponent(`ui-registered ${flags}`)}`,
            { method: 'GET', credentials: 'same-origin' },
          ).catch(() => {})
        } catch {
          /* 打点失败不影响功能 */
        }

        let offSlotsChanged
        try {
          if (typeof ctx.on === 'function') {
            offSlotsChanged = ctx.on('slots/changed', () => {
              try {
                ensure()
              } catch {
                /* 下一轮重试用 */
              }
            })
          }
        } catch {
          offSlotsChanged = undefined
        }

        const cleanup = () => {
          try {
            offSlotsChanged?.()
          } catch {
            /* ignore */
          }
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          }
          if (styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl)
        }

        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
        } catch {
        }

      }
      const usable = (candidate) => candidate !== undefined && candidate !== null && typeof candidate.register === 'function'

      // 插槽服务可能比本模块晚就绪（没声明 inject 顺序保证时很常见）。
      // 直接 return 会让「插件装了但界面没反应」，所以这里等它，再注册 UI。
      if (usable(slots)) {
        startUi(slots)
        return
      }

      // 首选 cordis 的延迟注入：slots 一出现就回调，不轮询。
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['slots'], (scope) => {
            let late
            try {
              late = scope?.slots ?? scope?.get?.('slots')
            } catch {
              late = undefined
            }
            if (usable(late)) startUi(late)
          })
          return
        } catch {
          /* 退回轮询 */
        }
      }

      // 兜底：短轮询 5 秒，拿到就注册。
      let attempts = 0
      const timer = setInterval(() => {
        attempts += 1
        let late
        try {
          late = ctx.slots ?? ctx.get?.('slots')
        } catch {
          late = undefined
        }
        if (usable(late)) {
          clearInterval(timer)
          startUi(late)
        } else if (attempts >= 50) {
          clearInterval(timer)
          console.warn('[dsh-session-delete] slots service is unavailable; UI not registered')
        }
      }, 100)
    }

    return module.exports
  },
})
