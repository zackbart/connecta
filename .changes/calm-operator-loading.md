---
type: changed
---

The operator UI loads calmly. When a session is already plausibly established (Cloudflare Access, a loaded Clerk session or a stored bearer token), the requested page shows its heading and a placeholder of its layout instead of a "Sign in" card while admission answers. The Overview counts every configured connector from the start, shows unsettled connectors as neutral "checking" segments rather than healthy ones, and says "All clear" only once every connector has a verdict; its map keeps every connector node in place and shows a muted dash or a stored tool count instead of "0 tools". Connector cards stay in configuration order with a same-height placeholder until their status lands, pending connectors count only in All, and a stored row shows its stored tool count and a quiet "Checking…" instead of a line of text. Detail reads now allow twelve at once per tab, up from eight, and queued stored reads start before queued live reads.
