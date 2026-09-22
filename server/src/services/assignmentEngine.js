// Availability-aware ticket assignment.
//
// Two-stage by design: a deterministic engine decides *who is eligible* and
// ranks them, and Sona (the LLM) only ever picks among an already-eligible,
// already-in-capacity shortlist. That ordering matters for three reasons --
// the app has to keep working with zero AI credentials configured (see
// getProvider returning null in aiClient.js), an LLM must never be the thing
// standing between a ticket and an owner, and a model cannot be trusted to
// respect a capacity limit or someone's time off. So the hard rules are code,
// and the judgment call ("this mentions Cisco BGP, Bo is the network one") is
// the model's.
//
// Every decision, including the ones that assign nobody, is written to
// assignment_log with the full scored candidate set, so "why did it pick
// them?" is answerable later without re-deriving state that has since moved.
import { db, uid } from '../db.js';
import { getOnlineUserIds } from './realtime.js';
import { getOnCallUserIds, resolveOnCall } from './oncallEngine.js';
import { getProvider, chatComplete } from './aiClient.js';
import { notifyUser } from './notifications.js';

const DEFAULT_CAPACITY = 10;
// How many ranked candidates Sona is allowed to see. Small on purpose: the
// prompt stays cheap, and the deterministic ranking has already done the
// work of excluding anyone unsuitable.
const AI_SHORTLIST = 6;

