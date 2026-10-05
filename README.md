# opencode-codex

Account priority, quota fallback and quota display for ChatGPT (Codex)
accounts in [OpenCode](https://opencode.ai) 2.

OpenCode 2 already signs in to ChatGPT Pro/Plus, stores several credentials per
integration, refreshes their tokens and lets you choose the active one. This
plugin builds on that instead of duplicating it:

- **Active account = your manual choice.** `/accounts` lists OpenCode's native
  ChatGPT credentials; Enter makes the highlighted one active.
- **Fallback priority.** Ctrl+↑/↓ in `/accounts` orders the accounts tried when
  the active one runs out of quota. Reordering never changes the active
  account, and choosing an account never changes the order.
- **Per-request quota fallback.** When a request hits the active account's
  quota, it is retried at once through the next usable account by priority.
  Only that request's headers change: the active account stays the same, and
  concurrent sessions route independently.
- **Live quota.** The sidebar shows the active account's 5h and weekly windows
  plus a pooled aggregate; the prompt footer shows the active account and plan.

> ### ⚠️ Use at your own risk
>
> Attaching more than one ChatGPT account may run against the OpenAI Terms of
> Service depending on how you use it. Only attach accounts that belong to you.

## Requirements

OpenCode 2. Accounts are added with OpenCode's own OpenAI connection flow
(**ChatGPT Pro/Plus**); this plugin does not handle sign-in or tokens.

## Installation

Build the plugin and point OpenCode at the `dist` directory (a plugin entry
must be a directory; OpenCode discovers `server.js` and `tui.js` in it):

```sh
bun install
npm run build
```

```json
{
  "plugin": ["/absolute/path/to/opencode-codex/dist"]
}
```

## How fallback works

1. Each request uses OpenCode's active ChatGPT credential.
2. If the upstream reports a quota error, that credential cools down until its
   reported reset (5 minutes when no hint is given), and the request is retried
   through the first usable credential in priority order.
3. Credentials are resolved by ID through OpenCode, which refreshes their
   tokens; the plugin never stores or refreshes tokens itself.
4. If no other account is usable, OpenCode reports the original error.

Routing state lives for one execution of a session and is dropped when the
execution ends or the session is deleted. Cooldowns are kept in memory.

## Storage

Both files are written atomically with mode `0600` and contain no tokens.

| Path                                         | Purpose                                                |
|----------------------------------------------|--------------------------------------------------------|
| `$XDG_DATA_HOME/opencode/codex/priority.json` | Fallback priority as OpenCode credential IDs.          |
| `$XDG_DATA_HOME/opencode/codex/usage.json`    | Latest quota per credential, written by the server.    |

## Development

```sh
npm test          # build + unit, server, TUI (Bun) tests
npm run typecheck
OPENCODE_BIN=$(command -v opencode) node --test test/e2e-opencode.test.mjs
```

The end-to-end test runs a real OpenCode 2 binary in temporary HOME/XDG
directories with fake credentials and a fake upstream.

## License

[MIT](./LICENSE)
