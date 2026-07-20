---
"@starbase/cli-adapters": patch
---

Auto-compaction now works against real harnesses. The background digest is collected as the harness streams it — token by token — and those fragments were being reassembled with a newline between each instead of joined directly. A boundary that fell inside a JSON string value (near-certain with token-level streaming) turned the reply into invalid JSON, so `parseDigest` rejected every real digest: the session showed "compacting soon", then "compaction failed" after the second attempt, and never actually compacted. The scripted adapter emitted its whole reply as a single event, where the separator was a no-op, so the unit and e2e suites stayed green while every real session failed.

The fragments are now concatenated faithfully. A failed digest also records *why* it failed (the run errored or timed out, an empty reply, or a reply that would not parse) so a systematically-failing digest is diagnosable rather than a session that mysteriously stops compacting. The scripted digest now streams in chunks like a real harness, so the reassembly path is exercised end to end — a regression to the old join fails both a unit test and the compaction e2e.
