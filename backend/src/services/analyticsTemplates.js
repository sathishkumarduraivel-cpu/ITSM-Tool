// Ready-made boards. Two reasons these exist rather than starting everyone
// on an empty canvas: the obvious first report is the same in most service
// desks, and a blank builder is the point at which people give up on a
// reporting tool. Each is an ordinary board once created -- every card can be
// edited, moved or removed, so a template is a starting point and never a
// fixed layout.
//
// "Service desk overview" deliberately reproduces what the old reports page
// showed as hardcoded panels (volume, resolution, SLA, agent table, backlog
// by priority), so nothing that used to be on screen is lost -- it is now
// just made of cards you can change.
export const BOARD_TEMPLATES = [
  {
    key: 'overview',
    name: 'Service desk overview',
    description: 'Volume, resolution, SLA and where the work sits. The everyday report.',
    cards: [
      { title: 'Tickets raised', card_type: 'scorecard', span: 3, config: { metric: 'count', compare: true } },
      { title: 'Resolved', card_type: 'scorecard', span: 3, config: { metric: 'resolved', compare: true } },
      { title: 'SLA breached', card_type: 'scorecard', span: 3, config: { metric: 'breached', compare: true } },
      { title: 'Avg resolution', card_type: 'scorecard', span: 3, config: { metric: 'avg_resolution_hours', compare: true } },
      { title: 'Volume over time', card_type: 'trend', span: 12, config: { metric: 'count', time_dim: 'month', style: 'area' } },
      { title: 'By priority', card_type: 'donut', span: 4, config: { group_by: 'priority', metric: 'count', limit: 6 } },
      { title: 'By team', card_type: 'bar', span: 8, config: { group_by: 'team', metrics: ['count', 'resolved'], limit: 8 } },
      { title: 'Agent performance', card_type: 'table', span: 12, config: { group_by: 'assignee', metrics: ['count', 'resolved', 'breached', 'avg_resolution_hours'], sort_by: 'count', sort_dir: 'desc', limit: 12 } },
    ],
  },
  {
    key: 'sla',
    name: 'SLA & responsiveness',
    description: 'Where targets are being missed, and whether it is getting better or worse.',
    cards: [
      { title: 'SLA breached', card_type: 'scorecard', span: 4, config: { metric: 'breached', compare: true } },
      { title: 'First response on time', card_type: 'scorecard', span: 4, config: { metric: 'first_response_on_time_pct', compare: true } },
      { title: 'Avg resolution (hrs)', card_type: 'scorecard', span: 4, config: { metric: 'avg_resolution_hours', compare: true } },
      { title: 'Breaches over time', card_type: 'trend', span: 12, config: { metric: 'breached', time_dim: 'week', style: 'line' } },
      { title: 'Breaches by team', card_type: 'bar', span: 6, config: { group_by: 'team', metrics: ['breached'], orientation: 'horizontal', limit: 10 } },
      { title: 'Priority against team', card_type: 'pivot', span: 6, config: { row_dim: 'team', col_dim: 'priority' } },
    ],
  },
  {
    key: 'workload',
    name: 'Demand & workload',
    description: 'What is coming in, from where, and who is carrying it.',
    cards: [
      { title: 'Tickets raised', card_type: 'scorecard', span: 4, config: { metric: 'count', compare: true } },
      { title: 'Demand by month', card_type: 'trend', span: 8, config: { metric: 'count', time_dim: 'month', series_dim: 'type', style: 'line' } },
      { title: 'Where requests come from', card_type: 'donut', span: 4, config: { group_by: 'source', metric: 'count', limit: 6 } },
      { title: 'Busiest categories', card_type: 'bar', span: 8, config: { group_by: 'category', metrics: ['count'], orientation: 'horizontal', limit: 10 } },
      { title: 'Open work by assignee', card_type: 'table', span: 12, config: { group_by: 'assignee', metrics: ['count', 'breached'], sort_by: 'count', sort_dir: 'desc', limit: 15 } },
    ],
  },
  {
    key: 'satisfaction',
    name: 'Customer satisfaction',
    description: 'How the service feels to the people using it, not just how fast it closed.',
    cards: [
      { title: 'Avg CSAT', card_type: 'scorecard', span: 4, config: { metric: 'avg_csat', compare: true } },
      { title: 'Resolved', card_type: 'scorecard', span: 4, config: { metric: 'resolved', compare: true } },
      { title: 'Avg resolution (hrs)', card_type: 'scorecard', span: 4, config: { metric: 'avg_resolution_hours', compare: true } },
      { title: 'CSAT over time', card_type: 'trend', span: 12, config: { metric: 'avg_csat', time_dim: 'month', style: 'line' } },
      { title: 'CSAT by team', card_type: 'bar', span: 6, config: { group_by: 'team', metrics: ['avg_csat'], limit: 8 } },
      { title: 'CSAT by category', card_type: 'table', span: 6, config: { group_by: 'category', metrics: ['avg_csat', 'count'], sort_by: 'count', sort_dir: 'desc', limit: 10 } },
    ],
  },
];

export function templateBody(template, name) {
  return {
    name: String(name || '').trim() || template.name,
    description: template.description,
    visibility: 'shared',
    date_range: { preset: 'last_90_days' },
    cards: template.cards,
  };
}
