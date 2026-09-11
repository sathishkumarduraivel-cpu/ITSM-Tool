import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal, Play, Loader2, Copy, Check, KeyRound, Rocket, Ticket, Boxes, BookOpen, Users,
  Clock, ShieldCheck, ExternalLink,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';

const METHOD_STYLE = {
  GET: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400 border-sky-200 dark:border-sky-500/20',
  POST: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20',
  PATCH: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border-amber-200 dark:border-amber-500/20',
  DELETE: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 border-red-200 dark:border-red-500/20',
};

function MethodBadge({ method }) {
  return <span className={`inline-flex items-center justify-center w-16 shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-bold font-mono ${METHOD_STYLE[method]}`}>{method}</span>;
}

// Hand-written to mirror server/src/routes/publicApi.js exactly -- this file
// IS the documentation, not generated from a spec, so every field here has
// to be kept honest against the real route by hand. Each endpoint carries
// its own editable param list, feeding both the curl example and the live
// "Try it" request below.
const ENDPOINTS = [
  {
    id: 'list-tickets', group: 'Tickets', icon: Ticket, method: 'GET', path: '/tickets', scope: 'tickets:read',
    summary: 'List tickets',
    description: 'Returns tickets in this workspace, newest first. Spam-flagged tickets are excluded.',
    params: [
      { name: 'status', in: 'query', type: 'string', desc: 'Filter by status (open, in_progress, on_hold, resolved, closed)' },
      { name: 'priority', in: 'query', type: 'string', desc: 'Filter by priority (low, medium, high, critical)' },
      { name: 'type', in: 'query', type: 'string', desc: 'Filter by type (incident, request, problem, change)' },
      { name: 'limit', in: 'query', type: 'number', default: '50', desc: 'Max results (up to 200)' },
    ],
    response: { data: [{ id: 'tkt_abc123', number: 'INC-1042', type: 'incident', title: 'VPN down for EU office', status: 'open', priority: 'high', requester: { name: 'Sam Requester', email: 'sam@company.com' }, assignee: null, created_at: '2026-09-01 10:22:00' }], total: 1, limit: 50, offset: 0 },
  },
  {
    id: 'get-ticket', group: 'Tickets', icon: Ticket, method: 'GET', path: '/tickets/:id', scope: 'tickets:read',
    summary: 'Get a ticket',
    description: 'Returns one ticket by its internal id.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: 'The ticket id, e.g. tkt_abc123' }],
    response: { data: { id: 'tkt_abc123', number: 'INC-1042', type: 'incident', title: 'VPN down for EU office', description: 'Multiple users report...', status: 'open', priority: 'high', sla_due_at: '2026-09-01 18:22:00', requester: { name: 'Sam Requester', email: 'sam@company.com' } } },
  },
  {
    id: 'create-ticket', group: 'Tickets', icon: Ticket, method: 'POST', path: '/tickets', scope: 'tickets:write',
    summary: 'Create a ticket',
    description: 'Files a new ticket -- typically from a monitoring system, an internal tool, or another company platform. If requester_email is given, it must match an active member of this workspace.',
    params: [
      { name: 'title', in: 'body', type: 'string', required: true, desc: 'Short summary' },
      { name: 'description', in: 'body', type: 'string', desc: 'Full details' },
      { name: 'type', in: 'body', type: 'string', default: 'incident', desc: 'incident, request, problem, or change' },
      { name: 'priority', in: 'body', type: 'string', default: 'medium', desc: 'low, medium, high, or critical' },
      { name: 'category', in: 'body', type: 'string', desc: 'Free-text category' },
      { name: 'requester_email', in: 'body', type: 'string', desc: 'Attributes the ticket to an existing workspace member' },
    ],
    response: { data: { id: 'tkt_new456', number: 'INC-1055', status: 'open', source: 'api' } },
  },
  {
    id: 'update-ticket', group: 'Tickets', icon: Ticket, method: 'PATCH', path: '/tickets/:id', scope: 'tickets:write',
    summary: 'Update a ticket',
    description: 'Updates status, priority, category, or team. Setting status to resolved or closed stamps the corresponding timestamp automatically.',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: 'The ticket id' },
      { name: 'status', in: 'body', type: 'string', desc: 'New status' },
      { name: 'priority', in: 'body', type: 'string', desc: 'New priority' },
      { name: 'team', in: 'body', type: 'string', desc: 'New owning team' },
    ],
    response: { data: { id: 'tkt_abc123', status: 'resolved', resolved_at: '2026-09-01 12:00:00' } },
  },
  {
    id: 'comment-ticket', group: 'Tickets', icon: Ticket, method: 'POST', path: '/tickets/:id/comments', scope: 'tickets:write',
    summary: 'Add a comment',
    description: "Posts a public reply, visible to the ticket's requester the same as one posted from the app.",
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: 'The ticket id' },
      { name: 'body', in: 'body', type: 'string', required: true, desc: 'Comment text' },
      { name: 'author_name', in: 'body', type: 'string', desc: 'Attributed name (shown as "name (via your key)")' },
    ],
    response: { data: { id: 'cmt_789', body: 'We\'ve deployed a fix, please confirm.', author_name: 'Monitoring Bot (via Datadog Sync)' } },
  },
  {
    id: 'list-assets', group: 'Assets', icon: Boxes, method: 'GET', path: '/assets', scope: 'assets:read',
    summary: 'List assets',
    description: 'Returns CMDB assets across the workspace.',
    params: [{ name: 'limit', in: 'query', type: 'number', default: '50', desc: 'Max results (up to 200)' }],
    response: { data: [{ id: 'ast_1', tag: 'LAP-0091', name: 'Sam\'s MacBook Pro', type: 'hardware', status: 'in_use', location: 'London Office' }] },
  },
  {
    id: 'search-kb', group: 'Knowledge Base', icon: BookOpen, method: 'GET', path: '/kb', scope: 'kb:read',
    summary: 'Search articles',
    description: 'Full-text search across knowledge base articles.',
    params: [
      { name: 'q', in: 'query', type: 'string', desc: 'Search text (matches title or body)' },
      { name: 'limit', in: 'query', type: 'number', default: '20', desc: 'Max results (up to 100)' },
    ],
    response: { data: [{ id: 'kb_1', title: 'Resetting your VPN client', category: 'Network', views: 214 }] },
  },
  {
    id: 'lookup-users', group: 'Users', icon: Users, method: 'GET', path: '/users', scope: 'users:read',
    summary: 'Look up users',
    description: 'Looks up active workspace members, optionally by exact email.',
    params: [{ name: 'email', in: 'query', type: 'string', desc: 'Exact email match' }],
    response: { data: [{ id: 'usr_1', name: 'Sam Requester', email: 'sam@company.com', role: 'requester', team: null }] },
  },
];

