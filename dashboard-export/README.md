# Dashboard export

Everything the "ITSM Command Center" dashboard needs, pulled out of this
repo so it can be dropped into another app.

## Files

```
web/
  Dashboard.jsx               the page component (verbatim copy of web/src/pages/Dashboard.jsx)
  api.js                      fetch wrapper it imports (`api.get/post`)
  styles.css                  Tailwind base + the .card/.btn/.input/.badge classes it uses
  tailwind.config.snippet.js  the `brand` color scale + shadow-soft it relies on
server/
  dashboard-routes.js         the 4 endpoints it calls (dashboard-stats, command-center-stats,
                               dashboard-insights, ask) — extracted from server/src/routes/ai.js
  aiClient.js                 multi-provider LLM client used by the AI insights/ask endpoints
```

## Frontend wiring

1. Copy `Dashboard.jsx` and `api.js` into your app (adjust the `import { api }
   from '../lib/api.js'` path to wherever you put `api.js`).
2. Merge `styles.css` into your global stylesheet (skip the `@tailwind …`
   lines if you already have Tailwind set up).
3. Merge `tailwind.config.snippet.js` into your `tailwind.config.js`
   `theme.extend`.
4. Install the npm deps it imports: `recharts`, `lucide-react`,
   `react-router-dom` (only used for the "View full report" nav button —
   swap for your router or drop the button if you don't use it).
5. `api.js` expects a JWT in `localStorage['itsm_token']` and proxies
   `/api/*` to your backend — adjust `BASE` / the token key to match your
   auth setup, or swap in your own fetch wrapper as long as it exposes
   `api.get(path)` / `api.post(path, body)`.

## Backend wiring

1. Copy `dashboard-routes.js` and `aiClient.js` into your server.
2. Mount the router: `app.use('/api/ai', dashboardRouter)` (or match
   whatever base path you configured in `api.js`).
3. It expects:
   - a `db` export with a `better-sqlite3`-style
     `db.prepare(sql).get/all/run(...params)` API (see `server/src/db.js`
     in this repo for a `node:sqlite` wrapper that provides this shape —
     copy it too, or adapt the queries to your ORM/driver),
   - a `requireAuth` Express middleware,
   - an `ai_providers` table (id, provider_type, base_url, api_key, model,
     is_default, extra_headers) if you want the "Generate insights" / "Ask
     AI" panels to work — otherwise those two buttons will just show an
     error and the rest of the dashboard (charts, KPIs, filters) still
     works fine without any AI provider configured.
4. `buildCommandCenterStats` (used for most of the KPI grid, chips, and
   team roster) assumes a fairly wide schema: `tickets`, `users`,
   `automations`, `major_incidents`, `assets`, `contracts`,
   `purchase_orders`, `kb_articles`, `catalog_items`,
   `problem_incident_links`, `csat_surveys`. If your target app doesn't
   have all of these, trim the corresponding sections of
   `buildCommandCenterStats` and the matching JSX blocks in `Dashboard.jsx`
   (each KPI card / chip row is self-contained, so you can delete blocks
   without breaking the rest).

## Design language, if you're rebuilding rather than reusing verbatim

- Cards: white bg, `rounded-xl`, subtle border + soft shadow (`.card`).
- One accent color (`brand`, indigo scale) used consistently for primary
  actions, active filters, and one chart series — everything else is
  slate grayscale plus semantic red/amber/emerald for risk/warning/health.
- Small uppercase slate-400 eyebrow labels (`text-[11px] uppercase
  tracking-wide`) above section headings and stat labels.
- Recharts for all charts (line/bar/pie), always wrapped in
  `ResponsiveContainer`, using the same 4-color palette maps at the top of
  `Dashboard.jsx` (`PRIORITY_COLORS`, `STATUS_COLORS`, `TYPE_COLORS`).
- Layout: header + "Executive Status" summary card → live status bar →
  filter bar → team avatar strip → chip rows (data orchestration) → 5-col
  KPI grid → posture/resilience/insights row → detail charts → AI chat.
