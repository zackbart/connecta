---
type: added
---

Writable `/mcp` and `/mcp/<pool>` endpoints now list a seventh meta tool, `execute_read_code`, annotated read-only, so hosts that gate on annotations need no write approval for read-only programs. It has the same guest API and sandbox as `execute_code`, and refuses every call whose effective or source class is write before dispatch, with the next step and zero writes, whether or not the program catches the refusal. Discovery inside it lists writes with `callable: false`. Handles from direct reads and read programs page from it. Read-only endpoints, `/agent/<pool>` and native pools are unchanged. `execute: { readRoute: false }` turns it off. Activity records source `execute_read_code`. A read program runs unprompted on hosts that auto-approve reads, and a read tool that takes a URL or query can carry data out in its arguments: see the read programs section in `documentation/meta-tools.md`.
