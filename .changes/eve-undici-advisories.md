---
type: security
---

Override undici to 8.12.3 in the Eve helper's development and test install, for GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685, and GHSA-f72v-6w45-q472. The published helper's dependencies are unchanged. Eve 0.83.0 requires undici 8.10.2, so a deployment that installs Eve receives that version unless it overrides undici itself.
