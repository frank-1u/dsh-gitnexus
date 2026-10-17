# dsh-gitnexus

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds GitNexus graph context, stale-index reminders, and a Claude Code-style hook status line to DeepSeek Harness sessions.

## What it does

After a DSH `grep`, `glob`, `bash`, or `pwsh` search completes, the adapter may run:

```text
gitnexus augment -- <search-pattern>
```

and attach the returned `[GitNexus] ...` context as a DSH `additionalContext` for the next model request.

After a successful `git commit`, `git merge`, `git rebase`, `git cherry-pick`, or `git pull`, it reads lightweight GitNexus registry metadata and, when the indexed commit no longer matches `HEAD`, tells the agent to run `gitnexus analyze --index-only`.

When no `mcp__gitnexus__*` tools are registered in the session, the first injected context also carries a short guide to the equivalent local `gitnexus` CLI commands (see [Graph access without MCP](#graph-access-without-mcp)).

This is intentionally a **post-result adapter**. DSH's typed tool pipeline does not expose GitNexus-style pre-tool `additionalContext`; attaching context after the search is the supported model-visible channel.

## Augment Root

GitNexus runs in the call's **Augment Root**, which is not necessarily the session directory. Resolution order:

1. A directory the call declares, resolved against the session CWD:
   - `workdir` for `bash`/`pwsh`.
   - `path` for `grep`/`glob`: a directory is used as-is, a regular file resolves to its parent directory, and a path that does not exist or cannot be read falls back to the session CWD.
2. A literal leading `cd` chain in the shell command, applied in order on top of `workdir`.
3. The session CWD.

Only statically resolvable forms count; the adapter never models shell flow:

- Segments must be consecutive at the start of the command, separated by `&&`, `;`, or a newline — `cd repo && grep …`, `cd repo; rg …`, or `cd repo` newline `rg …`.
- `cd a && cd b` applies both in order. A `cd` after any other command is ignored, and the earlier directory stands.
- A target is one bare literal without shell metacharacters/expansion, one single-quoted string, or one double-quoted string. A single-quoted target is fully literal: `$`, backticks and backslashes are ordinary characters, with no escape processing. A double-quoted target containing `$`, backticks or a backslash is rejected, because those expand or escape. `~` and `~/...` expand to the home directory; `~user` is not supported.
- On Windows, `pwsh` treats backslashes as path separators, so a Windows absolute target such as `C:\repo` is accepted. On POSIX a backslash outside single quotes is an escape marker and voids the chain.

The whole chain is discarded — never a partial result, the base directory wins — when it contains any of:

- `$VAR`, `$`, or backticks in a bare or double-quoted target
- `cd -`, `cd --`, `cd` with no target, or a target starting with `-`
- output redirection (`cd a > log` or `cd a>log`), a pipe, `||`, a lone `&`, grouping/subshells
- glob or brace characters (`*`, `?`, `[`, `]`, `{`, `}`)
- a backslash escape (POSIX) in a bare or double-quoted target, or an empty/multi-token target
- a leading `cd` chain that starts after another command (`echo x && cd repo`)

`pushd` and `Set-Location` are not `cd`, so they end the chain. Persistent shell tools whose working directory survives across calls are not supported; such tools expose no `workdir`, so their calls fall back to the session CWD. When a call declares no directory, the adapter uses the session CWD and never guesses.

The stale-index notice uses the same resolution, so `cd repo && git commit` checks that repository's index.

## Hook status in dsh-TUI

A profile composed with `dsh-tui` exposes `ctx.tuiStatus`, a keyed status line above the prompt. The adapter publishes the state of its post-execute work there, in the spirit of Claude Code's hook status:

| State | Line |
| --- | --- |
| `gitnexus augment` running | `GitNexus · searching graph for "pattern"` |
| context attached | `GitNexus ✓ context +1.2k` |
| augment failed | `GitNexus ✗ augment timed out` / `... (exit 3)` |
| stale index | `GitNexus ⚠ index stale (1111111 → 2222222)` |
| quick work, no context | nothing is written |

The running line waits 250 ms before appearing, so short calls do not flash; an outcome lingers for `tuiStatusLingerMs` and then clears. The controller resolves `ctx.tuiStatus` on every write, so a TUI row that mounts after this plugin still gets the line, and profiles without the service (Web, headless) stay inert. Set `enableTuiStatus: false` to disable it.

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

### Activate the row from the profile patch

`dsh-gitnexus` 0.4.2+ ships as a **plain dependency**, not as a profile bundle: it deliberately declares no `dsh.bundle`. dsh-tui 0.16.0 composes any third-party bundle too early and installs its root-capability guard before the profile has activated, which makes every core plugin fail with `root.effect is unavailable from a plugin activation` (evidence and the exact call chain in [ADR 0003](docs/adr/0003-gitnexus-row-in-profile-patch.md)). `dsh plugin add` therefore prints:

```text
dsh: warning: dsh-gitnexus declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

and the adapter row is inserted from the profile's own patch layer instead — `~/.dsh/profiles/<profile>/cordis.patch.yml`. The repository's [`cordis.patch.yml`](cordis.patch.yml) is the canonical row; append this to the patch list:

```yaml
- insert:
    - id: gitnexus-context-injector
      name: dsh-gitnexus
      # Inert when the package is not installed, so `dsh plugin remove` cannot
      # leave the row pointing at a missing module.
      disabled: !!js (() => { try { return !process.getBuiltinModule('node:module').createRequire(ctx.baseUrl).resolve('dsh-gitnexus/package.json') } catch { return true } })()
      config:
        cliCommand: gitnexus
        enableAugment: true
        enableStaleNotice: true
        enableTuiStatus: true
        tuiStatusLingerMs: 4000
        augmentTimeoutMs: 7000
        staleTimeoutMs: 3000
        contextMaxChars: 12000
        cacheTtlMs: 300000
        staleNoticeTtlMs: 600000
        maxConcurrent: 2
        debug: false
```

The patch layer survives `dsh plugin add/remove` of the package and dsh-tui updates. Once dsh-tui defers its root-capability guard before assembling third-party bundles, the package can return to declaring `dsh.bundle` and this step disappears.

Every harness package this plugin touches (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`) is a **peer dependency**, never a regular one. A plugin that vendors them installs a second harness runtime, and DSH's security and service plumbing compares module identity (`Context.is`, `rootFibers`, typert's activation storage), so two copies of `@deepseek-ai/cordis` silently break the host.

