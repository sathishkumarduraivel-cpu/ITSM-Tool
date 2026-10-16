import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requireStaff } from '../middleware/auth.js';
import {
  AnalyticsError, analyticsMeta,
  listBoards, getBoard, createBoard, updateBoard, deleteBoard,
  addCard, updateCard, deleteCard, reorderCards,
  runBoard, runCard, validateCardConfig,
} from '../services/analyticsCards.js';
import { BOARD_TEMPLATES, templateBody } from '../services/analyticsTemplates.js';
import { getProvider, draftReportBoard } from '../services/aiClient.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requireStaff());

// Only the Sona route calls out to an LLM; everything else here is a plain
// DB read and stays unthrottled.
const sonaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// Every route funnels its errors through here so an AnalyticsError's status
// and field_errors reach the client intact, and anything unexpected still
// becomes a 500 rather than a hung request.
const handle = (res, fn) => {
  try {
    return res.json(fn());
  } catch (e) {
    if (e instanceof AnalyticsError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    throw e;
  }
};

// Everything the report builder needs to render its own options: card types,
// dimensions, metrics and periods. One call, so the builder never has to
// hardcode a list that could drift from what the server accepts.
router.get('/meta', (req, res) => handle(res, () => ({
  ...analyticsMeta(),
  templates: BOARD_TEMPLATES.map((t) => ({
    key: t.key, name: t.name, description: t.description, card_count: t.cards.length,
  })),
})));

// The analytics landing page: every report in this workspace.
router.get('/boards', (req, res) => handle(res, () => ({ boards: listBoards(req.workspaceId, req.user) })));

router.post('/boards', (req, res) => {
  try {
    const board = createBoard(req.workspaceId, req.user, req.body);
    res.status(201).json({ board });
  } catch (e) {
    if (e instanceof AnalyticsError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    throw e;
  }
});

// Start a report from a template -- a whole board of cards in one request
// rather than the user assembling the obvious starting point by hand.
router.post('/boards/from-template', (req, res) => {
  try {
    const tpl = BOARD_TEMPLATES.find((t) => t.key === req.body.template);
    if (!tpl) return res.status(400).json({ error: 'Unknown template' });
    const board = createBoard(req.workspaceId, req.user, templateBody(tpl, req.body.name));
    res.status(201).json({ board });
  } catch (e) {
    if (e instanceof AnalyticsError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

// Sona builds a whole report from a plain-English request. The model only
// proposes; each card is pushed through the same validateCardConfig a
// hand-built card goes through, filter values are checked against what
// actually exists in this workspace, and anything that fails is dropped and
// counted rather than stored. A board is only created if at least one card
// survives, so a bad answer never leaves an empty report behind.
const SONA_FILTER_VALUES = {
  type: ['incident', 'request', 'problem', 'change'],
  priority: ['low', 'medium', 'high', 'critical'],
  status: ['open', 'in_progress', 'on_hold', 'pending_approval', 'resolved', 'closed'],
};
const SONA_SPANS = [3, 4, 6, 8, 12];

router.post('/boards/sona', sonaLimiter, async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 1000);
  if (!prompt) return res.status(400).json({ error: 'Tell Sona what the report should show.' });
  try {
    const meta = analyticsMeta();
    const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} v FROM tickets WHERE workspace_id = ? AND ${col} IS NOT NULL AND ${col} != '' ORDER BY ${col}`)
      .all(req.workspaceId).map((r) => r.v);
    const allowed = { ...SONA_FILTER_VALUES, team: distinct('team'), category: distinct('category') };
    const presets = meta.date_presets.map((p) => p.key).filter((k) => k !== 'custom');

    const draft = await draftReportBoard(getProvider(req.workspaceId, req.body.provider_id), prompt, {
      cardTypes: meta.card_types.map((t) => t.key),
      dimensions: meta.dimensions.map((d) => d.key),
      metrics: meta.metrics,
      datePresets: presets,
      teams: allowed.team,
      categories: allowed.category,
    });

    const cards = [];
    let dropped = 0;
    for (const card of (Array.isArray(draft?.cards) ? draft.cards : []).slice(0, 10)) {
      try {
        const raw = card?.config && typeof card.config === 'object' ? card.config : {};
        // Models regularly put filters beside config rather than inside it,
        // and capitalise values ("Incident"); both are accepted and mapped to
        // the canonical value. Anything not in this workspace is dropped.
        const filters = {};
        for (const [k, v] of Object.entries({ ...(card.filters || {}), ...(raw.filters || {}) })) {
          const match = allowed[k]?.find((a) => a.toLowerCase() === String(v ?? '').trim().toLowerCase());
          if (match) filters[k] = match;
        }
        // Validated here so a bad card is dropped; createBoard validates again
        // on insert, which is harmless on an already-normalised config.
        const config = validateCardConfig(card.card_type, { ...raw, filters, date_range: undefined });
        const span = SONA_SPANS.includes(Number(card.span)) ? Number(card.span) : undefined;
        cards.push({ title: String(card.title || '').trim().slice(0, 80), card_type: card.card_type, span, config });
      } catch (e) {
        if (!(e instanceof AnalyticsError)) throw e;
        dropped += 1;
      }
    }
    if (!cards.length) {
      return res.status(422).json({ error: "Sona couldn't turn that into a report. Try naming what to measure, e.g. \"SLA breaches by team this month\"." });
    }

    const board = createBoard(req.workspaceId, req.user, {
      name: String(draft.name || '').trim().slice(0, 100) || prompt.slice(0, 100),
      description: String(draft.description || '').trim().slice(0, 300) || `Built by Sona from: "${prompt.slice(0, 200)}"`,
      visibility: 'shared',
      date_range: { preset: presets.includes(draft.date_preset) ? draft.date_preset : 'last_30_days' },
      cards,
    });
    res.status(201).json({ board, dropped });
  } catch (e) {
    if (e instanceof AnalyticsError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    // Provider failures (no provider configured, bad key, unparseable JSON)
    // come back as a message the builder can show, not a 500.
    res.status(400).json({ error: e.message });
  }
});

// The board and its results together: one round trip paints the whole page.
router.get('/boards/:id', (req, res) => handle(res, () => {
  const board = getBoard(req.workspaceId, req.params.id, req.user);
  return { board, results: runBoard(req.workspaceId, board) };
}));

// Results only, for a refresh or a period change that does not alter the
// board's definition.
router.get('/boards/:id/run', (req, res) => handle(res, () => {
  const board = getBoard(req.workspaceId, req.params.id, req.user);
  return { results: runBoard(req.workspaceId, board) };
}));

router.patch('/boards/:id', (req, res) => handle(res, () => ({ board: updateBoard(req.workspaceId, req.params.id, req.user, req.body) })));
router.delete('/boards/:id', (req, res) => handle(res, () => deleteBoard(req.workspaceId, req.params.id, req.user)));

router.post('/boards/:id/cards', (req, res) => {
  try {
    const card = addCard(req.workspaceId, req.params.id, req.user, req.body);
    const board = getBoard(req.workspaceId, req.params.id, req.user);
    // The new card comes back already rendered, so it appears with its data
    // instead of flashing an empty frame while a second request runs.
    res.status(201).json({ card, result: runBoard(req.workspaceId, { ...board, cards: [card] })[0] });
  } catch (e) {
    if (e instanceof AnalyticsError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.patch('/boards/:id/cards/order', (req, res) => handle(res, () => ({
  board: reorderCards(req.workspaceId, req.params.id, req.user, req.body.order),
})));

router.patch('/cards/:cardId', (req, res) => handle(res, () => {
  const card = updateCard(req.workspaceId, req.params.cardId, req.user, req.body);
  const board = getBoard(req.workspaceId, card.dashboard_id, req.user);
  return { card, result: runBoard(req.workspaceId, { ...board, cards: [card] })[0] };
}));

router.delete('/cards/:cardId', (req, res) => handle(res, () => deleteCard(req.workspaceId, req.params.cardId, req.user)));

// Run a card that has not been saved yet, so the builder can show a live
// preview while it is being configured.
router.post('/preview', (req, res) => handle(res, () => {
  const cardType = req.body.card_type;
  const config = validateCardConfig(cardType, req.body.config || {});
  const range = req.body.date_range || { preset: 'last_30_days' };
  return { data: runCard(req.workspaceId, { card_type: cardType, config }, range) };
}));

export default router;
