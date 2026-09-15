// "Email the support address, get a ticket" -- the inbound half of a
// connected Microsoft mailbox (services/graphMailer.js has the outbound
// half). Polled on a schedule (inboundEmailScheduler.js) rather than pushed
// via a Graph webhook subscription -- a real subscription needs a public
// validation handshake and periodic renewal (they expire after ~3 days);
// polling an unread-mail filter is a few lines and never expires, at the
// cost of a few minutes' latency, which is a fine trade for a support inbox.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, uid } from '../db.js';
import { getEmailSettings, sendTemplatedEmail, absoluteUrl } from './emailService.js';
import { getValidAccessToken, listUnreadInbox, markMessageRead } from './graphMailer.js';
import { nextTicketNumber } from './ticketNumbering.js';
import { computeSlaDueDate, findSlaPolicy } from './sla.js';
import { initialStageFor } from './lifecycleEngine.js';
import { evaluateAutomations } from './automationEngine.js';
import { broadcastToWorkspace } from './realtime.js';

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cuts a reply off at the quoted original message most email clients splice
// in below what someone actually typed -- without this, every back-and-forth
// on a ticket would re-paste the entire prior thread into the new comment,
// getting longer and more redundant with each reply.
const QUOTE_MARKERS = [
  /\r?\nOn .{0,120} wrote:\r?\n/i,
  /\r?\n-{2,}\s*Original Message\s*-{2,}/i,
  /\r?\nFrom:\s*.{0,200}\r?\nSent:/i,
  /\r?\n_{10,}\r?\n/,
  /\r?\n>.*(\r?\n>.*){2,}/, // three-plus consecutive '>'-quoted lines
];
function trimQuotedReply(text) {
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = text.match(marker);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

function findOrCreateRequester(workspaceId, email, displayName) {
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    const id = uid('usr');
    const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    const unusablePassword = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    db.prepare('INSERT INTO users (id, name, email, password_hash, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?)')
      .run(id, displayName || email, email, unusablePassword, colors[Math.floor(Math.random() * colors.length)], workspaceId);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  let membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, user.id);
  if (!membership) {
    db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?,?,?,?)').run(uid('wm'), workspaceId, user.id, 'requester');
    membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, user.id);
  }
  return { user, active: !!membership.active };
}

function logInbound(workspaceId, { messageId, fromEmail, subject, action, ticketId, detail }) {
  db.prepare(
    'INSERT INTO email_inbound_log (id, workspace_id, message_id, from_email, subject, action, ticket_id, detail) VALUES (?,?,?,?,?,?,?,?)'
  ).run(uid('eil'), workspaceId, messageId || null, fromEmail || null, subject || null, action, ticketId || null, detail || null);
}

// A reply's subject preserves "[INC-1042]" from the outbound template
// (see emailTemplateCatalog.js's ticket_comment_reply: "Re: [{{ticket.number}}] ...")
// in every mainstream mail client's default Reply behavior -- the same
// subject-token convention most real helpdesks rely on for exactly this.
function extractTicketNumber(subject) {
  const m = String(subject || '').match(/\[([A-Z]+-\d+)\]/);
  return m ? m[1] : null;
}

// A bare From: header is not proof of who actually sent a message -- SMTP
// never guaranteed that, and this app has no way to check it directly. What
// it CAN check is Authentication-Results, a header the *receiving* mail
// server (Microsoft's, here) stamps onto the message after doing SPF/DKIM/
// DMARC evaluation against the sending server -- attacker-controlled only in
// the sense that a hostile server could forge the header text too, but
// Microsoft strips/rewrites any pre-existing Authentication-Results from the
// incoming SMTP session before stamping its own, so this one line is the one
// part of the message this app can trust. Anything without a passing DMARC
// (or aligned SPF+DKIM) verdict is treated as unverified -- see its one call
// site below, which is deliberately the higher-stakes "this claims to be an
// existing ticket's requester" path, not the "create a brand-new ticket"
// path where impersonating an email address you don't own isn't really an
// attack on anyone else's data.
function isAuthenticatedSender(message) {
  const header = (message.internetMessageHeaders || []).find((h) => h.name?.toLowerCase() === 'authentication-results');
  if (!header?.value) return false;
  const value = header.value.toLowerCase();
  const dmarcPass = /dmarc=pass/.test(value);
  const spfPass = /spf=pass/.test(value);
  const dkimPass = /dkim=pass/.test(value);
  return dmarcPass || (spfPass && dkimPass);
}

