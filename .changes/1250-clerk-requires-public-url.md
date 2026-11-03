---
type: changed
breaking: true
---

`createConnecta` throws when `clerkAuth` has no resolved `publicUrl`: neither `clerkAuth({ publicUrl })` nor `ConnectaConfig.publicUrl`. Clerk's token `resource` and session `azp` checks no longer fall back to the request origin. To migrate, set either option to the URL clients reach, or name the loopback origin locally, such as `http://localhost:8787`. A `clerkAuth` `publicUrl` that is not an absolute http(s) URL without credentials also throws. The unset-`publicUrl` startup warning now also fires with inbound auth and describes every URL that follows the request origin.
