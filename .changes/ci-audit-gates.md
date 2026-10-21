---
type: changed
---

CI skips the test, build and browser jobs for pull requests that change only decision records or changelog fragments, runs visual comparisons without retries and uploads the Playwright report with diffs and traces when an attempt fails, and scopes pull request provider drift scans to the providers they change, reporting new findings apart from standing manual reviews.
