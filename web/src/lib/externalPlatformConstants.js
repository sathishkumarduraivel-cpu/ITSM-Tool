import { Cloud, Layers, LifeBuoy, Ticket } from 'lucide-react';

export const PLATFORMS = [
  {
    value: 'servicenow',
    label: 'ServiceNow',
    icon: Cloud,
    authFields: [
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
    mappingFields: [
      { key: 'table', label: 'Table (optional — defaults to "incident")', type: 'text' },
    ],
    baseUrlPlaceholder: 'https://yourinstance.service-now.com',
  },
  {
    value: 'jira',
    label: 'Jira',
    icon: Layers,
    authFields: [
      { key: 'email', label: 'Account email', type: 'text' },
      { key: 'api_token', label: 'API token', type: 'password' },
    ],
    mappingFields: [
      { key: 'project_key', label: 'Project key (e.g. PROJ)', type: 'text', required: true },
      { key: 'issue_type', label: 'Issue type (optional — defaults to "Task")', type: 'text' },
    ],
    baseUrlPlaceholder: 'https://yourorg.atlassian.net',
  },
  {
    value: 'freshservice',
    label: 'Freshservice',
    icon: LifeBuoy,
    authFields: [
      { key: 'api_key', label: 'API key', type: 'password' },
    ],
    mappingFields: [
      { key: 'default_requester_email', label: 'Default requester email', type: 'text', required: true },
      { key: 'group_id', label: 'Group ID (optional)', type: 'text' },
    ],
    baseUrlPlaceholder: 'https://yourdomain.freshservice.com',
  },
  {
    value: 'servicedeskplus',
    label: 'ServiceDesk Plus',
    icon: Ticket,
    authFields: [
      { key: 'api_key', label: 'Technician key', type: 'password' },
    ],
    mappingFields: [
      { key: 'default_requester_email', label: 'Default requester email', type: 'text', required: true },
    ],
    baseUrlPlaceholder: 'https://yourinstance.example.com',
  },
];

export function platformMeta(value) {
  return PLATFORMS.find((p) => p.value === value) || PLATFORMS[0];
}

export const SYNC_STATUS_STYLE = {
  synced: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  error: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
