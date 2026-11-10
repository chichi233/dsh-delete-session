# dsh-delete-session

Adds real session deletion to the [DeepSeek Harness](https://github.com/deepseek-ai) sidebar: a **Delete session** entry in every session row menu that removes the conversation from disk, with the row disappearing immediately.

The framework only ships *archive*. Archiving keeps the files. This plugin covers the missing half.

## Features

- **Session `⋯` menu → Delete session**, right under the shipped *Archive session* entry.
- **Optional confirmation**: Settings → General → *Ask before deleting*. Turn it off and the menu item deletes immediately.
- **No orphans**: transcript directory, child agent sessions (recursive), projection-cache row and spill files are all removed.
- **Instant UI update**: the host emits the official `api-session/removed` event, so the sidebar refreshes itself.
- **Path safety**: only the directory resolved by `sessionPersistence.locate()` is removed; symbolic links in the path abort the deletion.
- **English + Chinese** dictionaries.

## Install

### A. From GitHub

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:chichi233/dsh-delete-session
```

Then add `"dsh-delete-session"` to `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`.

### B. From a local checkout

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-delete-session
```

Add `"dsh-delete-session"` to `dsh.profile.bundles` as well.

### C. Manual copy

1. Copy the folder to `~/.dsh/profiles/desktop/node_modules/dsh-delete-session/`.
2. Add `"dsh-delete-session": "file:../../plugins/dsh-delete-session"` to `dependencies`.
3. Add `"dsh-delete-session"` to `dsh.profile.bundles`.

The host half must be restarted: it is an ESM module and the process keeps it in the module cache, so neither editing files nor toggling the plugin console reloads it — restart the DSH desktop app. Afterwards the plugin shows up under Settings → Plugins.

> **Do not hand-write an `insert` row for this plugin in the profile's `cordis.patch.yml`.** The package ships its own `cordis.patch.yml` and is applied through `dsh.profile.bundles` — that is the only supported way in.
> A hand-written insert gets killed by the plugin console's patch self-heal (`@noob-stupid/dsh-plugin-console`): it resolves package names only against the framework install tree, so a third-party (especially `link:`) package never resolves and it appends `- id: dsh-delete-session` / `disabled: true`. It never re-checks a row it has already disabled, so the plugin stays dead — visible in the list, responsive nowhere. Fix: delete that trailing `- id: dsh-delete-session / disabled: true` block and restart.

Uninstall: drop the entry from `dsh.profile.bundles` and `dependencies`, restart, and delete `~/.dsh/plugin-data/dsh-delete-session/` if you want the setting gone too.

## What it deletes

| Target | Detail |
| --- | --- |
| Transcript directory | `~/.dsh/sessions/--<cwd>--/<sessionId>/` including `session.v4.jsonl.zstd`; every matching cwd directory is removed |
| Child sessions | every session whose `parentSession` points at the deleted one, recursively (max 8 levels) |
| Projection cache | the matching row in `sessionProjectionCache` (when the service exists) |
| Spill files | `<spillStore.root>/<sessionId>/` (when the service exists) |
| Runtime handle | a live session is `flush`ed and `detachEntered`ed first |

Afterwards `emit('api-session/removed', id)` is sent for every removed id — the shipped client already listens to it.

## How it works

The official API has no delete: `sessionPersistence` only exposes list/locate/read. Deletion therefore goes through the filesystem. Session directories follow a public, stable layout `<root>/<projectKey(cwd)>/<encodeSegment(id)>`, so scanning for a directory named after the id is enough — no cwd lookup needed. That buys two things: deletion still works when the services are unavailable (they are only used to stop a live session, clear caches and emit the event), and the logic is testable from the command line without DSH running.

## Settings file

`~/.dsh/plugin-data/dsh-delete-session/settings.json`

```json
{ "confirmBeforeDelete": true }
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-delete-session/api/settings` | read settings |
| POST | `/dsh-delete-session/api/settings` | write settings, body `{ "confirmBeforeDelete": false }` |
| GET | `/dsh-delete-session/api/state` | diagnostics: sessions root and directory count; `?id=<sessionId>` adds whether that session exists |
| POST | `/dsh-delete-session/api/delete` | delete a session, body `{ "sessionId": "..." }` |

## Compatibility

- Uses the shipped slots `sidebar.workspaces.session.menu.item`, `shell.overlay` and `settings.general.item`. If the sidebar slot is absent the menu item is skipped without errors.
- `sessionPersistence`, `sessions`, `sessionProjectionCache` and `spillStore` are optional enhancements: with them the plugin stops a live session, clears caches and emits the removal event; without them the disk deletion still happens. Only `webServer` is required.
- Directory names rely on the shipped `encodeSegment` rule (`.` and `..` are special-cased, everything else becomes `~XXXX`). If that rule changes upstream, `encodeSegment` in `index.js` needs the same change.
- `platform: web` only (the desktop app runs the web frontend).

## License

MIT. See [LICENSE](./LICENSE).

## Troubleshoot

- `client.stage` = `ui-registered menu=1,overlay=1,settings=1,menuDeclared=1,locale=1,localeErr=-,label=删除会话,lang=zh-CN` → all three UI entries are mounted, the dictionary registered, and the menu item renders a real label; a `0` means that step failed and `localeErr` names the reason.
- The menu shows a raw key such as `menu.deleteSession` → the locale dictionary never registered (`locale=0`). Since 0.1.4 every component falls back via `guardT()`, so labels stay readable even then.
## Coexisting with the archive plugin

If `@michengai/dsh-archive-manager` is installed, it also registers a "Delete session" item in the same three-dot menu, and its own item always shows its own confirmation dialog. This plugin keeps its own item and hides that one, so the menu has exactly one "Delete session" entry and the behaviour is fully controlled by this plugin's settings. If our own item is not registered, nothing is hidden.

