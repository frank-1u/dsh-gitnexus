# dsh-gitnexus

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds GitNexus graph context and stale-index reminders to DSH Desktop sessions.

## What it does

After a DSH `grep`, `glob`, `bash`, or `pwsh` search completes, the adapter may run:

```text
gitnexus augment -- <search-pattern>
```

and attach the returned `[GitNexus] ...` context as a DSH `additionalContext` for the next model request.

After a successful `git commit`, `git merge`, `git rebase`, `git cherry-pick`, or `git pull`, it runs `gitnexus status --json` and, when the index is stale, tells the agent to run `gitnexus analyze --index-only`.

This is intentionally a **post-result adapter**. DSH's typed tool pipeline does not expose GitNexus-style pre-tool `additionalContext`; attaching context after the search is the supported model-visible channel.

## Install into a profile

From a DSH CLI:

```sh
dsh plugin --profile <profile> add D:/Codes/dsh-gitnexus
```

DSH Desktop owns the `desktop` profile exclusively. Install the local package from Desktop's Plugin Manager, or close Desktop and use its bundled DSH CLI once.

The plugin contributes this row through its bundle patch:

```yaml
- id: gitnexus-context-injector
  name: dsh-gitnexus
  config:
    cliCommand: gitnexus
    enableAugment: true
    enableStaleNotice: true
```

On Windows, `cliCommand: gitnexus` is resolved through `PATH`; the adapter then runs the bundled `node_modules/gitnexus/dist/cli/index.js` directly, avoiding a shell and keeping the search pattern out of `cmd.exe` parsing. An absolute Node script or executable is also accepted.

## Recommended MCP companion

The adapter is deliberately lightweight. Keep GitNexus MCP mounted for full `query`, `context`, `impact`, and related tools. For this machine, the equivalent DSH row is:

```yaml
- id: mcp-gitnexus
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: gitnexus
    transport: stdio
    command: 'C:\Program Files\nodejs\node.exe'
    args:
      - 'C:\Program Files\nodejs\node_global\node_modules\gitnexus\dist\cli\index.js'
      - mcp
```

## Configuration

| Field | Default | Meaning |
| --- | ---: | --- |
| `cliCommand` | `gitnexus` | GitNexus executable or Node CLI script |
| `enableAugment` | `true` | Attach graph context after searches |
| `enableStaleNotice` | `true` | Check/index reminders after successful git mutations |
| `augmentTimeoutMs` | `7000` | Upper bound for one augment call |
| `staleTimeoutMs` | `5000` | Upper bound for one status call |
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

Tested with DeepSeek Harness `0.1.5-rc.2` and GitNexus `1.6.12`.
