import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Sparkles, Trash2, CheckCircle2, XCircle, Star } from 'lucide-react';
import { api } from '../lib/api.js';
import Select from '../components/Select.jsx';

const PROVIDER_PRESETS = [
  { value: 'openai', label: 'OpenAI (or any OpenAI-compatible API)', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { value: 'anthropic', label: 'Anthropic Claude', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { value: 'azure_openai', label: 'Azure OpenAI', base_url: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT', model: 'gpt-4o-mini' },
  { value: 'google', label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com', model: 'gemini-1.5-flash' },
  { value: 'ollama', label: 'Ollama (local / self-hosted, no key needed)', base_url: 'http://localhost:11434', model: 'llama3.1' },
  { value: 'custom', label: 'Custom / other (OpenRouter, Groq, Together, vLLM, LM Studio…)', base_url: '', model: '' },
];

function NewProviderModal({ onClose, onSaved }) {
  const [preset, setPreset] = useState('openai');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0].base_url);
  const [model, setModel] = useState(PROVIDER_PRESETS[0].model);
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const applyPreset = (value) => {
    setPreset(value);
    const p = PROVIDER_PRESETS.find((p) => p.value === value);
    setBaseUrl(p.base_url);
    setModel(p.model);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/ai/providers', {
        name, provider_type: preset, base_url: baseUrl || null, api_key: apiKey || null, model, is_default: isDefault,
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">Add AI provider</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">Provider</label>
          <Select value={preset} onChange={applyPreset} options={PROVIDER_PRESETS} />
        </div>
        <div>
          <label className="label">Display name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team default GPT-4o mini" />
        </div>
        <div>
          <label className="label">Base URL {preset !== 'ollama' && '(leave default unless self-hosting or using a proxy)'}</label>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label className="label">Model</label>
          <input className="input" required value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o-mini, claude-sonnet-4-5, llama3.1" />
        </div>
        <div>
          <label className="label">API key {preset === 'ollama' && '(not required for local Ollama)'}</label>
          <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-… / your provider key" />
          <p className="text-xs text-slate-400 mt-1">Bring your own key from any provider — nothing is hard-coded to a single vendor.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Set as default provider for all AI features
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save provider
          </button>
        </div>
      </form>
    </div>
  );
}

export default function AISettings() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const { providers } = await api.get('/ai/providers');
      setProviders(providers);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const test = async (id) => {
    setTesting(id);
    try {
      const result = await api.post(`/ai/providers/${id}/test`, {});
      setTestResult((r) => ({ ...r, [id]: result }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, error: e.message } }));
    } finally {
      setTesting('');
    }
  };

  const makeDefault = async (id) => {
    await api.patch(`/ai/providers/${id}`, { is_default: true });
    load();
  };

  const remove = async (id) => {
    if (!confirm('Remove this AI provider?')) return;
    await api.del(`/ai/providers/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">AI Settings</h1>
          <p className="text-sm text-slate-500">Bring your own AI — any provider, any key, any model</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> Add provider</button>
      </div>

      <div className="card p-4 bg-brand-50/60 border-brand-100 text-sm text-slate-600 flex items-start gap-2">
        <Sparkles size={16} className="text-brand-600 mt-0.5 shrink-0" />
        <p>
          This platform is provider-agnostic: plug in OpenAI, Anthropic, Azure OpenAI, Google Gemini, a local Ollama model, or any
          OpenAI-compatible endpoint (OpenRouter, Groq, Together, LM Studio, vLLM…) by supplying your own API key, base URL and
          model name. Every AI feature — ticket summarization, auto-categorization, resolution suggestions, dashboard insights,
          and the chat assistant — routes through whichever provider you mark as default.
        </p>
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}
      {!loading && providers.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <Sparkles className="mx-auto mb-2 text-slate-300" size={28} /> No AI provider configured yet — add one to unlock AI features.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {providers.map((p) => (
          <div key={p.id} className="card p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-medium text-slate-800 flex items-center gap-1.5">
                  {p.name}
                  {!!p.is_default && <span className="badge bg-amber-50 text-amber-700"><Star size={11} /> default</span>}
                </div>
                <div className="text-xs text-slate-500">{p.provider_type} · {p.model}</div>
              </div>
              <button onClick={() => remove(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
            </div>
            <div className="flex items-center gap-2">
              {!p.is_default && (
                <button onClick={() => makeDefault(p.id)} className="btn-secondary text-xs">Make default</button>
              )}
              <button onClick={() => test(p.id)} disabled={testing === p.id} className="btn-secondary text-xs">
                {testing === p.id ? <Loader2 size={12} className="animate-spin" /> : null} Test connection
              </button>
            </div>
            {testResult[p.id] && (
              <div className={`mt-2 text-xs rounded-md px-2 py-1.5 flex items-center gap-1.5 ${testResult[p.id].ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                {testResult[p.id].ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {testResult[p.id].ok ? `Responded: "${testResult[p.id].reply}"` : testResult[p.id].error}
              </div>
            )}
          </div>
        ))}
      </div>

      {showNew && (
        <NewProviderModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />
      )}
    </div>
  );
}