async function processOneMessage(workspaceId, settings, accessToken, message) {
  const fromEmail = message.from?.emailAddress?.address;
  const fromName = message.from?.emailAddress?.name;
  const subject = message.subject || '(no subject)';
  if (!fromEmail) {
    logInbound(workspaceId, { messageId: message.id, subject, action: 'skipped', detail: 'No sender address on this message' });
    return 'skipped';
  }

  const rawBody = message.body?.contentType === 'html' ? stripHtml(message.body.content) : (message.body?.content || message.bodyPreview || '');
  const bodyText = trimQuotedReply(rawBody) || '(no message body)';

  const ticketNumber = extractTicketNumber(subject);
  if (ticketNumber) {
    const ticket = db.prepare('SELECT t.*, u.email AS requester_email FROM tickets t LEFT JOIN users u ON u.id = t.requester_id WHERE t.number = ? AND t.workspace_id = ? AND t.deleted_at IS NULL').get(ticketNumber, workspaceId);
    if (ticket && ticket.requester_email?.toLowerCase() === fromEmail.toLowerCase()) {
      // The From: address matching isn't proof by itself -- anyone can put
      // any address in that header. An unverified sender still gets their
      // reply recorded (dropping it silently would lose a possibly-genuine
      // message), but as a private note flagged as unverified rather than a
      // normal public reply attributed to the requester -- an agent has to
      // look at it before it reads as something the requester actually said.
      const authenticated = isAuthenticatedSender(message);
      const commentId = uid('cmt');
      const body = authenticated ? bodyText : `⚠️ Unverified sender — this email claimed to be from ${fromEmail} but could not be authenticated (failed SPF/DKIM/DMARC). Confirm before treating it as genuine.\n\n${bodyText}`;
      db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,?)').run(
        commentId, ticket.id, authenticated ? ticket.requester_id : null, authenticated ? (fromName || fromEmail) : 'Inbound email (unverified)', body, authenticated ? 0 : 1
      );
      db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      broadcastToWorkspace(workspaceId, 'ticket.comment', { ticketId: ticket.id });
      logInbound(workspaceId, { messageId: message.id, fromEmail, subject, action: 'comment_added', ticketId: ticket.id, detail: authenticated ? null : 'sender unverified -- posted as private note' });
      return 'comment_added';
    }
    // A subject carrying a ticket token that doesn't actually match (wrong
    // sender, or the ticket's gone) deliberately falls through to "create a
    // new ticket" below rather than being silently dropped -- the email
    // itself is still real and still deserves a response.
  }

  const { user: requester, active } = findOrCreateRequester(workspaceId, fromEmail, fromName);
  if (!active) {
    logInbound(workspaceId, { messageId: message.id, fromEmail, subject, action: 'skipped', detail: 'Sender’s account is deactivated in this workspace' });
    return 'skipped';
  }

  const type = settings.inbound_default_type || 'incident';
  const priority = 'medium';
  const id = uid('tkt');
  const number = nextTicketNumber(workspaceId, type);
  const policy = findSlaPolicy({ workspaceId, type, priority, category: null, team: null, title: subject, description: bodyText, source: 'email' });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? 1440, policy?.business_hours_only, new Date(), workspaceId);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), workspaceId);
  const initialStage = initialStageFor(workspaceId, type);

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, requester_id, sla_due_at, response_due_at, sla_policy_id, source, cab_status, lifecycle_stage, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'email','not_required',?,?)`
  ).run(id, workspaceId, number, type, subject, bodyText, priority, requester.id, sla_due_at, response_due_at, policy?.id || null, initialStage?.key || null, initialStage?.bucket || 'open');
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Ticket created from an inbound email (${fromEmail})`);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  evaluateAutomations('ticket_created', ticket).catch((e) => console.error('automation error', e));
  broadcastToWorkspace(workspaceId, 'ticket.created', { ticketId: id });
  sendTemplatedEmail(workspaceId, 'ticket_created', fromEmail, {
    'requester.name': requester.name, 'ticket.number': number, 'ticket.title': subject, 'ticket.priority': priority, 'ticket.link': absoluteUrl(`/tickets/${id}`),
  }).catch((e) => console.error('inbound ticket_created email error', e));
  logInbound(workspaceId, { messageId: message.id, fromEmail, subject, action: 'ticket_created', ticketId: id });
  return 'ticket_created';
}

// Polls one workspace's connected mailbox for unread mail and reconciles
// each message -- exported standalone (not only reachable via the
// scheduler) so a "Check now" button can call it on demand, the same
// manual/automatic split Directory Sync already offers.
export async function processInbox(workspaceId) {
  const settings = getEmailSettings(workspaceId);
  if (!settings || settings.mailbox_provider !== 'microsoft' || !settings.inbound_enabled || !settings.graph_refresh_token) {
    return { checked: 0, created: 0, commented: 0, skipped: 0 };
  }
  const accessToken = await getValidAccessToken(workspaceId, settings);
  const messages = await listUnreadInbox(accessToken);

  let created = 0; let commented = 0; let skipped = 0;
  for (const message of messages) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const action = await processOneMessage(workspaceId, settings, accessToken, message);
      if (action === 'ticket_created') created += 1;
      else if (action === 'comment_added') commented += 1;
      else skipped += 1;
    } catch (e) {
      logInbound(workspaceId, { messageId: message.id, subject: message.subject, action: 'error', detail: e.message });
      skipped += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await markMessageRead(accessToken, message.id).catch((e) => console.error('[inbound-email] failed to mark message read', e.message));
  }

  db.prepare("UPDATE email_settings SET inbound_last_synced_at = datetime('now') WHERE workspace_id = ?").run(workspaceId);
  return { checked: messages.length, created, commented, skipped };
}
