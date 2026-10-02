---
name: herenow-deployment
description: Khmer menus app is live on here.now at slug swift-sleet-z44r (password-protected); how deploys, secrets and the visitor password are wired
metadata:
  type: project
---

Live site: https://swift-sleet-z44r.here.now/ (first published 2026-10-02, permanent, user's account). It has here.now server-side password protection (enabled 2026-10-02), which gates every path including the /api/chat proxy. The visitor password is SITE_PASSWORD in the project's gitignored .env and must never be printed in chat.
Redeploy: `npm run build` (or `npm run build:debug` for a readable bundle with source maps), then `set -a; . ./.env; set +a; ~/.agents/skills/here-now/scripts/publish.sh dist --slug swift-sleet-z44r --client claude-code/publish-sh`. Publishing often hits "curl: (56) connection reset" on the first try, so retry.
The OpenRouter key is a here.now account variable `OPENROUTER_API_KEY` pinned to openrouter.ai; `public/.herenow/proxy.json` maps `/api/chat` to it. The user keeps all secrets (OpenRouter, HERENOW_API_KEY, SITE_PASSWORD) in .env, not in ~/.herenow/credentials.

**Why:** here.now has no Docker or server compute, so the agent loop runs in the browser and only the LLM call goes through the proxy. Password mode has no username field.
**How to apply:** always republish with `--slug` so the URL stays the same, deploy only when the user asks, and confirm the password gate still returns 401 after a deploy.
