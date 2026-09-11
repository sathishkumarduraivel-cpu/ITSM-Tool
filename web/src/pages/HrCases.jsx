import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, UserPlus, UserMinus } from 'lucide-react';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import { RevealGroup, RevealItem } from '../components/Reveal.jsx';
import NewHrCaseModal from '../components/hr-cases/NewHrCaseModal.jsx';
import RiskBadge from '../components/hr-cases/RiskBadge.jsx';
import { CASE_STATUS_STYLE } from '../lib/hrCaseConstants.js';

const TABS = [
  { key: 'onboarding', label: 'Onboarding', icon: UserPlus },
  { key: 'offboarding', label: 'Offboarding', icon: UserMinus },
];

export default function HrCases() {
  const navigate = useNavigate();
  const [caseType, setCaseType] = useState('onboarding');
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { cases } = await api.get(`/hr-cases?case_type=${caseType}`);
      setCases(cases);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [caseType]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <PageHeader
        title="Onboarding & Offboarding"
        description="Cross-department checklists for people joining or leaving — IT, HR, Facilities and their manager, all in one place"
        actions={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New {caseType} case</button>}
      />

      <div className="flex items-center rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden w-fit">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setCaseType(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium transition-colors ${
                caseType === t.key ? 'bg-brand-500 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && <SkeletonRows count={4} />}

      {!loading && cases.length === 0 && (
        <EmptyState
          icon={caseType === 'onboarding' ? UserPlus : UserMinus}
          title={`No ${caseType} cases yet`}
          description={`Start one for a new hire${caseType === 'offboarding' ? ' departure' : ''} — from a blank checklist, a saved template, or let Sona draft one from a plain-English description.`}
        />
      )}

      {!loading && cases.length > 0 && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                <th className="text-left px-4 py-2.5 font-medium">Stage</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                {caseType === 'offboarding' && <th className="text-left px-4 py-2.5 font-medium">Risk</th>}
                <th className="text-left px-4 py-2.5 font-medium">Tasks</th>
                <th className="text-left px-4 py-2.5 font-medium">{caseType === 'offboarding' ? 'Last day' : 'Start date'}</th>
              </tr>
            </thead>
            <RevealGroup as={motion.tbody}>
              {cases.map((c) => (
                <RevealItem
                  key={c.id} as={motion.tr}
                  onClick={() => navigate(`/hr-cases/${c.id}`)}
                  className="border-t border-slate-100 dark:border-slate-800 row-interactive"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{c.employee_name}</div>
                    <div className="text-slate-500 text-xs truncate max-w-xs">{c.job_title || '—'}{c.department ? ` · ${c.department}` : ''}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 capitalize">{(c.stage || '').replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2.5"><span className={`badge ${CASE_STATUS_STYLE[c.status]}`}>{c.status.replace('_', ' ')}</span></td>
                  {caseType === 'offboarding' && <td className="px-4 py-2.5"><RiskBadge level={c.risk_level} /></td>}
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400 text-xs">{c.taskDone}/{c.taskCount} done</td>
                  <td className="px-4 py-2.5 text-slate-400 text-xs">
                    {(caseType === 'offboarding' ? c.last_working_day : c.start_date) ? new Date(caseType === 'offboarding' ? c.last_working_day : c.start_date).toLocaleDateString() : '—'}
                  </td>
                </RevealItem>
              ))}
            </RevealGroup>
          </table>
        </div>
      )}

      {showNew && (
        <NewHrCaseModal
          caseType={caseType}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); navigate(`/hr-cases/${id}`); }}
        />
      )}
    </div>
  );
}