const GROUPS = [...new Set(ENDPOINTS.map((e) => e.group))];
const GROUP_ICON = { Tickets: Ticket, Assets: Boxes, 'Knowledge Base': BookOpen, Users: Users };

function CodeBlock({ children, className = '' }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === 'string' ? children : JSON.stringify(children, null, 2);
  const copy = () => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <div className={`relative group ${className}`}>
      <pre className="bg-slate-900 dark:bg-black/60 text-slate-100 text-xs rounded-xl p-4 overflow-x-auto font-mono leading-relaxed border border-slate-800">{text}</pre>
      <button onClick={copy} className="absolute top-2 right-2 p-1.5 rounded-md bg-slate-800/80 text-slate-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function GettingStarted({ baseUrl }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100 mb-1.5 flex items-center gap-2"><Rocket size={18} className="text-brand-600 dark:text-brand-400" /> Getting started</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
          The public API lets another system in your company — a monitoring tool, an HR platform, an internal script — read and write directly against this workspace, without a user having to sign in. It's versioned and kept separate from the API this app's own interface uses internally, so it won't change out from under an integration you've already built.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5">Base URL</h3>
        <CodeBlock>{`${baseUrl}/api/v1`}</CodeBlock>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5 flex items-center gap-1.5"><KeyRound size={14} /> Authentication</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
          Create a key under Admin Settings → API Keys, then send it as a bearer token on every request:
        </p>
        <CodeBlock>{`Authorization: Bearer itsm_live_••••••••••••••••••••••••••••••••`}</CodeBlock>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5 flex items-center gap-1.5"><ShieldCheck size={14} /> Scopes</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every key is granted a specific set of scopes when it's created (e.g. <code className="text-xs bg-slate-100 dark:bg-slate-800 rounded px-1 py-0.5">tickets:read</code>) — a request fails with <code className="text-xs bg-slate-100 dark:bg-slate-800 rounded px-1 py-0.5">403</code> if its key doesn't have the scope that endpoint requires. Grant only what an integration actually needs.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5 flex items-center gap-1.5"><Clock size={14} /> Rate limits</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">120 requests per minute, per key.</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5">Example</h3>
        <CodeBlock>{`curl "${baseUrl}/api/v1/tickets?status=open&priority=critical" \\\n  -H "Authorization: Bearer itsm_live_••••••••••••••••••••••••••••••••"`}</CodeBlock>
      </div>
    </div>
  );
}

