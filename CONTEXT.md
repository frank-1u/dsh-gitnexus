# DSH GitNexus

A native DeepSeek Harness adapter for GitNexus code-graph context. It keeps GitNexus integration aligned with DSH's plugin model instead of forwarding Claude/Codex hook dialects.

## Language

**Native DSH Adapter**:
A DSH plugin that listens to typed Cordis events such as `tools/post-execute` and uses DSH-owned result channels.
_Avoid_: hook shim, Claude hook, Codex hook

**Compatibility Hook Bridge**:
A DSH plugin that runs existing Claude Code or Codex shell hooks by translating their payloads and decisions.
_Avoid_: native adapter

**GitNexus Context Injector**:
The behavior that enriches a completed search with GitNexus graph context before the agent's next model request.
_Avoid_: pre-tool hook

**Stale Index Notice**:
A model-visible reminder that the current Git HEAD no longer matches the indexed GitNexus commit.
_Avoid_: automatic reindex

**Bundled MCP Registration**:
An installed plugin's declaration that a named MCP server should become part of the same DSH profile.
_Avoid_: manual MCP patch, post-install setup step
