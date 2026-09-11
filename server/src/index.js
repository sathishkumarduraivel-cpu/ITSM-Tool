import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import './db.js';

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
import { startDirectorySyncScheduler } from './services/directorySyncScheduler.js';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // allow same-origin/non-browser requests (no Origin header) and configured origins
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
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
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ITSM AI server listening on http://localhost:${PORT}`);
});

// This app's first real recurring background job (see
// services/directorySyncScheduler.js's own header comment for why) --
// started once here, unref'd, so it never keeps the process alive on its own.
startDirectorySyncScheduler();
