import { AlertTriangle } from 'lucide-react';
import { RISK_STYLE } from '../../lib/hrCaseConstants.js';

export default function RiskBadge({ level }) {
  const isElevated = level === 'elevated';
  return (
    <span className={`badge ${RISK_STYLE[level] || RISK_STYLE.standard}`}>
      {isElevated && <AlertTriangle size={11} />} {isElevated ? 'Elevated risk' : 'Standard risk'}
    </span>
  );
}
