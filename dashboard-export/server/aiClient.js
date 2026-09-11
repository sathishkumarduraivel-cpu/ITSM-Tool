// Generic multi-provider LLM client.
// Supports: openai (and any OpenAI-compatible endpoint e.g. OpenRouter, Groq, Together, LM Studio),
//           anthropic, azure_openai, ollama (local), google (Gemini), custom (raw OpenAI-shaped endpoint).
// The whole point: bring your OWN key + base URL + model. Nothing is hard-coded to one vendor.

import fetch from 'node-fetch';
import { db } from '../db.js';

export function getProvider(providerId) {
  if (providerId) {
    const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId);
    if (row) return row;
  }
  const def = db.prepare('SELECT * FROM ai_providers WHERE is_default = 1 ORDER BY created_at DESC LIMIT 1').get();
  return def || null;
}

function parseHeaders(row) {
  try {
    return row.extra_headers ? JSON.parse(row.extra_headers) : {};
  } catch {
    return {};
  }
}

// Normalizes a chat completion call across providers.
// messages: [{role: 'system'|'user'|'assistant', content: string}]
export async function chatComplete(provider, messages, opts = {}) {
  if (!provider) {
    throw Object.assign(new Error('No AI provider configured. Add one in AI Settings.'), { code: 'NO_PROVIDER' });
  }
  const { temperature = 0.3, max_tokens = 800, json = false } = opts;
  const headers = parseHeaders(provider);

  switch (provider.provider_type) {
    case 'anthropic': {
      const base = provider.base_url || 'https://api.anthropic.com';
      const system = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system');
      const resp = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.api_key,
          'anthropic-version': '2023-06-01',
          ...headers,
        },
        body: JSON.stringify({
          model: provider.model,
          system,
          max_tokens,
          temperature,
          messages: rest.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `Anthropic error (${resp.status})`);
      return data?.content?.[0]?.text || '';
    }

    case 'ollama': {
      const base = provider.base_url || 'http://localhost:11434';
      const resp = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          model: provider.model,
          messages,
          stream: false,
          options: { temperature },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `Ollama error (${resp.status})`);
      return data?.message?.content || '';
    }

    case 'google': {
      const base = provider.base_url || 'https://generativelanguage.googleapis.com';
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system');
      const resp = await fetch(
        `${base}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${provider.api_key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({
            systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
            contents: rest.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: { temperature, maxOutputTokens: max_tokens },
          }),
        }
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `Google error (${resp.status})`);
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    }

    case 'azure_openai': {
      // base_url expected like https://<resource>.openai.azure.com/openai/deployments/<deployment>
      const base = provider.base_url;
      if (!base) throw new Error('Azure OpenAI requires a base_url (resource + deployment path)');
      const resp = await fetch(`${base}/chat/completions?api-version=2024-06-01`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': provider.api_key, ...headers },
        body: JSON.stringify({
          messages,
          temperature,
          max_tokens,
          response_format: json ? { type: 'json_object' } : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `Azure OpenAI error (${resp.status})`);
      return data?.choices?.[0]?.message?.content || '';
    }

    case 'openai':
    case 'custom':
    default: {
      // Works for OpenAI, OpenRouter, Groq, Together, Fireworks, LM Studio, vLLM, etc.
      const base = provider.base_url || 'https://api.openai.com/v1';
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {}),
          ...headers,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature,
          max_tokens,
          response_format: json ? { type: 'json_object' } : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `AI provider error (${resp.status})`);
      return data?.choices?.[0]?.message?.content || '';
    }
  }
}

export async function testProvider(provider) {
  const text = await chatComplete(provider, [
    { role: 'system', content: 'Reply with the single word: OK' },
    { role: 'user', content: 'ping' },
  ], { max_tokens: 10, temperature: 0 });
  return text.trim();
}

// ---- Higher-level ITSM AI helpers ----

export async function summarizeTicket(provider, ticket, comments = []) {
  const convo = comments.map((c) => `- (${c.author_name || 'user'}): ${c.body}`).join('\n');
  const prompt = `Ticket #${ticket.number} [${ticket.type}]\nTitle: ${ticket.title}\nDescription: ${ticket.description || ''}\nPriority: ${ticket.priority}\nStatus: ${ticket.status}\n\nConversation:\n${convo || '(no comments yet)'}\n\nWrite a crisp 2-3 sentence summary of this ticket for an IT agent, highlighting the core issue, what's been tried, and current blocker if any.`;
  return chatComplete(provider, [
    { role: 'system', content: 'You are an expert IT service desk assistant. Be concise and factual.' },
    { role: 'user', content: prompt },
  ]);
}

export async function suggestResolution(provider, ticket, comments = [], kbContext = '') {
  const convo = comments.map((c) => `- (${c.author_name || 'user'}): ${c.body}`).join('\n');
  const prompt = `Ticket #${ticket.number} [${ticket.type}]\nTitle: ${ticket.title}\nDescription: ${ticket.description || ''}\nCategory: ${ticket.category || 'uncategorized'}\n\nConversation so far:\n${convo || '(none)'}\n\n${kbContext ? `Relevant knowledge base excerpts:\n${kbContext}\n\n` : ''}Suggest a clear, numbered, step-by-step resolution plan an agent (or the end user) could follow. If you are not confident, say what additional info is needed.`;
  return chatComplete(provider, [
    { role: 'system', content: 'You are a senior IT support engineer providing actionable resolution steps.' },
    { role: 'user', content: prompt },
  ]);
}

export async function categorizeTicket(provider, ticket) {
  const prompt = `Classify this IT service desk ticket.\nTitle: ${ticket.title}\nDescription: ${ticket.description || ''}\n\nRespond with strict JSON only, no markdown, matching this shape:\n{"category": string, "subcategory": string, "priority": "low"|"medium"|"high"|"critical", "sentiment": "positive"|"neutral"|"frustrated"|"angry"}\nCategory should be one of: Hardware, Software, Network, Access & Identity, Email, Facilities, HR, Security, Other.`;
  const text = await chatComplete(
    provider,
    [
      { role: 'system', content: 'You are a ticket triage classifier. Always answer with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true, max_tokens: 200, temperature: 0 }
  );
  try {
    const cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '');
    return JSON.parse(cleaned);
  } catch {
    return { category: 'Other', subcategory: '', priority: ticket.priority, sentiment: 'neutral', raw: text };
  }
}

export async function dashboardInsights(provider, stats) {
  const prompt = `Here is aggregated service desk data (JSON):\n${JSON.stringify(stats, null, 2)}\n\nAs a service delivery analyst, write a short executive briefing (max 5 bullet points as plain sentences, no markdown bullets, just short numbered sentences) highlighting: notable trends, SLA risk, workload hotspots, and one concrete recommendation. Be specific and reference the numbers.`;
  return chatComplete(provider, [
    { role: 'system', content: 'You are an ITSM operations analyst producing crisp executive insights.' },
    { role: 'user', content: prompt },
  ]);
}

export async function askAssistant(provider, question, context) {
  const prompt = `Service desk context (aggregated, JSON):\n${JSON.stringify(context, null, 2)}\n\nQuestion from an IT manager: "${question}"\n\nAnswer using only the given data. If the data doesn't cover it, say so plainly. Be concise.`;
  return chatComplete(provider, [
    { role: 'system', content: 'You are an AI assistant embedded in an ITSM platform, answering questions about live ticket/asset data.' },
    { role: 'user', content: prompt },
  ]);
}
