import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  addEdge, MarkerType, useNodesState, useEdgesState, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Loader2, Save, AlertTriangle, Bot } from 'lucide-react';
import { api } from '../lib/api.js';
import { legacyToGraph, autoLayout, validateGraph, newNode, newTriggerScaffold } from '../lib/workflowGraph.js';
import TriggerNode from '../components/workflow/TriggerNode.jsx';
import ConditionNode from '../components/workflow/ConditionNode.jsx';
import ActionNode from '../components/workflow/ActionNode.jsx';
import ApprovalNode from '../components/workflow/ApprovalNode.jsx';
import Inspector from '../components/workflow/Inspector.jsx';
import ActivityPanel from '../components/workflow/ActivityPanel.jsx';
import Toolbar from '../components/workflow/Toolbar.jsx';
import ModeControl from '../components/workflow/ModeControl.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

const nodeTypes = { trigger: TriggerNode, condition: ConditionNode, action: ActionNode, approval: ApprovalNode };
const defaultEdgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };

function BuilderInner() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [testMode, setTestMode] = useState(false);
  const [fromSona, setFromSona] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [agents, setAgents] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [groups, setGroups] = useState([]);
  const [riskTiers, setRiskTiers] = useState({});
  const [highlight, setHighlight] = useState(null); // { nodeIds: Set, edgeIds: Set, gatedIds: Set } | null

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const past = useRef([]);
  const future = useRef([]);
  const [historyTick, setHistoryTick] = useState(0);
  // Field edits in the Inspector fire on every keystroke — snapshot once per
  // edit session (reset when selection changes) rather than per character,
  // so undo has sane granularity instead of one step per keypress.
  const fieldEditDirty = useRef(false);

  const commit = useCallback((mutator) => {
    past.current = [...past.current.slice(-24), { nodes, edges }];
    future.current = [];
    setHistoryTick((t) => t + 1);
    mutator();
  }, [nodes, edges, setNodes, setEdges]);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    const prev = past.current[past.current.length - 1];
    future.current = [{ nodes, edges }, ...future.current];
    past.current = past.current.slice(0, -1);
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setHistoryTick((t) => t + 1);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    const next = future.current[0];
    past.current = [...past.current, { nodes, edges }];
    future.current = future.current.slice(1);
    setNodes(next.nodes);
    setEdges(next.edges);
    setHistoryTick((t) => t + 1);
  }, [nodes, edges, setNodes, setEdges]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---- Load ----
  useEffect(() => {
    Promise.all([
      api.get('/auth/users'),
      api.get('/integrations'),
      api.get('/groups'),
      api.get('/automations/risk-tiers'),
    ]).then(([users, integ, groupsRes, tiersRes]) => {
      setAgents(users.users.filter((u) => u.role === 'agent' || u.role === 'admin'));
      setIntegrations(integ.integrations);
      setGroups(groupsRes.groups);
      setRiskTiers(tiersRes.tiers);
    });
  }, []);

  useEffect(() => {
    if (!isNew) {
      setLoading(true);
      setLoadError('');
      api.get(`/automations/${id}`).then(({ automation }) => {
        setName(automation.name);
        setDescription(automation.description || '');
        setEnabled(!!automation.enabled);
        setTestMode(!!automation.test_mode);
        setNodes(automation.nodes?.length ? automation.nodes : newTriggerScaffold().nodes);
        setEdges(automation.edges || []);
        setLoading(false);
      }).catch((e) => {
        // Without this catch, a failed fetch left `loading` stuck true
        // forever -- the whole workflow editor permanently stuck on
        // "Loading workflow…" with no error and no way out.
        setLoadError(e.message);
        setLoading(false);
      });
      return;
    }
    const draft = location.state?.draft;
    if (draft) {
      setFromSona(true);
      setName(draft.name || '');
      setDescription(draft.description || '');
      const graph = legacyToGraph(draft.trigger, draft.conditions, draft.actions);
      setNodes(autoLayout(graph.nodes, graph.edges));
      setEdges(graph.edges);
    } else {
      const scaffold = newTriggerScaffold();
      setNodes(scaffold.nodes);
      setEdges(scaffold.edges);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const validation = useMemo(() => validateGraph(nodes, edges), [nodes, edges]);
  const nodeMessages = useMemo(() => {
    const map = {};
    for (const e of validation.errors) if (e.nodeId) (map[e.nodeId] ||= []).push(e.message);
    for (const w of validation.warnings) if (w.nodeId) (map[w.nodeId] ||= []).push(w.message);
    return map;
  }, [validation]);

  const displayNodes = useMemo(() => nodes.map((n) => ({
    ...n,
    deletable: n.type !== 'trigger',
    data: {
      ...n.data,
      errors: nodeMessages[n.id],
      highlighted: highlight?.nodeIds?.has(n.id),
      gated: highlight?.gatedIds?.has(n.id),
      riskTier: n.type === 'action' ? riskTiers[n.data.type]?.tier : undefined,
      agentName: n.type === 'action' && (n.data.type === 'assign_agent' || n.data.type === 'create_task')
        ? agents.find((a) => a.id === (n.data.type === 'create_task' ? n.data.assignee_id : n.data.agent_id))?.name
        : undefined,
    },
  })), [nodes, nodeMessages, highlight, riskTiers, agents]);

  const displayEdges = useMemo(() => edges.map((e) => (
    highlight?.edgeIds?.has(e.id) ? { ...e, animated: true, style: { stroke: '#10b981', strokeWidth: 2.5 } } : e
  )), [edges, highlight]);

  const selectedDisplayNode = displayNodes.find((n) => n.id === selectedNodeId) || null;

  const onConnect = useCallback((connection) => {
    commit(() => setEdges((eds) => addEdge(connection, eds)));
  }, [commit, setEdges]);

  const onNodesDelete = useCallback(() => {
    past.current = [...past.current.slice(-24), { nodes, edges }];
    future.current = [];
  }, [nodes, edges]);

  const selectNode = useCallback((nodeId) => {
    setSelectedNodeId(nodeId);
    fieldEditDirty.current = false;
  }, []);

  // When nothing is selected, stagger unattached new nodes sideways instead
  // of always dropping them at the same spot — otherwise repeated clicks
  // pile nodes exactly on top of each other until Auto-arrange is used.
  const unattachedPosition = useCallback(() => {
    const base = nodes.find((n) => n.id === selectedNodeId);
    if (base) return { x: base.position.x, y: base.position.y + 160 };
    const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
    const stackedAtTop = nodes.filter((n) => Math.abs(n.position.y - maxY) < 8).length;
    return { x: 250 + stackedAtTop * 260, y: maxY + 160 };
  }, [nodes, selectedNodeId]);

  const addConditionNode = useCallback(() => {
    const node = newNode('condition', unattachedPosition(), { match: 'all', rules: [] });
    commit(() => setNodes((nds) => nds.concat(node)));
    selectNode(node.id);
  }, [unattachedPosition, commit, setNodes, selectNode]);

  const addActionNode = useCallback((actionType) => {
    const node = newNode('action', unattachedPosition(), { type: actionType });
    commit(() => setNodes((nds) => nds.concat(node)));
    selectNode(node.id);
  }, [unattachedPosition, commit, setNodes, selectNode]);

  const addApprovalNode = useCallback(() => {
    const node = newNode('approval', unattachedPosition(), { approver_type: 'role', approver_role: 'admin', title: '' });
    commit(() => setNodes((nds) => nds.concat(node)));
    selectNode(node.id);
  }, [unattachedPosition, commit, setNodes, selectNode]);

  const { fitView } = useReactFlow();
  const handleAutoArrange = useCallback(() => {
    commit(() => setNodes((nds) => autoLayout(nds, edges)));
    requestAnimationFrame(() => fitView({ duration: 300, padding: 0.2 }));
  }, [commit, setNodes, edges, fitView]);

  const updateSelectedNodeData = useCallback((nodeId, patch, replace) => {
    if (!fieldEditDirty.current) {
      past.current = [...past.current.slice(-24), { nodes, edges }];
      future.current = [];
      fieldEditDirty.current = true;
      setHistoryTick((t) => t + 1);
    }
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: replace ? { ...patch } : { ...n.data, ...patch } } : n)));
  }, [nodes, edges, setNodes]);

  const deleteNode = useCallback((nodeId) => {
    commit(() => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    });
    selectNode(null);
  }, [commit, setNodes, setEdges, selectNode]);

  const setMode = async (patch) => {
    setEnabled(patch.enabled);
    setTestMode(patch.test_mode);
    if (!isNew) {
      try { await api.patch(`/automations/${id}`, patch); } catch (e) { setSaveError(e.message); }
    }
  };

  const save = async () => {
    const v = validateGraph(nodes, edges);
    if (!v.valid) {
      setSaveError('Fix the highlighted issues before saving.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const payload = { name: name.trim() || 'Untitled workflow', description, nodes, edges, enabled };
      if (isNew) {
        const { id: newId } = await api.post('/automations', payload);
        navigate(`/automations/${newId}`, { replace: true });
      } else {
        await api.patch(`/automations/${id}`, payload);
      }
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  usePageTitle(name ? `${name} · Workflow` : isNew ? 'New workflow' : null);

  if (loadError) {
    return (
      <div className="h-64 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        <button onClick={() => navigate('/admin-settings', { state: { section: 'workflows' } })} className="btn-secondary text-xs">Back to workflows</button>
      </div>
    );
  }
  if (loading) {
    return <div className="h-64 flex items-center justify-center text-slate-400 text-sm"><Loader2 size={18} className="animate-spin mr-2" /> Loading workflow…</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/admin-settings', { state: { section: 'workflows' } })}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1.5 transition-colors shrink-0"
          title="Back to Workflows"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <input
            className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100 bg-transparent border-none outline-none w-full focus:ring-0 px-0"
            value={name}
            placeholder="Untitled workflow"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="text-xs text-slate-500 dark:text-slate-400 bg-transparent border-none outline-none w-full focus:ring-0 px-0"
            value={description}
            placeholder="What does this workflow do?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <ModeControl wf={{ enabled, test_mode: testMode }} onChange={setMode} />
        <button onClick={save} disabled={saving} className="btn-primary text-xs shrink-0">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
      </div>

      {fromSona && (
        <div className="text-sm text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-500/10 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <Bot size={14} className="shrink-0" /> Sona's draft — check everything below before saving.
        </div>
      )}
      {saveError && (
        <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <AlertTriangle size={14} className="shrink-0" /> {saveError}
        </div>
      )}
      {!validation.valid && (
        <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 space-y-0.5">
          {validation.errors.slice(0, 5).map((e, i) => <div key={i}>{e.message}</div>)}
        </div>
      )}

      <Toolbar
        onAddCondition={addConditionNode}
        onAddApproval={addApprovalNode}
        onAddAction={addActionNode}
        onAutoArrange={handleAutoArrange}
        onUndo={undo}
        onRedo={redo}
        canUndo={past.current.length > 0}
        canRedo={future.current.length > 0}
      />

      <div className="flex gap-3 h-[65vh]">
        <div className="flex-1 min-w-0 rounded-2xl border border-slate-200 dark:border-white/[0.08] overflow-hidden">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodesDelete={onNodesDelete}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            onNodeClick={(_, n) => selectNode(n.id)}
            onPaneClick={() => selectNode(null)}
            snapToGrid
            snapGrid={[16, 16]}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            minZoom={0.2}
            maxZoom={1.5}
            connectionRadius={40}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls />
            <MiniMap pannable zoomable className="!bg-white dark:!bg-slate-900" />
          </ReactFlow>
        </div>

        {selectedDisplayNode && (
          <Inspector
            node={selectedDisplayNode}
            onChange={updateSelectedNodeData}
            onDelete={deleteNode}
            onClose={() => selectNode(null)}
            agents={agents}
            integrations={integrations}
            groups={groups}
            riskTiers={riskTiers}
          />
        )}
      </div>

      {!isNew && <ActivityPanel automationId={id} onHighlight={(r) => setHighlight(r ? { nodeIds: new Set(r.visitedNodeIds), edgeIds: new Set(r.visitedEdgeIds), gatedIds: new Set(r.gatedNodeIds) } : null)} />}
    </div>
  );
}

export default function WorkflowBuilder() {
  return (
    <ReactFlowProvider>
      <BuilderInner />
    </ReactFlowProvider>
  );
}