function TryItPanel({ endpoint, paramValues, manualKey, setManualKey }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const resolvedPath = endpoint.path.replace(/:id/g, paramValues.id || ':id');

  const send = async () => {
    setSending(true);
    setResult(null);
    if (!manualKey.trim()) { setResult({ error: 'Paste a real API key below to send a live request.' }); setSending(false); return; }
    try {
      const query = endpoint.params.filter((p) => p.in === 'query' && paramValues[p.name]);
      const qs = new URLSearchParams(Object.fromEntries(query.map((p) => [p.name, paramValues[p.name]]))).toString();
      const url = `/api/v1${resolvedPath}${qs ? `?${qs}` : ''}`;
      const bodyParams = endpoint.params.filter((p) => p.in === 'body' && paramValues[p.name]);
      const body = bodyParams.length ? JSON.stringify(Object.fromEntries(bodyParams.map((p) => [p.name, paramValues[p.name]]))) : undefined;
      const started = performance.now();
      const resp = await fetch(url, {
        method: endpoint.method,
        headers: { authorization: `Bearer ${manualKey.trim()}`, 'content-type': 'application/json' },
        body,
      });
      const ms = Math.round(performance.now() - started);
      const data = await resp.json().catch(() => null);
      setResult({ status: resp.status, ok: resp.ok, ms, data });
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card p-4 space-y-3 bg-slate-50/60 dark:bg-slate-800/30">
      <div className="flex items-center gap-2">
        <Terminal size={15} className="text-brand-600 dark:text-brand-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Try it</h3>
      </div>
      <div>
        <label className="label">API key</label>
        <input
          className="input font-mono text-xs"
          placeholder="itsm_live_…"
          value={manualKey}
          onChange={(e) => setManualKey(e.target.value)}
        />
        <p className="text-xs text-slate-400 mt-1">Pasted here only to fire this test request — never sent anywhere but this endpoint, and never saved.</p>
      </div>
      <button onClick={send} disabled={sending} className="btn-primary w-full justify-center">
        {sending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Send {endpoint.method} request
      </button>
      {result && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
          {result.error ? (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{result.error}</div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1.5 text-xs">
                <span className={`font-mono font-bold ${result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{result.status}</span>
                <span className="text-slate-400">{result.ms}ms</span>
              </div>
              <CodeBlock>{result.data}</CodeBlock>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EndpointView({ endpoint, baseUrl }) {
  const [paramValues, setParamValues] = useState({});
  const [manualKey, setManualKey] = useState('');

  useEffect(() => { setParamValues({}); }, [endpoint.id]);

  const setParam = (name, value) => setParamValues((prev) => ({ ...prev, [name]: value }));

  const curl = useMemo(() => {
    const resolvedPath = endpoint.path.replace(/:id/g, paramValues.id || ':id');
    const query = endpoint.params.filter((p) => p.in === 'query' && paramValues[p.name]);
    const qs = new URLSearchParams(Object.fromEntries(query.map((p) => [p.name, paramValues[p.name]]))).toString();
    const bodyParams = endpoint.params.filter((p) => p.in === 'body' && paramValues[p.name]);
    const bodyStr = bodyParams.length ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(Object.fromEntries(bodyParams.map((p) => [p.name, paramValues[p.name]])))}'` : '';
    const methodFlag = endpoint.method === 'GET' ? '' : ` -X ${endpoint.method}`;
    return `curl${methodFlag} "${baseUrl}/api/v1${resolvedPath}${qs ? `?${qs}` : ''}" \\\n  -H "Authorization: Bearer itsm_live_…"${bodyStr}`;
  }, [endpoint, paramValues, baseUrl]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <MethodBadge method={endpoint.method} />
          <code className="text-sm font-mono text-slate-700 dark:text-slate-200">{endpoint.path}</code>
          <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 font-mono text-[10px] ml-auto">{endpoint.scope}</span>
        </div>
        <h2 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{endpoint.summary}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{endpoint.description}</p>
      </div>

      {endpoint.params.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Parameters</h3>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">In</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
                  <th className="text-left px-3 py-2 font-medium w-48">Try it</th>
                </tr>
              </thead>
              <tbody>
                {endpoint.params.map((p) => (
                  <tr key={p.name} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-200">{p.name}{p.required && <span className="text-red-500">*</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{p.in}</td>
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{p.desc}{p.default && <span className="text-slate-400"> (default: {p.default})</span>}</td>
                    <td className="px-3 py-1.5">
                      <input
                        className="input py-1 text-xs"
                        placeholder={p.default || p.type}
                        value={paramValues[p.name] || ''}
                        onChange={(e) => setParam(p.name, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Example request</h3>
        <CodeBlock>{curl}</CodeBlock>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Example response</h3>
        <CodeBlock>{endpoint.response}</CodeBlock>
      </div>

      <TryItPanel endpoint={endpoint} paramValues={paramValues} manualKey={manualKey} setManualKey={setManualKey} />
    </div>
  );
}

export default function DeveloperDocs() {
  const { user } = useAuth();
  const [selected, setSelected] = useState(null); // null = getting started
  const [keys, setKeys] = useState([]);
  const baseUrl = window.location.origin;

  useEffect(() => {
    if (user?.role === 'admin') api.get('/api-keys').then((d) => setKeys(d.keys)).catch(() => setKeys([]));
  }, [user]);

  const activeEndpoint = ENDPOINTS.find((e) => e.id === selected);

  return (
    <div className="space-y-4">
      <PageHeader title="Developer API" description="Connect other company systems directly to this workspace" />

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4 items-start">
        <div className="card p-2 lg:sticky lg:top-4">
          <button
            onClick={() => setSelected(null)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${!selected ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}
          >
            <Rocket size={14} /> Getting started
          </button>
          {GROUPS.map((group) => {
            const GroupIcon = GROUP_ICON[group];
            return (
              <div key={group} className="mt-2">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5"><GroupIcon size={11} /> {group}</div>
                {ENDPOINTS.filter((e) => e.group === group).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setSelected(e.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-left transition-colors ${selected === e.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}
                  >
                    <span className={`font-mono font-bold text-[9px] w-8 shrink-0 ${METHOD_STYLE[e.method].split(' ')[1]}`}>{e.method}</span>
                    <span className="truncate">{e.summary}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {user?.role === 'admin' && (
            <a href="/admin-settings" className="mt-2 flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 border-t border-slate-100 dark:border-slate-800 pt-3">
              <KeyRound size={12} /> {keys.length} API key{keys.length === 1 ? '' : 's'} <ExternalLink size={11} className="ml-auto" />
            </a>
          )}
        </div>

        <div className="card p-5 min-h-[400px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={selected || 'start'}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {activeEndpoint ? <EndpointView endpoint={activeEndpoint} baseUrl={baseUrl} /> : <GettingStarted baseUrl={baseUrl} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
