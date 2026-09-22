import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

// A platform with no persistent disk (Render's free tier, among others) can
// hand this process a brand-new, completely empty server/data/itsm.db on
// any boot -- not just a real redeploy, but also just waking back up from
// the free tier's idle-timeout sleep. Without this, that means every login
// fails with "invalid credentials" -- not because anything is broken, but
// because the seeded demo account genuinely was never created on that disk.
// seed.js is fully idempotent (every section is its own `if (count === 0)`
// guard), so running it here is safe against an already-seeded database too
// -- but it's still gated on the admin account specifically being missing,
// so a normal restart of an instance that already has real data doesn't
// reprint the whole seed summary to the log every time.
if (!db.prepare('SELECT id FROM users WHERE email = ?').get('admin@itsm.ai')) {
  console.log('No seed data found on this disk -- running first-boot seed...');
  await import('./seed.js');
}

import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import ticketRoutes from './routes/tickets.js';
import assetRoutes from './routes/assets.js';
import kbRoutes from './routes/kb.js';
import automationRoutes from './routes/automations.js';
import aiRoutes from './routes/ai.js';
import integrationRoutes from './routes/integrations.js';
import catalogRoutes from './routes/catalog.js';
import approvalRoutes from './routes/approvals.js';
import slaRoutes from './routes/sla.js';
import escalationRoutes from './routes/escalations.js';
import procurementRoutes from './routes/procurement.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import businessRuleRoutes from './routes/businessRules.js';
import customFieldRoutes from './routes/customFields.js';
import lifecycleRoutes from './routes/lifecycles.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import dashboardRoutes from './routes/dashboard.js';
import groupRoutes from './routes/groups.js';
import hrCaseRoutes from './routes/hrCases.js';
import externalConnectionRoutes from './routes/externalConnections.js';
import externalSyncWebhookRoutes from './routes/externalSyncWebhooks.js';
import ticketNumberingRoutes from './routes/ticketNumbering.js';
import customRoleRoutes from './routes/customRoles.js';
import auditLogRoutes from './routes/auditLog.js';
import majorIncidentRoutes from './routes/majorIncidents.js';
import selfServiceRoutes from './routes/selfService.js';
import realtimeRoutes from './routes/realtime.js';
import ssoRoutes from './routes/sso.js';
import apiKeyRoutes from './routes/apiKeys.js';
import publicApiRoutes from './routes/publicApi.js';
import directoryRoutes from './routes/directory.js';
import emailSettingsRoutes from './routes/emailSettings.js';
import emailTemplateRoutes from './routes/emailTemplates.js';
import cannedResponseRoutes from './routes/cannedResponses.js';
import oncallRoutes from './routes/oncall.js';
import assignmentRoutes from './routes/assignment.js';
import alertRoutes from './routes/alerts.js';
import alertWebhookRoutes from './routes/alertWebhooks.js';
import ticketCategoryRoutes from './routes/ticketCategories.js';
import ticketFieldRoutes from './routes/ticketFields.js';
import { startDirectorySyncScheduler } from './services/directorySyncScheduler.js';
import { startInboundEmailScheduler } from './services/inboundEmailScheduler.js';
import { startAlertScheduler } from './services/alertScheduler.js';
import { logError } from './services/errorLog.js';

const app = express();
const PORT = process.env.PORT || 4000;

