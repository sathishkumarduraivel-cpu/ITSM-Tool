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
  real SMTP/Jira credentials in `backend/src/services/notify.js` when you're ready).
- **AI Settings**: add as many providers as you want, mark one default, test the
  connection with one click.

## Requirements

- Node.js **22.5 or newer** (uses the built-in `node:sqlite` module — no native builds,
  no Python/node-gyp toolchain needed).

## Running it

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env       # optional: change PORT / JWT_SECRET
npm run seed               # creates demo users, tickets, assets, KB articles, workflows
npm run dev                # http://localhost:4001  (npm start for no file watching)

# 2. Frontend (in a second terminal)
cd frontend
npm install
npm run dev                # http://localhost:5175 (proxies /api to the backend)
```

Open http://localhost:5175 and log in with one of the seeded accounts:

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

### Deploying to Azure

One Azure App Service runs the whole thing: the backend serves the API and the built
frontend from the same origin, so there is no CORS to configure and no second service to
pay for.

1. Create a **Linux App Service** on the **Node 22** runtime.
2. **Configuration → General settings → Startup Command:**
   ```
   node backend/src/index.js
   ```
3. **Configuration → Application settings:**

   | Setting | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `ITSM_DATA_DIR` | `/home/data` |
   | `JWT_SECRET` | a long random string |
   | `ENCRYPTION_KEY` | 32 random bytes, base64 |

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" # ENCRYPTION_KEY
   ```

4. Download the app's **Publish Profile** and save it as the repository secret
   `AZUREAPPSERVICE_PUBLISHPROFILE`. Set `AZURE_WEBAPP_NAME` in
   [.github/workflows/azure-deploy.yml](.github/workflows/azure-deploy.yml) to the app's
   name. Pushing to `main`/`master` then builds, tests and deploys.

**`ITSM_DATA_DIR` is the setting that matters most.** The database is SQLite — a file on
disk. On App Service only `/home` survives a restart, a scale event or a redeploy;
anything written elsewhere lives in the container's ephemeral layer and goes with it.
Pointing the data directory at `/home/data` is what makes your data durable.

### Production notes

Still worth knowing before real users arrive:

- **One instance only.** SQLite is a single file, so scaling out to multiple App Service
  instances needs Postgres first. Keep the app at one instance until then.
- **Back it up.** A super-admin can download a full database snapshot from
  Admin Settings; `/home` is durable but it is not a backup.
- **TLS is handled for you** by App Service. If you host it anywhere else, put a real
  reverse proxy in front.

## Project layout

Two folders, one for each half. Nothing else in the repo is needed to run or deploy it.

```
itsm-ai/
  backend/           Express + node:sqlite API, and the server that hosts the frontend
    src/
      index.js          app wiring, middleware, static hosting of ../../frontend/dist
      db.js             schema + migrations + typed helpers
      seed.js           demo data
      middleware/       auth (roles, permissions, delegated roles), async route guard
      services/         ~86 modules: the SLA engine, workflow engine, approval
                        delegation, CMDB graph, AI client, catalog forms, and so on
      routes/           ~56 route modules, one per module of the product
    data/              the SQLite database (gitignored, created on first run)
  frontend/          React 18 + Vite + Tailwind + Recharts + lucide-react
    src/
      pages/            one per screen: Tickets, TicketDetail, Analytics, Catalog,
                        ChangeManagement, Problems, MajorIncidents, Assets, CMDB,
                        Approvals, AdminSettings, PortalHome, ...
      components/       AppShell (role-aware sidebar), Modal, Select, and per-module
                        component folders (analytics/, catalog/, admin/, problems/, ...)
      context/          AuthContext (JWT session), I18nContext
      i18n/locales/     7 languages
      lib/api.js        fetch wrapper
  docs/              build status, how-it-works, go-live checklist (not needed to run)
```

### Tests

```bash
cd backend && npm test     # 1016 tests, colocated as src/**/*.test.js
```
