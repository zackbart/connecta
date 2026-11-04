---
type: added
---

GitHub's reviewed read allowlist now covers check runs, check suites, check-run annotations and commit statuses. These reads require the App to hold Checks read or Commit statuses read; an App without them fails only those reads, with a typed permission failure, until the permission is granted.
