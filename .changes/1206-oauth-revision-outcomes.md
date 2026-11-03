---
type: fixed
---

Report API OAuth status from typed real-call outcomes fenced by the token grant's revision. Consent and refresh replace their observation atomically, and passive status reads do not write grant state. Later invocations can recover from transient API refusals; Connect starts fresh consent for a refused grant. Maintained provider middleware records initial and replayed outcomes, and unchanged observations do not rewrite grants.