// Render (like Heroku/Railway/any platform behind a reverse proxy) terminates
// TLS in front of this process and forwards plain HTTP, setting
// X-Forwarded-Proto/X-Forwarded-For -- without this, Express ignores those
// headers entirely, so req.protocol always reads 'http' (breaking the
// self-origin CORS check right below, and every req.protocol-based link this
// app builds for emails -- see routes/tickets.js's ticketLink() and similar
// helpers, which would silently generate http:// links behind a real https
// deployment) and req.ip resolves to the proxy's own address instead of the
// real client's (undermining the rate limiter below, which keys on IP).
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// A per-request delegate (not a static options object) so the origin check
// can compare against THIS request's own host -- the frontend and API share
// one origin in every deployment this app actually ships (see the static-
// file serving block near the bottom of this file), so that self-origin
// should always be allowed without anyone having to remember to also set
// CORS_ORIGIN to match wherever this happens to be deployed. CORS_ORIGIN
// stays for the one case self-origin can't cover: local dev, where the Vite
// dev server (a different port) is a genuinely different origin from this
// API.
app.use((req, res, next) => {
  // req.protocol honors X-Forwarded-Proto once 'trust proxy' is set above,
  // but req.get('host') reads the raw Host header directly and does NOT --
  // Express only applies X-Forwarded-Host to req.hostname (which drops the
  // port), so it's read here by hand instead, preferring it over the raw
  // Host header when a proxy set it.
  const forwardedHost = req.headers['x-forwarded-host']?.split(',')[0].trim();
  const selfOrigin = `${req.protocol}://${forwardedHost || req.get('host')}`;
  cors({
    origin(origin, callback) {
      if (!origin || origin === selfOrigin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })(req, res, next);
});
// Security headers -- hand-rolled rather than pulling in helmet, consistent
// with this app's existing zero-unnecessary-deps philosophy (these are ~10
// lines, not worth a dependency). Scoped precisely to what this app actually
// loads (same-origin JS/CSS bundle, Google Fonts, no other third-party
// resources anywhere in the product) rather than a generic permissive
// default, since a CSP that's too loose defeats its own purpose.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' on style-src only (never script-src) -- React sets a
    // lot of inline `style={{...}}` (progress bars, avatar colors, popover
    // positioning), which CSP treats the same as a <style> tag. This has no
    // effect on XSS protection, which comes from script-src staying strict.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});
app.use(express.json({ limit: '2mb' }));
// The real-time stream carries its auth token as a query param (EventSource
// can't set headers) -- excluded here so that token is never written to the
// access log the way a normal request URL would be. See middleware/auth.js.
app.use(morgan('dev', { skip: (req) => req.path === '/api/realtime/stream' }));

// Strict in production; generous outside it. This limiter covers every
// /api/* call combined (not just login), so normal interactive use — several
// requests per page navigation plus the notification bell polling every
// 20s — was tripping the old flat 300/15min limit during ordinary usage,
// not just abuse. Same reasoning as the login limiter fix.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 300 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'itsm-ai-server', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/kb', kbRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/sla', slaRoutes);
app.use('/api/escalations', escalationRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/business-rules', businessRuleRoutes);
app.use('/api/custom-fields', customFieldRoutes);
app.use('/api/lifecycles', lifecycleRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/hr-cases', hrCaseRoutes);
app.use('/api/external-connections', externalConnectionRoutes);
app.use('/api/ticket-numbering', ticketNumberingRoutes);
app.use('/api/custom-roles', customRoleRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/major-incidents', majorIncidentRoutes);
app.use('/api/self-service', selfServiceRoutes);
app.use('/api/realtime', realtimeRoutes);
app.use('/api/auth/sso', ssoRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/v1', publicApiRoutes);
app.use('/api/webhooks/external-sync', externalSyncWebhookRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api/email-settings', emailSettingsRoutes);
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/canned-responses', cannedResponseRoutes);
app.use('/api/oncall', oncallRoutes);
app.use('/api/assignment', assignmentRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/ticket-categories', ticketCategoryRoutes);
app.use('/api/ticket-fields', ticketFieldRoutes);
// Unauthenticated by necessity -- authenticated per-source by webhook
// secret, like /api/webhooks/external-sync above.
app.use('/api/webhooks/alerts', alertWebhookRoutes);

// Serves the built frontend (web/dist) from this same process -- one
// deployable service instead of two, and no cross-origin auth to configure
// (the SPA and the API share an origin). Only activates when that build
// actually exists on disk, i.e. after `cd web && npm run build` has run --
// local dev (Vite's own dev server + its /api proxy to this server) never
// produces that folder, so this can't change anything about the existing
// two-terminal dev workflow. Placed after every /api/* mount above so an
// unmatched API path still falls through to a real 404, not index.html.
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  logError(err, req);
  res.status(500).json({ error: 'Internal server error' });
});

// A truly unhandled error outside Express's own request/response cycle --
// a rejected promise nothing awaited, a callback that threw -- would
// otherwise just print to stderr and vanish the moment this process is
// replaced (this app's Render deployment has no persistent disk or log
// aggregator; see the auto-seed comment above for the same reality). Logged
// with no `req` (there may not be one), and deliberately NOT followed by
// process.exit(): Node's own guidance is that a real restart is safer after
// an uncaughtException, but this app has no in-memory state whose
// corruption would outlast the offending request (everything durable lives
// in SQLite), so staying up and recording the error is the more useful
// behavior for a single small instance without a process supervisor
// configured to restart it quickly.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  logError(err, null);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  logError(reason instanceof Error ? reason : new Error(String(reason)), null);
});

app.listen(PORT, () => {
  console.log(`ITSM AI server listening on http://localhost:${PORT}`);
});

// This app's first real recurring background job (see
// services/directorySyncScheduler.js's own header comment for why) --
// started once here, unref'd, so it never keeps the process alive on its own.
startDirectorySyncScheduler();
startInboundEmailScheduler();
startAlertScheduler();
