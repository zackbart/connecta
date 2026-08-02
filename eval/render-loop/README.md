# Render-loop measurement history

This directory is dated evidence, not a runnable evaluation surface. It records
small before/after measurements of how agents use program-generated UI. Nothing
here runs in CI, ships in the package, or is a dependency of a future release.

The first record begins with the instruction change from
[#282](https://github.com/zackbart/connecta/issues/282), isolates the remaining
location ambiguity, and verifies [#286](https://github.com/zackbart/connecta/issues/286)
through the served product surface. Its disposable local deployment and session
driver were removed after the transcripts were scored; the deployment shape,
prompts, observations, and scoring rules live beside the result so the number
remains interpretable without preserving machinery whose cost would exceed the
evidence.
