# dsh-gitnexus

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds GitNexus graph context and stale-index reminders to DSH Desktop sessions.

## What it does

After a DSH `grep`, `glob`, `bash`, or `pwsh` search completes, the adapter may run:

```text
gitnexus augment -- <search-pattern>
```

and attach the returned `[GitNexus] ...` context as a DSH `additionalContext` for the next model request.

After a successful `git commit`, `git merge`, `git rebase`, `git cherry-pick`, or `git pull`, it reads lightweight GitNexus registry metadata and, when the indexed commit no longer matches `HEAD`, tells the agent to run `gitnexus analyze --index-only`.

When no `mcp__gitnexus__*` tools are registered in the session, the first injected context also carries a short guide to the equivalent local `gitnexus` CLI commands (see [Graph access without MCP](#graph-access-without-mcp)).

This is intentionally a **post-result adapter**. DSH's typed tool pipeline does not expose GitNexus-style pre-tool `additionalContext`; attaching context after the search is the supported model-visible channel.

## Install into a profile

Once published to npm, install it with the normal DSH plugin command:

```sh
dsh plugin --profile web add dsh-gitnexus@latest
```

For local testing before publishing:

```sh
dsh plugin --profile web add file:D:/Codes/dsh-gitnexus
```

DSH Desktop owns the `desktop` profile exclusively, and the DSH CLI inside the app bundle (`resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js`) refuses `--profile desktop` outright, so closing Desktop and using that CLI does not work. Use the `dsh` command the app puts on `PATH` instead: it dispatches to `desktop-cli.js` and installs while Desktop is running.

```sh
dsh plugin --profile desktop add file:D:/Codes/dsh-gitnexus/dsh-gitnexus-<version>.tgz
```

Installed code is picked up on the next reload: toggle the plugin in Settings -> Plugin Inventory, or restart DSH Desktop.

The plugin bundle patch contributes the native adapter row only. After installation, no manual `cordis.patch.yml` edit is required:

```yaml
- id: gitnexus-context-injector
  name: dsh-gitnexus
  config:
    cliCommand: gitnexus
    enableAugment: true
    enableStaleNotice: true
```

On Windows, `cliCommand: gitnexus` is resolved through `PATH`; the adapter then runs the bundled `node_modules/gitnexus/dist/cli/index.js` directly, avoiding a shell and keeping the search pattern out of `cmd.exe` parsing. An absolute Node script or executable is also accepted.

Inside DSH Desktop the host process is Electron, whose embedded Node reports a different `NODE_MODULE_VERSION` than the system Node. GitNexus's native LadybugDB addon fails to initialize there ("DLL initialization routine failed"), so the adapter runs the CLI through a real `node` — the shim's sibling `node.exe` first, then `node` on `PATH` — and only falls back to the Electron binary.

## Graph access without MCP

The bundle deliberately does **not** register a GitNexus MCP row. In DSH Desktop the `dsh-mcp-client` row could settle in a state that stays "connected" with zero tools registered (the loader contains a failed startup tool-sync, the reconnect loop never fires, and the inventory shows "已连接但未注册任何工具"), and that failure mode is outside this plugin's control.

Instead, the adapter watches the session's tool registry: when no `mcp__gitnexus__*` tools are registered, it prepends a short CLI guide (`gitnexus query` / `context` / `impact` / `detect-changes`) to the first context it injects — the agent reaches the exact same graph engine through the shell. The check is cached (`cliHintTtlMs`) and only a definite miss triggers the hint; an unreadable registry never does.

If you prefer the native MCP tool surface anyway, register it yourself in the profile's `cordis.patch.yml` (add `failOnStartupError: true` so a failed startup sync is retried instead of silently contained):

```yaml
- id: mcp-gitnexus
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: gitnexus
    transport: stdio
    command: gitnexus
    args: [mcp]
    failOnStartupError: true
```

With that row live the adapter detects the registered `mcp__gitnexus__*` tools and stops emitting the CLI hint.

## Configuration

| Field | Default | Meaning |
| --- | ---: | --- |
| `cliCommand` | `gitnexus` | GitNexus executable or Node CLI script |
| `enableAugment` | `true` | Attach graph context after searches |
| `enableStaleNotice` | `true` | Check/index reminders after successful git mutations |
| `enableCliFallbackHint` | `true` | Point the agent at the local CLI when no GitNexus MCP tools are registered |
| `cliHintTtlMs` | `1800000` | How long an MCP-absent verdict is cached before re-checking |
| `augmentTimeoutMs` | `7000` | Upper bound for one augment call |
| `staleTimeoutMs` | `3000` | Upper bound for the git/registry staleness check |
| `contextMaxChars` | `12000` | Maximum injected context characters |
| `cacheTtlMs` | `300000` | Reuse an augment result for the same cwd/pattern |
| `staleNoticeTtlMs` | `600000` | Minimum interval between stale notices per cwd |
| `maxConcurrent` | `2` | Maximum simultaneous GitNexus subprocesses |
| `debug` | `false` | Log skipped/failed GitNexus calls |

Failures are silent unless `debug: true`; they never turn the completed DSH tool result into an error.

## Development

```sh
npm test
```

`test/e2e.test.js` drives the adapter through its real `tools/post-execute` listener: CLI resolution, the context-injection and silent-failure contracts, and the stale-index notice against a throwaway git repository. It runs offline against the stubs in `test/fixtures/`; the single test that exercises the real GitNexus CLI skips itself when `gitnexus` is not on `PATH` or the checkout has no `.gitnexus` index.

Tested with DeepSeek Harness `0.1.5-rc.2` and GitNexus `1.6.12`.
