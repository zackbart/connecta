---
type: security
---

Override undici to 8.12.3 in the Eve helper's development and test install, to include the current security fixes. The published helper's dependencies are unchanged. Eve 0.83.0 requires undici 8.10.2, so a deployment that installs Eve receives that version unless it overrides undici itself.
