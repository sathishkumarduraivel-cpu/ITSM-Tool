import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
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
import procurementRoutes from './routes/procurement.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import fieldRuleRoutes from './routes/fieldRules.js';
import customFieldRoutes from './routes/customFields.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import dashboardRoutes from './routes/dashboard.js';
import groupRoutes from './routes/groups.js';

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
app.use(morgan('dev'));

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
app.use('/api/procurement', procurementRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/field-rules', fieldRuleRoutes);
app.use('/api/custom-fields', customFieldRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/groups', groupRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ITSM AI server listening on http://localhost:${PORT}`);
});
