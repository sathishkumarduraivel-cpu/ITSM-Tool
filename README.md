# ITSM AI — a ServiceNow / ServiceDesk Plus alternative

A self-hosted IT Service Management platform: incidents, service requests, problems,
changes, assets, and a knowledge base — with AI built into the core (not bolted on),
an inbuilt no-code automation workflow engine, and integrations for Slack/Teams/webhooks.

## Why this exists

ServiceNow and ServiceDesk Plus are heavy, expensive, and their AI features are locked
to one vendor's model. This is a lightweight alternative you run yourself, where:

- The UI is a single clean React app — one sidebar, everything reachable in one click.
- **Any LLM works.** Bring your own API key for OpenAI, Anthropic, Azure OpenAI, Google
  Gemini, a local Ollama model, or literally any OpenAI-compatible endpoint (OpenRouter,
  Groq, Together, LM Studio, vLLM). Configure it once under **AI Settings** — every AI
  feature routes through whatever you set as default.
- Automation is a real inbuilt workflow engine (trigger → conditions → actions), not a
  separate paid module — including AI steps like "auto-categorize with AI" or "have AI
  draft a resolution."
- No native database dependencies — it runs on Node's built-in SQLite, so there's
  nothing to compile.

## What's included

- **Tickets**: incidents, service requests, problems, changes — with SLA due dates,
  comments, history, and per-ticket AI actions (summarize, auto-categorize, suggest resolution).
- **Dashboard**: live charts (volume trend, priority mix, status breakdown), an
  "AI Insights" panel that generates an executive briefing from your live data, and a
  natural-language "ask AI about your service desk" chat box.
- **Service Catalog**: admins build catalog items (laptop, software license, VPN access…)
  with a custom request form per item. Submitting one auto-creates a ticket and, if
  configured, routes it into the approval chain before work begins.
- **Approvals**: a single inbox for every pending sign-off — catalog requests and CAB
  change approvals — with approve/reject and an audit trail.
- **Change Advisory Board (CAB)**: change tickets carry risk level, planned start/end
  window, and a rollback plan; a change cannot move to "in progress" until CAB approves it
  (enforced server-side, not just in the UI).
- **SLA policies & business hours**: configurable response/resolution targets matched by
  priority/category/team, optional business-hours-aware countdown, and an "at risk /
  breached" list surfaced right on the SLA Policies page.
- **CMDB (asset relationships)**: link assets to each other (depends-on / hosted-on /
  connected-to) and to tickets, with an "impact" view — see what else is affected if an
  asset goes down.
- **Contracts & Purchase Orders**: vendor contracts with renewal countdowns, and a
  purchase-order tracker linkable to assets.
- **Self-service portal**: requesters get a deliberately smaller nav (My Tickets,
  Service Catalog, Knowledge Base) — no admin config, no cross-user ticket queue —
  while agents/admins get the full console.
- **Notifications**: an in-app bell with unread counts, plus editable message templates
  per event (ticket created/assigned/resolved, approval requested, etc).
- **Reports & CSAT**: ticket volume by month, agent performance, average resolution
  time, a CSAT chart fed by post-resolution rating prompts, and a CSV export.
- **Assets**: hardware/software/license/service inventory with owners, status, and CMDB links.
- **Knowledge Base**: searchable self-service articles.
- **Automation**: a visual rule builder — pick a trigger event, add conditions, chain
  actions (assign, notify, tag, or invoke AI). Every workflow run is logged.
- **Integrations**: Slack/Teams/generic webhook out of the box (email/Jira are stubbed
  to a console-log "simulated send" so the app runs with zero external creds — wire in
  real SMTP/Jira credentials in `server/src/services/notify.js` when you're ready).
- **AI Settings**: add as many providers as you want, mark one default, test the
  connection with one click.

## Requirements

- Node.js **22.5 or newer** (uses the built-in `node:sqlite` module — no native builds,
  no Python/node-gyp toolchain needed).

## Running it

```bash
# 1. Backend
cd server
npm install
cp .env.example .env      # optional: change PORT / JWT_SECRET
npm run seed               # creates demo users, tickets, assets, KB articles, workflows
npm start                  # http://localhost:4000

# 2. Frontend (in a second terminal)
cd web
npm install
npm run dev                 # http://localhost:5173 (proxies /api to the backend)
```

Open http://localhost:5173 and log in with one of the seeded accounts:

| Email | Password | Role |
|---|---|---|
| admin@itsm.ai | Admin@123 | Admin |
| priya@itsm.ai | Agent@123 | Agent |
| sam@company.com | User@123 | Requester |

### Connecting an AI provider

Go to **AI Settings → Add provider**, pick a preset (OpenAI, Anthropic, Azure OpenAI,
Gemini, Ollama, or Custom), paste your API key (not needed for local Ollama), set the
model name, and mark it default. Click **Test connection** to confirm it talks to your
provider. From then on, ticket AI actions, dashboard insights, and the AI chat all use it.

### Building an automation

Go to **Automation → New workflow**. Pick a trigger (`ticket_created` / `ticket_updated`),
optionally add conditions (e.g. `priority equals critical`), then chain one or more
actions — including `AI: auto-categorize ticket` or `AI: post suggested resolution` so
the automation itself calls your configured LLM. Two example workflows and one AI
categorization workflow are pre-seeded.

### Production notes

This is a working MVP, not a hardened production deployment. Before exposing it beyond
your local network: put a real reverse proxy / TLS in front of it, set a strong
`JWT_SECRET`, encrypt `api_key`/webhook secrets at rest (they're stored as plain text in
SQLite columns here for simplicity), wire real SMTP and Jira clients into
`server/src/services/notify.js`, and consider moving from SQLite to Postgres if you
need multi-instance deployment.

## Project layout

```
itsm-ai/
  server/            Express + node:sqlite API
    src/
      db.js           schema + typed helpers
      seed.js          demo data
      middleware/auth.js
      services/
        aiClient.js         multi-provider LLM client (the "any AI key" layer)
        automationEngine.js  trigger/condition/action workflow runner
        notify.js             Slack/Teams/webhook/email/Jira dispatch
        notifications.js       in-app notification + template rendering
        sla.js                 SLA policy matching + business-hours-aware due dates
      routes/          auth, tickets, assets, kb, automations, ai, integrations,
                        catalog, approvals, sla, procurement, notifications, reports
  web/                React 18 + Vite + Tailwind + Recharts + lucide-react
    src/
      pages/           Dashboard, PortalHome, Tickets, TicketDetail, Assets,
                        KnowledgeBase, Automations, Integrations, AISettings, Catalog,
                        Approvals, SlaPolicies, Procurement, Reports, Login
      components/       AppShell (role-aware sidebar/topbar), NotificationBell, Badge
      context/          AuthContext (JWT session)
      lib/api.js        fetch wrapper
```