On Windows, `cliCommand: gitnexus` is resolved through `PATH`; the adapter then runs the bundled `node_modules/gitnexus/dist/cli/index.js` directly, avoiding a shell and keeping the search pattern out of `cmd.exe` parsing. An absolute Node script or executable is also accepted.

Inside DSH Desktop the host process is Electron, whose embedded Node reports a different `NODE_MODULE_VERSION` than the system Node. GitNexus's native LadybugDB addon fails to initialize there ("DLL initialization routine failed"), so the adapter runs the CLI through a real `node` — the shim's sibling `node.exe` first, then `node` on `PATH` — and only falls back to the Electron binary.

## Graph access without MCP

The plugin deliberately does **not** register a GitNexus MCP row. In DSH Desktop the `dsh-mcp-client` row could settle in a state that stays "connected" with zero tools registered (the loader contains a failed startup tool-sync, the reconnect loop never fires, and the inventory shows "已连接但未注册任何工具"), and that failure mode is outside this plugin's control.

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
| `enableTuiStatus` | `true` | Publish the adapter's hook state through `ctx.tuiStatus` |
| `tuiStatusLingerMs` | `4000` | How long a completed hook status stays visible |
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

Tested with DeepSeek Harness `0.1.5-rc.2`, `0.2.0-rc.2`, and GitNexus `1.6.12`.
