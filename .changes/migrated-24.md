---
type: fixed
---

**A grant is decided once, before the SDK runs, and a flow keeps to its own
epoch.** Retiring a grant from inside the SDK's provider hooks could not be
made safe: the SDK takes the client before the tokens and builds its consent
URL from that copy, and writes discovery before either, so a grant retired
mid-flow left a consent URL naming a client the new epoch did not hold, or a
callback with no discovery to check its server against; and a retirement a
concurrent reset had overtaken followed the live generation into that
reset's epoch, overwriting its pending consent or retiring the grant it had
just completed. Each `remoteMcp()` connect attempt — inside which every 401
and step-up runs — and each `api()` call or start now reads the grant once
and retires it there if any credential is unstamped, the stamps disagree, or
they disagree with the server the epoch's discovery names. The flow is then
bound to the resulting epoch: its reads and writes never follow the live
generation, and a flow that finds its epoch overtaken fails cleanly,
retires nothing, and returns no consent URL. The retirement acts only on the
epoch the decision inspected, activating its replacement with a
compare-and-set, so a stale decision never retires a grant a later restart
completed. A write a reset overtakes after its epoch
check is cleaned up and reported as failed, so a start never hands out
another flow's consent URL and a callback never reports a grant it could not
store. A read for a server the
stamps do not name hands it nothing and changes nothing; the SDK registers
and consents within the same epoch, and the next flow's entry retires any
mixed grant that leaves.
