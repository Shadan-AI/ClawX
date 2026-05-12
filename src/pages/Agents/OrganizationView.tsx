import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dagre from 'dagre';
import { Building2, Edit2, MessageCircle, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useModelsStore } from '@/stores/models';
import { useOrganizationStore } from '@/stores/organization';
import type { ParentType } from '@/types/organization';

type OrgNodeKind = 'dept' | 'bot';

type OrgNodeRef = {
  id: string;
  type: OrgNodeKind;
};

type DepartmentDialogState =
  | { mode: 'create'; parentId: string | null; parentType?: ParentType; value: string }
  | { mode: 'rename'; deptId: string; value: string };

type ConfirmDialogState = {
  title: string;
  message: string;
  onConfirm: () => void;
};

type LayoutNode = {
  key: string;
  id: string;
  type: OrgNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
};

type LayoutEdge = {
  id: string;
  from: string;
  to: string;
};

const DEPT_NODE_SIZE = { width: 238, height: 116 };
const BOT_NODE_SIZE = { width: 190, height: 112 };
const DEPT_COLORS = ['#4f7cff', '#14a37f', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#dc2626', '#4d7c0f'];

function nodeKey(type: OrgNodeKind, id: string): string {
  return `${type}:${id}`;
}

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getDepartmentColor(id: string): string {
  return DEPT_COLORS[hashCode(id) % DEPT_COLORS.length];
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClassName = {
    neutral: 'bg-black/[0.05] text-foreground/75 dark:bg-white/[0.08]',
    success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    danger: 'bg-red-500/12 text-red-700 dark:text-red-300',
  }[tone];

  return (
    <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', toneClassName)}>
      {label}
    </span>
  );
}

function getStatusMeta(
  status: 'idle' | 'syncing' | 'saved' | 'error' | 'conflict',
  hasLocalChanges: boolean,
  isSaving: boolean,
) {
  if (isSaving || status === 'syncing') {
    return { label: '保存中', tone: 'warning' as const };
  }
  if (status === 'error') {
    return { label: '保存失败', tone: 'danger' as const };
  }
  if (status === 'conflict') {
    return { label: '存在冲突', tone: 'danger' as const };
  }
  if (hasLocalChanges) {
    return { label: '等待自动保存', tone: 'warning' as const };
  }
  if (status === 'saved') {
    return { label: '已同步', tone: 'success' as const };
  }
  return { label: '可编辑', tone: 'neutral' as const };
}

function formatSyncTime(lastSyncTime: number): string {
  if (!lastSyncTime) return '尚未同步';
  const date = new Date(lastSyncTime);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function buildGraphPath(source: LayoutNode, target: LayoutNode): string {
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height;
  const endX = target.x + target.width / 2;
  const endY = target.y;
  const controlY = startY + (endY - startY) / 2;
  return `M ${startX} ${startY} V ${controlY} H ${endX} V ${endY}`;
}

function countDepartmentPeople(
  deptId: string,
  departmentChildrenByDeptId: Map<string, string[]>,
  botChildrenByParentId: Map<string, string[]>,
): number {
  const countedBots = new Set<string>();

  const visitBot = (botId: string) => {
    if (countedBots.has(botId)) return;
    countedBots.add(botId);
  };

  const visitDept = (currentDeptId: string) => {
    for (const childDeptId of departmentChildrenByDeptId.get(currentDeptId) ?? []) {
      visitDept(childDeptId);
    }
    for (const childBotId of botChildrenByParentId.get(currentDeptId) ?? []) {
      visitBot(childBotId);
    }
  };

  visitDept(deptId);
  return countedBots.size;
}

export function OrganizationView() {
  const navigate = useNavigate();
  const { agents, fetchAgents } = useAgentsStore();
  const digitalEmployees = useModelsStore((state) => state.digitalEmployees);
  const {
    departments,
    assignments,
    addDepartment,
    updateDepartment,
    deleteDepartment,
    moveDepartment,
    assignAgent,
    unassignAgent,
    loadFromServer,
    startSync,
    stopSync,
    startAutoSave,
    stopAutoSave,
    syncStatus,
    lastSyncTime,
    hasLocalChanges,
    isLoading,
    isSaving,
    lastSyncError,
  } = useOrganizationStore();

  const [selectedNode, setSelectedNode] = useState<OrgNodeRef | null>(null);
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<OrgNodeRef | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const panStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    void loadFromServer();
    startSync();
    startAutoSave();
    return () => {
      stopSync();
      stopAutoSave();
    };
  }, [loadFromServer, startAutoSave, startSync, stopAutoSave, stopSync]);

  const employeeByAgentId = useMemo(
    () => Object.fromEntries((digitalEmployees ?? []).map((employee) => [employee.openclawAgentId, employee])),
    [digitalEmployees],
  );
  const agentById = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const departmentById = useMemo(
    () => Object.fromEntries(departments.map((dept) => [dept.id, dept])),
    [departments],
  );
  const employeeAvatarIndexByAgentId = useMemo(
    () =>
      Object.fromEntries(
        [...(digitalEmployees ?? [])]
          .sort((left, right) =>
            (left.openclawAgentId || left.nickName || '').localeCompare(
              right.openclawAgentId || right.nickName || '',
            ),
          )
          .map((employee, index) => [employee.openclawAgentId, index]),
      ) as Record<string, number>,
    [digitalEmployees],
  );

  const departmentIds = useMemo(() => new Set(departments.map((dept) => dept.id)), [departments]);

  const departmentChildrenByDeptId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const dept of departments) {
      if (!dept.parentId) continue;
      const list = map.get(dept.parentId) ?? [];
      list.push(dept.id);
      map.set(dept.parentId, list);
    }
    return map;
  }, [departments]);

  const botChildrenByParentId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [botId, parentId] of Object.entries(assignments)) {
      if (!parentId) continue;
      const list = map.get(parentId) ?? [];
      list.push(botId);
      map.set(parentId, list);
    }
    return map;
  }, [assignments]);

  const unassignedAgents = useMemo(
    () =>
      agents.filter((agent) => {
        const parentId = assignments[agent.id];
        if (!parentId) return true;
        return !departmentIds.has(parentId);
      }),
    [agents, assignments, departmentIds],
  );

  const getAgentName = useCallback(
    (agentId: string) => employeeByAgentId[agentId]?.nickName || agentById[agentId]?.name || agentId,
    [agentById, employeeByAgentId],
  );

  const getAgentAvatarIndex = useCallback(
    (agentId: string) => employeeAvatarIndexByAgentId[agentId] ?? 0,
    [employeeAvatarIndexByAgentId],
  );

  const getDepartmentPeopleCount = useCallback(
    (deptId: string) =>
      countDepartmentPeople(
        deptId,
        departmentChildrenByDeptId,
        botChildrenByParentId,
      ),
    [botChildrenByParentId, departmentChildrenByDeptId],
  );

  const openCreateDepartment = useCallback((parentId: string | null, parentType?: ParentType) => {
    setDepartmentDialog({ mode: 'create', parentId, parentType, value: '' });
  }, []);

  const openRenameDepartment = useCallback(
    (deptId: string) => {
      const dept = departmentById[deptId];
      if (!dept) return;
      setDepartmentDialog({ mode: 'rename', deptId, value: dept.name });
    },
    [departmentById],
  );

  const submitDepartmentDialog = useCallback(() => {
    if (!departmentDialog) return;
    const value = departmentDialog.value.trim();
    if (!value) {
      toast.error('请输入部门名称');
      return;
    }
    if (departmentDialog.mode === 'create') {
      addDepartment(value, departmentDialog.parentId, departmentDialog.parentType ?? 'dept');
      toast.success('部门已创建');
    } else {
      updateDepartment(departmentDialog.deptId, value);
      toast.success('部门名称已更新');
    }
    setDepartmentDialog(null);
  }, [addDepartment, departmentDialog, updateDepartment]);

  const confirmDeleteDepartment = useCallback(
    (deptId: string) => {
      const dept = departmentById[deptId];
      if (!dept) return;
      setConfirmDialog({
        title: '删除部门',
        message: `确定删除“${dept.name}”及其下属层级吗？这会同时移除这条分支上的员工归属关系。`,
        onConfirm: () => {
          deleteDepartment(deptId);
          setConfirmDialog(null);
          if (selectedNode?.type === 'dept' && selectedNode.id === deptId) {
            setSelectedNode(null);
          }
          toast.success('部门已删除');
        },
      });
    },
    [deleteDepartment, departmentById, selectedNode],
  );

  const handleChatWithAgent = useCallback(
    (agentId: string) => {
      navigate('/', { state: { createNewSessionFor: agentId } });
    },
    [navigate],
  );

  const beginAgentDrag = useCallback((agentId: string) => {
    setDraggingAgentId(agentId);
  }, []);

  const endAgentDrag = useCallback(() => {
    setDraggingAgentId(null);
    setDropTarget(null);
  }, []);

  const handleDropOnTarget = useCallback(
    (targetId: string) => {
      if (!draggingAgentId) return;
      assignAgent(draggingAgentId, targetId, 'dept');
      setDraggingAgentId(null);
      setDropTarget(null);
    },
    [assignAgent, draggingAgentId],
  );

  const handlePromoteDepartment = useCallback(
    (deptId: string) => {
      moveDepartment(deptId, null);
      toast.success('部门已移动到顶层');
    },
    [moveDepartment],
  );

  const graphLayout = useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: 'TB',
      nodesep: 16,
      ranksep: 24,
      marginx: 28,
      marginy: 28,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    const nodeMap = new Map<string, LayoutNode>();
    const edges: LayoutEdge[] = [];

    for (const dept of departments) {
      const key = nodeKey('dept', dept.id);
      graph.setNode(key, { ...DEPT_NODE_SIZE });
      nodeMap.set(key, {
        key,
        id: dept.id,
        type: 'dept',
        x: 0,
        y: 0,
        width: DEPT_NODE_SIZE.width,
        height: DEPT_NODE_SIZE.height,
      });
    }

    for (const agent of agents) {
      if (!assignments[agent.id]) continue;
      const key = nodeKey('bot', agent.id);
      graph.setNode(key, { ...BOT_NODE_SIZE });
      nodeMap.set(key, {
        key,
        id: agent.id,
        type: 'bot',
        x: 0,
        y: 0,
        width: BOT_NODE_SIZE.width,
        height: BOT_NODE_SIZE.height,
      });
    }

    for (const dept of departments) {
      if (!dept.parentId || !departmentIds.has(dept.parentId)) continue;
      const fromKey = nodeKey('dept', dept.parentId);
      const toKey = nodeKey('dept', dept.id);
      if (!nodeMap.has(fromKey) || !nodeMap.has(toKey)) continue;
      graph.setEdge(fromKey, toKey);
      edges.push({ id: `${fromKey}->${toKey}`, from: fromKey, to: toKey });
    }

    for (const [botId, parentId] of Object.entries(assignments)) {
      if (!departmentIds.has(parentId)) continue;
      const fromKey = nodeKey('dept', parentId);
      const toKey = nodeKey('bot', botId);
      if (!nodeMap.has(fromKey) || !nodeMap.has(toKey)) continue;
      graph.setEdge(fromKey, toKey);
      edges.push({ id: `${fromKey}->${toKey}`, from: fromKey, to: toKey });
    }

    dagre.layout(graph);

    let maxX = 0;
    let maxY = 0;
    const nodes = Array.from(nodeMap.values()).map((node) => {
      const layoutNode = graph.node(node.key);
      const x = (layoutNode?.x ?? 0) - node.width / 2;
      const y = (layoutNode?.y ?? 0) - node.height / 2;
      maxX = Math.max(maxX, x + node.width);
      maxY = Math.max(maxY, y + node.height);
      return { ...node, x, y };
    });

    return {
      nodes,
      edges,
      width: Math.max(maxX + 120, 1100),
      height: Math.max(maxY + 120, 640),
      nodeMap: new Map(nodes.map((node) => [node.key, node])),
    };
  }, [agents, assignments, departmentIds, departments]);

  const statusMeta = getStatusMeta(syncStatus, hasLocalChanges, isSaving);
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[248px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col rounded-2xl border border-black/5 bg-white p-3 shadow-sm dark:border-white/8 dark:bg-[#181b20]">
        <div className="rounded-2xl border border-black/5 bg-[#fbfaf7] p-3 shadow-sm dark:border-white/8 dark:bg-white/[0.04]">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
              <Building2 className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold text-foreground">组织架构图</h2>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">自动保存，同步到 ai-im</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <StatusPill label={statusMeta.label} tone={statusMeta.tone} />
            <StatusPill label={`部门 ${departments.length}`} tone="neutral" />
            <StatusPill label={`员工 ${agents.length}`} tone="neutral" />
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">最近同步：{formatSyncTime(lastSyncTime)}</div>
        </div>

        {lastSyncError && (
          <div className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
            {lastSyncError}
          </div>
        )}

        <div className="mt-3">
          <Button
            variant="outline"
            onClick={() => void loadFromServer()}
            disabled={isLoading}
            className="h-9 w-full rounded-xl px-2 text-[12px]"
          >
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', isLoading && 'animate-spin')} />
            刷新
          </Button>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-foreground">未归属员工</h3>
              <p className="text-[11px] text-muted-foreground">拖到部门上分配</p>
            </div>
          </div>
          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[11px] text-foreground/70 dark:bg-white/[0.06]">
            {unassignedAgents.length}
          </span>
        </div>

        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {unassignedAgents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 px-4 py-8 text-center text-[13px] text-muted-foreground dark:border-white/10">
                当前没有未归属员工
              </div>
            ) : (
              unassignedAgents.map((agent) => {
                const employee = employeeByAgentId[agent.id];
                return (
                  <div
                    key={agent.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      beginAgentDrag(agent.id);
                    }}
                    onDragEnd={endAgentDrag}
                    className={cn(
                      'group rounded-xl border bg-[#f8f6f0] p-3 shadow-sm transition-all dark:bg-white/[0.04]',
                      'hover:border-primary/40 hover:bg-[#f3f1e9] hover:shadow-md dark:hover:bg-white/[0.06]',
                      draggingAgentId === agent.id && 'opacity-60',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <AgentAvatar
                        name={getAgentName(agent.id)}
                        imageUrl={employee?.headImage}
                        seed={agent.id}
                        avatarIndex={getAgentAvatarIndex(agent.id)}
                        className="h-10 w-10 shrink-0"
                        iconClassName="h-[28px] w-[28px]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-foreground">{getAgentName(agent.id)}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{agent.id}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleChatWithAgent(agent.id)}
                        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                        title="开始对话"
                      >
                        <MessageCircle className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="relative min-h-0 overflow-hidden rounded-2xl border border-black/5 bg-[#f8f6f0] shadow-sm dark:border-white/8 dark:bg-[#11151b]">
          <div
            ref={canvasScrollRef}
            className="h-full min-h-[640px] cursor-grab overflow-auto active:cursor-grabbing"
            onMouseDown={(event) => {
              if (draggingAgentId || event.button !== 0) return;
              const target = event.target as HTMLElement;
              if (target.closest('button, input, select, [draggable="true"]')) return;
              const canvas = canvasScrollRef.current;
              if (!canvas) return;
              panStateRef.current = {
                active: true,
                startX: event.clientX,
                startY: event.clientY,
                scrollLeft: canvas.scrollLeft,
                scrollTop: canvas.scrollTop,
              };
            }}
            onMouseMove={(event) => {
              const panState = panStateRef.current;
              const canvas = canvasScrollRef.current;
              if (!panState.active || !canvas) return;
              event.preventDefault();
              canvas.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
              canvas.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
            }}
            onMouseUp={() => {
              panStateRef.current.active = false;
            }}
            onMouseLeave={() => {
              panStateRef.current.active = false;
            }}
            style={{
              backgroundImage:
                'linear-gradient(rgba(15,23,42,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.045) 1px, transparent 1px)',
              backgroundSize: '28px 28px',
            }}
          >
            {graphLayout.nodes.length === 0 ? (
              <div className="flex h-[520px] items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-blue-500/10 to-cyan-500/10 text-blue-500">
                    <Building2 className="h-8 w-8" />
                  </div>
                  <div className="text-[16px] font-semibold text-foreground">还没有组织架构图</div>
                  <div className="mt-2 text-[13px] text-muted-foreground">
                    先创建一个顶层部门，再把左侧员工拖进来即可。
                  </div>
                  <Button
                    onClick={() => openCreateDepartment(null)}
                    className="mt-5 h-10 rounded-xl px-4 text-[13px]"
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    创建顶层部门
                  </Button>
                </div>
              </div>
            ) : (
              <div
                className="relative min-w-full"
                style={{ width: Math.max(graphLayout.width, 920), height: graphLayout.height }}
              >
                <svg className="absolute inset-0 h-full w-full">
                  {graphLayout.edges.map((edge) => {
                    const source = graphLayout.nodeMap.get(edge.from);
                    const target = graphLayout.nodeMap.get(edge.to);
                    if (!source || !target) return null;
                    return (
                      <path
                        key={edge.id}
                        d={buildGraphPath(source, target)}
                        fill="none"
                        stroke="rgba(100, 116, 139, 0.78)"
                        strokeWidth={2}
                        strokeLinecap="round"
                      />
                    );
                  })}
                </svg>

                {graphLayout.nodes.map((node) => {
                  if (node.type === 'dept') {
                    const dept = departmentById[node.id];
                    if (!dept) return null;
                    const deptColor = getDepartmentColor(dept.id);
                    const peopleCount = getDepartmentPeopleCount(dept.id);
                    const isDropTarget = dropTarget?.type === 'dept' && dropTarget.id === dept.id;
                    const isSelected = selectedNode?.type === 'dept' && selectedNode.id === dept.id;

                    return (
                      <div
                        key={node.key}
                        onClick={() => setSelectedNode({ id: dept.id, type: 'dept' })}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (draggingAgentId) {
                            setDropTarget({ id: dept.id, type: 'dept' });
                          }
                        }}
                        onDragLeave={() => {
                          if (dropTarget?.type === 'dept' && dropTarget.id === dept.id) {
                            setDropTarget(null);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handleDropOnTarget(dept.id);
                        }}
                        className={cn(
                          'absolute rounded-2xl border p-4 text-white shadow-[0_10px_24px_rgba(15,23,42,0.14)] transition-all',
                          isSelected && 'ring-4 ring-white/60',
                          isDropTarget && 'scale-[1.04] ring-4 ring-blue-300/60',
                        )}
                        style={{
                          left: node.x,
                          top: node.y,
                          width: node.width,
                          height: node.height,
                          background: `linear-gradient(135deg, ${deptColor}, ${deptColor}dd)`,
                          borderColor: deptColor,
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/18 text-white shadow-sm">
                            <Building2 className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[15px] font-semibold text-white">{dept.name}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-white/18 px-2.5 py-1 text-[11px] font-medium text-white/90">
                                {peopleCount} 名员工
                              </span>
                              {dept.parentId && (
                                <span className="rounded-full bg-white/18 px-2.5 py-1 text-[11px] font-medium text-white/90">
                                  子部门
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCreateDepartment(dept.id, 'dept');
                            }}
                            className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                            title="添加子部门"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openRenameDepartment(dept.id);
                            }}
                            className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                            title="重命名"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          {dept.parentId && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handlePromoteDepartment(dept.id);
                              }}
                              className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                              title="提升到顶层"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              confirmDeleteDepartment(dept.id);
                            }}
                            className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                            title="删除部门"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        {isDropTarget && (
                          <div className="absolute -bottom-9 left-3 right-3 rounded-xl bg-slate-950/80 px-3 py-2 text-center text-[11px] text-white shadow-lg backdrop-blur">
                            松开鼠标后，这名员工会被分配到这个部门
                          </div>
                        )}
                      </div>
                    );
                  }

                  const employee = employeeByAgentId[node.id];
                  const isSelected = selectedNode?.type === 'bot' && selectedNode.id === node.id;

                  return (
                    <div
                      key={node.key}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        beginAgentDrag(node.id);
                      }}
                      onDragEnd={endAgentDrag}
                      onClick={() => setSelectedNode({ id: node.id, type: 'bot' })}
                      className={cn(
                        'absolute rounded-2xl border bg-[#f3f1e9] p-3 shadow-[0_8px_20px_rgba(15,23,42,0.12)] transition-all dark:bg-[#1d2027]',
                        isSelected && 'border-primary/60 ring-2 ring-primary/15',
                        draggingAgentId === node.id && 'opacity-70',
                      )}
                      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                    >
                      <div className="flex items-center gap-3">
                        <AgentAvatar
                          name={getAgentName(node.id)}
                          imageUrl={employee?.headImage}
                          seed={node.id}
                          avatarIndex={getAgentAvatarIndex(node.id)}
                          className="h-11 w-11 shrink-0"
                          iconClassName="h-[30px] w-[30px]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-semibold text-foreground">{getAgentName(node.id)}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{node.id}</div>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleChatWithAgent(node.id);
                          }}
                          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                          title="开始对话"
                        >
                          <MessageCircle className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            unassignAgent(node.id);
                            toast.success('员工归属已移除');
                          }}
                          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title="移除归属"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="absolute bottom-4 right-4 z-20 rounded-2xl border border-black/10 bg-white/88 px-4 py-2.5 text-[12px] text-muted-foreground shadow-lg backdrop-blur dark:border-white/10 dark:bg-[#181b20]/88">
            拖拽员工到节点上分配，横向或纵向滚动画布查看完整结构
          </div>
        </div>

      {departmentDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => setDepartmentDialog(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl dark:bg-[#181b20]"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-[20px] font-semibold tracking-tight text-foreground">
              {departmentDialog.mode === 'create' ? '新增部门' : '重命名部门'}
            </h3>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {departmentDialog.mode === 'create'
                ? departmentDialog.parentId
                  ? '这个部门会创建在当前部门下面，并自动保存到组织架构。'
                  : '创建第一个顶层部门后，就可以在部门卡片上继续添加子部门。'
                : '修改名称后会自动保存，并同步到组织架构图。'}
            </p>
            <Input
              autoFocus
              value={departmentDialog.value}
              onChange={(event) => setDepartmentDialog({ ...departmentDialog, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitDepartmentDialog();
                }
              }}
              className={cn('h-11 rounded-xl text-[13px]', departmentDialog.mode === 'create' ? 'mt-3' : 'mt-4')}
              placeholder="请输入部门名称"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" className="h-10 rounded-xl px-4 text-[13px]" onClick={() => setDepartmentDialog(null)}>
                取消
              </Button>
              <Button className="h-10 rounded-xl px-4 text-[13px]" onClick={submitDepartmentDialog}>
                确认
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl dark:bg-[#181b20]"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-[20px] font-semibold tracking-tight text-foreground">{confirmDialog.title}</h3>
            <p className="mt-3 text-[13px] leading-6 text-muted-foreground">{confirmDialog.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" className="h-10 rounded-xl px-4 text-[13px]" onClick={() => setConfirmDialog(null)}>
                取消
              </Button>
              <Button
                className="h-10 rounded-xl bg-red-600 px-4 text-[13px] hover:bg-red-700"
                onClick={confirmDialog.onConfirm}
              >
                确认删除
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
