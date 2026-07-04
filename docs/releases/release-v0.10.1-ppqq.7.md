# ppqq-on-desk v0.10.1-ppqq.7

This prerelease fixes Q Pet sleep wake-up playback and improves Codex API error detection.

Changes:

- Make Q Pet stand-to-sleep and waking transition WebPs play once, preventing wake-up from flashing back to the sleeping frame.
- Recognize structured Codex API error records such as `turn_aborted` with nested `{ code, message }` errors.
- Include API error metadata in remote Codex monitor state posts so `error` animations trigger consistently.
- Bump the bundled Q Pet theme metadata to version `0.1.2`.
