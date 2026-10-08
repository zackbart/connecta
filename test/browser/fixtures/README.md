# Clerk CAPTCHA fixture

`clerk-js-6.38.1.js.gz` is the unmodified `dist/clerk.browser.js` from
[`@clerk/clerk-js` 6.38.1](https://registry.npmjs.org/@clerk/clerk-js/-/clerk-js-6.38.1.tgz),
gzip-compressed with a zero timestamp. Its MIT license is in `clerk-js-LICENSE`.
Uncompressed SHA-256: `7bd83754b3b1da550941970e57fc517e32d65a8ad1c9ce3fa0d94cf7cd34673f`.

The browser regression intercepts Clerk's environment and client responses,
turns on CAPTCHA and its heartbeat, and lets the real SDK load the protection
script. Only the Turnstile response is a stub, with a frame on the same exact
Cloudflare host. The test runs without an account or external network access.
