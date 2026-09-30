import { Router } from 'express';
import { requireAuth, requireWorkspace, requireStaff } from '../middleware/auth.js';
import {
  AnalyticsError, analyticsMeta,
  listBoards, getBoard, createBoard, updateBoard, deleteBoard,
  addCard, updateCard, deleteCard, reorderCards,
  runBoard, runCard, validateCardConfig,
} from '../services/analyticsCards.js';
import { BOARD_TEMPLATES, templateBody } from '../services/analyticsTemplates.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requireStaff());

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