// Same most-specific-wins scoring as findSlaPolicy (sla.js:61) and
// findEscalationPolicy (escalationEngine.js:18): every non-null match column
// that agrees scores a point, and the highest score wins. A policy with no
// match columns at all is the workspace-wide default.
export function findAssignmentPolicy(workspaceId, { type, priority, team, category } = {}) {
  const policies = db.prepare(
    'SELECT * FROM assignment_policies WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at ASC'
  ).all(workspaceId);
  let best = null;
  let bestScore = -1;
  for (const p of policies) {
    if (p.match_type && p.match_type !== type) continue;
    if (p.match_priority && p.match_priority !== priority) continue;
    if (p.match_team && p.match_team !== team) continue;
    if (p.match_category && p.match_category !== category) continue;
    const score = (p.match_type ? 1 : 0) + (p.match_priority ? 1 : 0) + (p.match_team ? 1 : 0) + (p.match_category ? 1 : 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

// The pool before any availability filtering. Only ever agents/admins with
// an active membership -- a requester can never be assigned a ticket, and a
// deactivated account must not be handed work.
function candidatePool(policy, workspaceId) {
  const activeAgents = (rows) => rows.filter((r) => r.role && r.active);

  if (policy.candidate_source === 'explicit_list') {
    return activeAgents(db.prepare(
      `SELECT u.id, u.name, u.email, wm.role, wm.active, wm.team
       FROM assignment_policy_candidates apc
       JOIN users u ON u.id = apc.user_id
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
       WHERE apc.policy_id = ? AND wm.role IN ('admin','agent')`
    ).all(workspaceId, policy.id));
  }

  if (policy.candidate_source === 'oncall_schedule' && policy.candidate_schedule_id) {
    // Everyone who appears anywhere in the schedule's layers -- the
    // respect_oncall filter below is what narrows this to whoever is
    // actually holding the rotation right now, if the policy asks for it.
    return activeAgents(db.prepare(
      `SELECT DISTINCT u.id, u.name, u.email, wm.role, wm.active, wm.team
       FROM oncall_layer_members lm
       JOIN oncall_layers l ON l.id = lm.layer_id
       JOIN users u ON u.id = lm.user_id
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
       WHERE l.schedule_id = ? AND wm.role IN ('admin','agent')`
    ).all(workspaceId, policy.candidate_schedule_id));
  }

  if (policy.candidate_group_id) {
    return activeAgents(db.prepare(
      `SELECT u.id, u.name, u.email, wm.role, wm.active, wm.team
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
       WHERE gm.group_id = ? AND wm.role IN ('admin','agent')`
    ).all(workspaceId, policy.candidate_group_id));
  }

  // No group configured: the whole workspace's agent roster.
  return activeAgents(db.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.active, wm.team
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.role IN ('admin','agent')`
  ).all(workspaceId));
}

function availabilityRow(workspaceId, userId) {
  return db.prepare('SELECT * FROM agent_availability WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
}

// Absence of a row means "available, default capacity" -- so this table
// never needs backfilling for existing members, and a workspace that never
// touches the availability roster still gets sensible assignment.
function openTicketCount(workspaceId, userId) {
  return db.prepare(
    "SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND assignee_id = ? AND status NOT IN ('resolved','closed') AND COALESCE(is_spam, 0) = 0"
  ).get(workspaceId, userId).c;
}

function lastAssignedAt(workspaceId, userId) {
  const row = db.prepare(
    'SELECT MAX(created_at) t FROM assignment_log WHERE workspace_id = ? AND assigned_user_id = ?'
  ).get(workspaceId, userId);
  return row?.t || null;
}

function isOnTimeOff(workspaceId, userId, atIso) {
  const row = db.prepare(
    'SELECT id FROM agent_time_off WHERE workspace_id = ? AND user_id = ? AND start_at <= ? AND end_at > ? LIMIT 1'
  ).get(workspaceId, userId, atIso, atIso);
  return !!row;
}

// Builds the scored candidate set. Returns every candidate, eligible or not,
// each carrying its own `blocked` reasons -- the admin dry-run simulator
// shows the excluded ones too, because "why was nobody assigned?" is
// answered by the exclusions, not by the survivors.
export function scoreCandidates(policy, workspaceId, at = new Date()) {
  const atIso = at.toISOString();
  const pool = candidatePool(policy, workspaceId);
  const online = policy.respect_presence ? getOnlineUserIds(workspaceId) : new Set();
  const onCall = getOnCallUserIds(workspaceId, at);

  // Rank by recency for the round-robin component: whoever was assigned
  // longest ago (or never) sorts first.
  const recencyOrder = [...pool]
    .map((c) => ({ id: c.id, t: lastAssignedAt(workspaceId, c.id) }))
    .sort((a, b) => {
      if (a.t === b.t) return a.id < b.id ? -1 : 1;
      if (!a.t) return -1;
      if (!b.t) return 1;
      return a.t < b.t ? -1 : 1;
    })
    .map((r) => r.id);

  const candidates = pool.map((c) => {
    const av = availabilityRow(workspaceId, c.id);
    const status = av?.status || 'available';
    const capacity = Number.isFinite(av?.max_concurrent_tickets) && av.max_concurrent_tickets > 0
      ? av.max_concurrent_tickets
      : DEFAULT_CAPACITY;
    const openTickets = openTicketCount(workspaceId, c.id);
    const isOnCall = onCall.has(c.id);
    const isOnline = online.has(c.id);

    let skills = [];
    try {
      if (av?.skills) skills = JSON.parse(av.skills);
    } catch {
      skills = [];
    }

    const blocked = [];
    if (policy.respect_status && status === 'dnd') blocked.push('Do not disturb');
    if (isOnTimeOff(workspaceId, c.id, atIso)) blocked.push('On time off');
    if (policy.respect_capacity && openTickets >= capacity) blocked.push(`At capacity (${openTickets}/${capacity})`);
    if (policy.respect_oncall && !isOnCall) blocked.push('Not on call');

    // Headroom is a ratio, not an absolute count, so a 5-ticket agent with a
    // cap of 6 ranks below a 10-ticket agent with a cap of 40.
    const headroom = capacity > 0 ? Math.max(0, (capacity - openTickets) / capacity) : 0;
    const recencyRank = recencyOrder.indexOf(c.id);
    const recencyScore = recencyOrder.length > 1
      ? (1 - recencyRank / (recencyOrder.length - 1)) * 15
      : 15;

    // Presence is weighted, never a hard gate, even when respect_presence is
    // on: an agent working the queue by email is genuinely available while
    // having no SSE connection open, and blocking on presence would hand
    // every ticket to whoever happens to have a browser tab open.
    let score = headroom * 50 + recencyScore;
    if (isOnline) score += 30;
    if (isOnCall) score += 20;
    if (status === 'busy') score -= 25;

    return {
      user_id: c.id,
      name: c.name,
      email: c.email,
      team: c.team || null,
      status,
      skills,
      capacity,
      open_tickets: openTickets,
      on_call: isOnCall,
      online: isOnline,
      // 0 = waited longest since their last assignment. Kept on the
      // candidate (not just folded into score) so the round_robin strategy
      // can make recency dominate rather than merely contribute.
      recency_rank: recencyRank,
      score: Math.round(score * 100) / 100,
      blocked,
      eligible: blocked.length === 0,
    };
  });

  // Deterministic ordering: score desc, then user id, so two runs over
  // unchanged data always produce the same winner.
  candidates.sort((a, b) => (b.score - a.score) || (a.user_id < b.user_id ? -1 : 1));
  return candidates;
}

function pickDeterministic(eligible, strategy) {
  if (!eligible.length) return null;
  if (strategy === 'round_robin') {
    // Whoever has waited longest since their last assignment, regardless of
    // load -- that is what makes it a rotation rather than a load balancer.
    return [...eligible].sort((a, b) =>
      (a.recency_rank - b.recency_rank) || (a.user_id < b.user_id ? -1 : 1)
    )[0];
  }
  if (strategy === 'least_loaded') {
    return [...eligible].sort((a, b) =>
      (a.open_tickets - b.open_tickets) || (b.score - a.score) || (a.user_id < b.user_id ? -1 : 1)
    )[0];
  }
  if (strategy === 'oncall_first') {
    const onCall = eligible.filter((c) => c.on_call);
    const pool = onCall.length ? onCall : eligible;
    return [...pool].sort((a, b) => (b.score - a.score) || (a.user_id < b.user_id ? -1 : 1))[0];
  }
  return eligible[0]; // already score-sorted
}

// The security boundary for Sona's answer, kept as a pure function so it can
// be tested directly against hallucinated ids and malformed output without
// standing up a fake LLM.
//
// Mirrors the allowlist discipline of POST /reports/sona
// (routes/reports.js): the model's response is checked against permitted
// values before it is allowed to mean anything. An id the model invented, or
// one belonging to a real user who was filtered out for being on leave or at
// capacity, must never be able to receive a ticket -- so membership of
// `allowedIds` is the test, not merely "is this a plausible user id".
//
// Returns null on any doubt at all; the caller then uses its deterministic
// fallback.
export function parseSonaVerdict(text, allowedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
  if (!allowed.size) return null;

  let parsed;
  try {
    const cleaned = String(text || '').trim()
      .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.user_id !== 'string' || !allowed.has(parsed.user_id)) return null;

  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 140) : '';
  return { user_id: parsed.user_id, rationale };
}

// Sona's judgment step. Returns null on *any* doubt -- no provider, a
// transport error, or output that fails parseSonaVerdict above -- and the
// caller falls back to the deterministic pick.
async function askSona(workspaceId, ticket, shortlist) {
  const provider = getProvider(workspaceId);
  if (!provider) return null;

  const roster = shortlist.map((c) => ({
    user_id: c.user_id,
    name: c.name,
    team: c.team,
    skills: c.skills,
    open_tickets: c.open_tickets,
    capacity: c.capacity,
    on_call: c.on_call,
  }));

  try {
    const text = await chatComplete(provider, [
      {
        role: 'system',
        content: 'You route IT service desk tickets to the best-suited engineer from a supplied shortlist. Everyone on the shortlist is already confirmed available and within capacity, so judge only on fit between the ticket and the person. Return strict JSON only.',
      },
      {
        role: 'user',
        content: `Ticket:\n`
          + `Type: ${ticket.type || 'incident'}\n`
          + `Priority: ${ticket.priority || 'medium'}\n`
          + `Category: ${ticket.category || 'none'}\n`
          + `Title: ${ticket.title || ''}\n`
          + `Description: ${String(ticket.description || '').slice(0, 1200)}\n\n`
          + `Shortlist (choose exactly one user_id from this list):\n${JSON.stringify(roster, null, 1)}\n\n`
          + `Return exactly: {"user_id":"<one id from the shortlist>","rationale":"<one short sentence, max 140 chars>"}`,
      },
    ], { json: true, temperature: 0.1, max_tokens: 200 });

    return parseSonaVerdict(text, new Set(shortlist.map((c) => c.user_id)));
  } catch (e) {
    // Includes NO_PROVIDER from chatComplete, network failures and bad JSON.
    // None of these should stop a ticket getting an owner.
    console.error('[assignment] Sona judgment unavailable, using deterministic pick:', e.message);
    return null;
  }
}

// Decides (but does not persist) who should take this ticket.
// Exported so the admin dry-run simulator can show exactly what would happen
// without touching the ticket -- the simulator and the live path therefore
// cannot disagree, because they are the same function.
export async function decideAssignment(workspaceId, ticket, { useAi = true } = {}) {
  const policy = findAssignmentPolicy(workspaceId, {
    type: ticket.type, priority: ticket.priority, team: ticket.team, category: ticket.category,
  });
  if (!policy) {
    return { policy: null, candidates: [], chosen: null, strategyUsed: null, aiUsed: false, rationale: 'No assignment policy matches this ticket' };
  }

  const candidates = scoreCandidates(policy, workspaceId);
  const eligible = candidates.filter((c) => c.eligible);
  if (!eligible.length) {
    return {
      policy, candidates, chosen: null, strategyUsed: policy.strategy, aiUsed: false,
      rationale: candidates.length ? 'Every candidate was filtered out by availability rules' : 'The policy produced no candidates at all',
    };
  }

  const wantsAi = useAi && policy.ai_enabled && policy.strategy === 'ai_sona';
  if (wantsAi) {
    const shortlist = eligible.slice(0, AI_SHORTLIST);
    const verdict = await askSona(workspaceId, ticket, shortlist);
    if (verdict) {
      const chosen = shortlist.find((c) => c.user_id === verdict.user_id);
      return {
        policy, candidates, chosen, strategyUsed: 'ai_sona', aiUsed: true,
        rationale: verdict.rationale || `Sona selected ${chosen.name}`,
      };
    }
    const fallback = pickDeterministic(eligible, policy.fallback_strategy);
    return {
      policy, candidates, chosen: fallback, strategyUsed: policy.fallback_strategy, aiUsed: false,
      rationale: `Sona unavailable — fell back to ${policy.fallback_strategy.replace(/_/g, ' ')}`,
    };
  }

  const chosen = pickDeterministic(eligible, policy.strategy);
  return {
    policy, candidates, chosen, strategyUsed: policy.strategy, aiUsed: false,
    rationale: `Selected by ${policy.strategy.replace(/_/g, ' ')}`,
  };
}

function logDecision(workspaceId, ticketId, decision) {
  db.prepare(
    `INSERT INTO assignment_log (id, workspace_id, ticket_id, policy_id, assigned_user_id, strategy_used, ai_used, candidates, rationale)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    uid('asg'), workspaceId, ticketId || null, decision.policy?.id || null,
    decision.chosen?.user_id || null, decision.strategyUsed || null,
    decision.aiUsed ? 1 : 0, JSON.stringify(decision.candidates || []), decision.rationale || null
  );
}

// Assigns the ticket for real. Only ever acts on an unassigned ticket --
// auto-assignment must never quietly take a ticket away from whoever a human
// deliberately put on it.
export async function autoAssign(ticket) {
  if (!ticket || !ticket.workspace_id) return null;
  if (ticket.assignee_id) return null;
  if (['resolved', 'closed'].includes(ticket.status)) return null;

  const decision = await decideAssignment(ticket.workspace_id, ticket);
  logDecision(ticket.workspace_id, ticket.id, decision);
  if (!decision.chosen) return null;

  db.prepare("UPDATE tickets SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(decision.chosen.user_id, ticket.id);

  const how = decision.aiUsed ? 'Sona' : 'assignment policy';
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'assigned',
    `Auto-assigned to ${decision.chosen.name} by ${how} — ${decision.rationale}`
  );
  notifyUser(
    decision.chosen.user_id,
    `Assigned to you: ${ticket.number || ticket.id}`,
    `${ticket.number || ''} ${ticket.title || ''}`.trim() + ` — ${decision.rationale}`,
    `/tickets/${ticket.id}`,
    ticket.workspace_id
  );

  return { userId: decision.chosen.user_id, name: decision.chosen.name, aiUsed: decision.aiUsed, rationale: decision.rationale };
}

// Fire-and-forget wrapper for route handlers, matching
// evaluateEscalationsSafely in escalationEngine.js: routing is a side effect
// of creating a ticket and must never be the reason the create fails.
export function autoAssignSafely(ticket) {
  autoAssign(ticket).catch((e) => console.error('[assignment] auto-assign error', e));
}

// Convenience for the on-call tab: who would this schedule page right now.
export function currentOnCallFor(scheduleId) {
  return resolveOnCall(scheduleId, new Date());
}
