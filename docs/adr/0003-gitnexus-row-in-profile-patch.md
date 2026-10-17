# Ship the row through the profile patch, not a bundle

Installing dsh-gitnexus as a profile bundle into a dsh-tui 0.16.0 profile made every new session fail before it started:

```text
dsh: startup failed: 1 required plugin did not activate
```

All nine core plugins (`plugin-manager`, `llm`, `user-questions`, `permission`, `commands`, `goal`, `subagent`, …) reported the same error, and it was not about this plugin's code:

```text
dsh-tui: root.effect is unavailable from a plugin activation
    at rejectRootCapability (…/dsh-tui/lib/types/dsh-adapter/host-access.js)
    at provideInvocationAccessor (…/dsh-typert-protocol/lib/index.js)
```

## What actually happens

dsh-tui's entry installs a root-capability guard that refuses `ctx.root.effect` *from a plugin activation*. Plugins legitimately use `root.effect` while they activate (typert's `bindTypertRemote` does, for every core service), so the entry defers the guard with `deferRootCapabilityGuard(ctx)` and re-arms it only once the composition is running.

`assembleBackendsFromProfile(ctx)` runs **before** that deferral in `host-entry.js`. It reads `dsh.profile.bundles`, filters out composition-owned names (`@deepseek-ai/*`, `@deepseek-harness-tui/dsh-tui`) and bails out when nothing is left. A third-party bundle leaves something: the assembly walks it through the Loader, `compositionLoader(ctx)` calls `compositionRoot(ctx)`, which calls `trackCompositionRoot` → `guardRootCapabilities`. The guard is now installed *while the profile is still activating*, and every following core-plugin activation is refused.

Instrumentation of the profile's dsh-tui copy made the ordering explicit:

| profile `dsh.profile.bundles` | guard events |
| --- | --- |
| base + dsh-tui | `DEFER` → `TRACK-ROOT deferred=true`; no install, session boots |
| base + dsh-tui + any third-party bundle | `TRACK-ROOT deferred=false` → `GUARD-INSTALL` → 200+ `THROW`s; `DEFER` arrives afterwards |

Two controls pinned the trigger:

* A six-line inert plugin (`apply() {}`, no imports, no dependencies, no backend) reproduces the failure exactly. The duplicated harness runtime was therefore not the trigger.
* Keeping dsh-gitnexus installed but removing it from `dsh.profile.bundles` boots the same profile. `dsh --profile dsh-tui` (the plain DSH path, without dsh-tui's in-process entry) also composes the three-bundle profile correctly, which is why only the `dsh-tui` launcher is affected.

A tarball that lists `@deepseek-ai/dsh-llm` and `@deepseek-ai/schemastery` under `dependencies` does add a second copy of that subgraph — and a second `@deepseek-ai/cordis` would break the identity checks in `host-access` (`Context.is`, `rootFibers`, the activation `AsyncLocalStorage`). That is a real hazard and 0.4.2 stops doing it, but it is not what broke this startup: 0.4.1 moved those packages to peers, removed the second cordis, and the boot still failed.

## Decision

0.4.2 declares no `dsh.bundle`. `dsh plugin add` installs the package as a plain dependency and prints a warning instead of adding a third bundle layer. The adapter row is inserted from the profile's own `cordis.patch.yml`, which is the user-owned layer that composes after every bundle. The package keeps `cordis.patch.yml` as the canonical row definition so the snippet has one source of truth. The row carries a `!!js` `disabled` guard that resolves `dsh-gitnexus/package.json` from the profile, so `dsh plugin remove` leaves an inert row instead of a startup failure.

All host packages are peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`, all optional so pnpm/npm never auto-install a second copy). DSH's plugin contract is module identity, not just version equality.

## Reverting

When dsh-tui defers the root-capability guard before assembling third-party bundle backends, restore `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, drop the profile patch row, and keep the peers as they are.
