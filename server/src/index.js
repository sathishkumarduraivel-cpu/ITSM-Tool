import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import './db.js';

import authRoutes from './routes/auth.js';
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

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'itsm-ai-server', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ITSM AI server listening on http://localhost:${PORT}`);
});
