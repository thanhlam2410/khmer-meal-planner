---
name: no-tests-unless-asked
description: "In khmer-menus, never write or run unit tests unless the user explicitly asks for tests"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b942e31f-bdc1-4301-9fae-0977b8ab5a02
  modified: 2026-10-02T04:07:56.623Z
---

Don't write or run any unit tests in this project unless the user explicitly asks for them.

**Why:** the user said they will ask for tests explicitly when they want them (session 2026-10-02).
**How to apply:** skip test files and test runs, and present testing ideas only as recommended checklists. A one-off smoke run of a script on real data to confirm it executes is fine, but say that it isn't a test.
