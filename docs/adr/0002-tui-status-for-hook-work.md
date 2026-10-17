# Publish hook work through `ctx.tuiStatus`

The adapter's post-execute work is invisible while it runs: a `gitnexus augment` subprocess can take seconds, and a failed or stale-index outcome only exists in model context or debug logs. dsh-tui exposes a keyed status line above the prompt (`ctx.tuiStatus`), and Claude Code users already read that position as the place where hook work reports itself.

We publish one `gitnexus` contribution from the adapter. The controller resolves `ctx.tuiStatus` on every write, so the plugin has no hard dependency on dsh-tui and stays inert in Web, headless, or any profile without the service. Running work waits 250 ms before painting so fast calls do not flash; outcomes linger for `tuiStatusLingerMs`; a quick call that produced nothing writes nothing. A newer operation supersedes an older batch, and `dispose()` on plugin unload clears the line.

The tradeoff is that the contribution belongs to the TUI app, not to one agent session, so a profile with concurrent sessions shows the latest hook work across them. That is acceptable for a status line and avoids a session-keyed line that would multiply entries.

Alternatives rejected: a session event (`activity/status`) would need a log consumer and pollute shared JSONL; a rich `registerView()` card is more surface than one dim line needs; and a Claude Code hook payload bridge would reintroduce the dialect coupling this adapter deliberately avoids.
