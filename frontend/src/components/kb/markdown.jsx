import { Fragment } from 'react';

// A small markdown renderer that produces React elements, never HTML.
//
// The app has no markdown dependency and no dangerouslySetInnerHTML anywhere,
// which is a deliberate position worth keeping: article bodies are written by
// agents, and search excerpts come back from the database with <mark> tags
// already in them. Handing either to innerHTML would turn "anyone who can
// author an article" into "anyone who can run script in a reader's browser".
//
// So this covers the subset people actually write in a knowledge article --
// headings, emphasis, code, lists, links, quotes, rules -- and renders
// everything else as plain text.

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text, keyPrefix) {
  const parts = String(text).split(INLINE).filter((p) => p !== '' && p !== undefined);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part)) {
      return <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-slate-800">{part.slice(1, -1)}</code>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = link[2];
      // Only http(s) and in-app links are turned into anchors. A
      // javascript: URL in an article body would otherwise be one click from
      // running in the reader's session.
      const safe = /^(https?:\/\/|\/)/i.test(href);
      return safe
        ? <a key={key} href={href} target={href.startsWith('/') ? undefined : '_blank'} rel="noreferrer"
             className="text-brand-600 underline hover:no-underline dark:text-brand-400">{link[1]}</a>
        : <span key={key}>{link[1]}</span>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function Markdown({ text, className = '' }) {
  if (!text) return null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let list = null;
  let code = null;

  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`l${blocks.length}`} className={`my-2 ${list.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
        {list.items.map((item, i) => <li key={i}>{renderInline(item, `li${blocks.length}-${i}`)}</li>)}
      </Tag>
    );
    list = null;
  };

  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (code === null) { flushList(); code = []; } else {
        blocks.push(
          <pre key={`c${idx}`} className="my-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
            {code.join('\n')}
          </pre>
        );
        code = null;
      }
      return;
    }
    if (code !== null) { code.push(raw); return; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const sizes = { 1: 'text-xl', 2: 'text-lg', 3: 'text-base', 4: 'text-sm' };
      blocks.push(
        <p key={`h${idx}`} className={`mt-4 mb-1 font-display font-semibold text-slate-800 dark:text-slate-100 ${sizes[level]}`}>
          {renderInline(heading[2], `h${idx}`)}
        </p>
      );
      return;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
      list.items.push((bullet || ordered)[1]);
      return;
    }
    flushList();

    if (/^>\s?/.test(line)) {
      blocks.push(
        <blockquote key={`q${idx}`} className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-300">
          {renderInline(line.replace(/^>\s?/, ''), `q${idx}`)}
        </blockquote>
      );
      return;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push(<hr key={`r${idx}`} className="my-3 border-slate-200 dark:border-slate-700" />);
      return;
    }
    if (!line.trim()) return;

    blocks.push(<p key={`p${idx}`} className="my-1.5 leading-relaxed">{renderInline(line, `p${idx}`)}</p>);
  });

  flushList();
  if (code !== null) {
    blocks.push(<pre key="ctail" className="my-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">{code.join('\n')}</pre>);
  }

  return <div className={`text-sm text-slate-700 dark:text-slate-200 ${className}`}>{blocks}</div>;
}

/**
 * A search excerpt, which arrives with <mark> around the matched terms.
 *
 * Split on the markers and rebuilt as React nodes rather than injected as
 * HTML -- the surrounding text is article content, so it is exactly the input
 * that must not be trusted.
 */
export function Excerpt({ text, className = '' }) {
  if (!text) return null;
  const parts = String(text).split(/(<mark>|<\/mark>)/);
  let on = false;
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (part === '<mark>') { on = true; return null; }
        if (part === '</mark>') { on = false; return null; }
        if (!part) return null;
        return on
          ? <mark key={i} className="rounded bg-amber-100 px-0.5 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200">{part}</mark>
          : <Fragment key={i}>{part}</Fragment>;
      })}
    </span>
  );
}
