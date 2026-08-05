# ITSM AI — Current State & Next Steps

*Prepared: 2026-08-04*

## What this project is

A self-hosted IT Service Management platform (ServiceNow / ServiceDesk Plus alternative)
with tickets, assets, a knowledge base, service catalog, approvals, CAB change process,
SLA policies, CMDB relationships, automation workflows, and AI features that work with any
LLM provider (OpenAI, Anthropic, Azure, Gemini, Ollama, or custom OpenAI-compatible endpoints).

- **Backend**: Node.js (Express) + `node:sqlite` (no external DB, no native build tools needed)
- **Frontend**: React 18 + Vite + Tailwind + Recharts
- No version control is initialized yet (no `.git` folder) — everything so far is local files only.

## Status: working MVP

I installed dependencies, seeded demo data, and ran both the backend (port 4000) and
frontend (port 5173) locally — the app runs end-to-end: login, tickets, dashboard, SLA,
automations, and AI provider config all function against the seeded demo data.

## Gaps and risks found (candidates for "what's next")

### Security / production-readiness — the README itself flags these as pre-launch blockers
1. **Secrets stored in plaintext.** AI provider `api_key` values and integration webhook
   secrets are stored as plain text in SQLite columns (`server/src/db.js`, `ai_providers`
   table; `server/src/routes/ai.js`). Needs encryption at rest before this touches real
   credentials.
2. **Weak default JWT secret.** `server/src/middleware/auth.js:3` falls back to a
   hardcoded `'dev-secret-change-me-in-prod'` if `JWT_SECRET` isn't set in `.env`. Fine
   for local dev, must be a strong random value before any shared/hosted deployment.
3. **No rate limiting or request throttling** on `server/src/index.js` — auth and AI
   endpoints are open to brute-force/abuse as-is.
4. **No HTTPS / reverse proxy** — the app is HTTP-only, meant to sit behind a TLS
   terminator (nginx, Caddy, cloud LB) before it's reachable outside localhost.
5. **CORS is wide open** (`cors()` with no config in `server/src/index.js:24`) — fine for
   local dev, should be locked to a specific origin in production.

### Stubbed integrations (by design, but worth surfacing to your manager)
6. **Email (SMTP) delivery is simulated** — `server/src/services/notify.js:24-27` just
   `console.log`s what would be sent instead of using real SMTP.
7. **Jira integration is simulated** the same way (`notify.js:29-31`) — no real Jira API
   calls yet. Slack/Teams/generic webhooks *do* work for real, since they just POST to a
   webhook URL.

### Engineering hygiene gaps
8. **No automated tests anywhere** in `server/` or `web/` — no unit, integration, or e2e
   test setup at all. This is probably the single highest-leverage next step before adding
   more features, so regressions get caught automatically.
9. **No git repository yet.** Nothing is under version control — no history, no way to
   branch, no way to collaborate or code-review changes. This should happen before any
   more work goes in.
10. **No CI pipeline** (lint/test/build on push) — follows naturally once there's a git repo.
11. **SQLite is single-file/single-instance** — fine for one server, but the README notes
    you'd need Postgres if this ever needs to run on more than one instance (e.g. behind a
    load balancer, or with horizontal scaling).

## Suggested next steps (in priority order)

1. **Initialize git** and get the current state committed — establishes a baseline and
   unblocks everything else (code review, CI, safe experimentation).
2. **Set a real `JWT_SECRET`** and stop shipping the dev default — 5-minute fix, closes
   the biggest security gap for any non-local use.
3. **Decide which integrations need to be real** (SMTP email, Jira) vs. staying stubbed —
   this is a product decision for your manager: does the pilot/demo need actual email
   delivery, or is the simulated log-output enough for now?
4. **Add a basic test suite** — at minimum, smoke tests for auth, ticket CRUD, and SLA
   calculation (`server/src/services/sla.js`), since that's the most complex business logic.
5. **Encrypt secrets at rest** (AI provider keys, integration configs) before this handles
   any real API keys.
6. **Add rate limiting + lock down CORS** before exposing this beyond localhost.
7. **Plan the Postgres migration** only if/when multi-instance deployment is actually needed
   — not urgent for a single-server pilot.

## What I'd ask your manager

- Is this headed toward a real pilot/demo with real users, or an internal proof-of-concept?
  That decides whether items 2–6 are urgent now or can wait.
- Do email and Jira integrations need to be real, or is simulated logging acceptable for now?
- Any existing git remote (GitHub/GitLab/Azure DevOps) this should be pushed to?
