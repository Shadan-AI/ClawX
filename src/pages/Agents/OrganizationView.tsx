import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/x6';
import dagre from 'dagre';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, Plus, Trash2, Edit2, Users, Bot, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOrganizationStore } from '@/stores/organization';
import { useAgentsStore } from '@/stores/agents';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const COLORS = ['#5F95FF', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#14b8a6', '#e11d48', '#eab308'];
const EMOJIS = ['🤖', '🧠', '⚡', '🔧', '📊', '💬', '🎯', '🛡️', '📝', '🔍', '🚀', '🎨'];

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getEmoji(id: string): string {
  return EMOJIS[hashCode(id) % EMOJIS.length];
}

function getColor(id: string): string {
  return COLORS[hashCode(id) % COLORS.length];
}

/**
 * Organization View
 * 组织架构视图 - 可视化部门层级和员工分配
 */
export function OrganizationView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [newDeptName, setNewDeptName] = useState('');
  const [editingDept, setEditingDept] = useState<{ id: string; name: string } | null>(null);
  const [draggingBot, setDraggingBot] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; deptId: string } | null>(null);
  const [botContextMenu, setBotContextMenu] = useState<{ x: number; y: number; botId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ 
    title: string; 
    message: string; 
    onConfirm: () => void;
  } | null>(null);
  
  const { departments, assignments, addDepartment, updateDepartment, deleteDepartment, assignAgent, unassignAgent } = useOrganizationStore();
  const { agents } = useAgentsStore();
  
  // 获取未分配的员工
  const unassignedAgents = useMemo(
    () => agents.filter((agent) => !assignments[agent.id]),
    [agents, assignments]
  );

  // 注册自定义节点
  useEffect(() => {
    // 部门节点 - 更大更醒目
    Graph.registerNode('dept-node', {
      width: 240,
      height: 80,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'text', selector: 'label' },
        { tagName: 'text', selector: 'count' },
      ],
      attrs: {
        body: {
          refWidth: '100%',
          refHeight: '100%',
          rx: 16,
          ry: 16,
          fill: '#5F95FF',
          stroke: 'rgba(255,255,255,0.3)',
          strokeWidth: 2,
          filter: {
            name: 'dropShadow',
            args: {
              dx: 0,
              dy: 8,
              blur: 20,
              color: 'rgba(95, 149, 255, 0.3)',
            },
          },
        },
        label: {
          refX: 0.5,
          refY: 0.4,
          fill: '#fff',
          fontSize: 16,
          fontWeight: 700,
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
        },
        count: {
          refX: 0.5,
          refY: 0.7,
          fill: 'rgba(255,255,255,0.85)',
          fontSize: 13,
          fontWeight: 500,
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
        },
      },
    }, true);

    // 员工节点 - 更精致
    Graph.registerNode('bot-node', {
      width: 180,
      height: 90,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'circle', selector: 'avatar' },
        { tagName: 'text', selector: 'emoji' },
        { tagName: 'text', selector: 'name' },
        { tagName: 'text', selector: 'sub' },
      ],
      attrs: {
        body: {
          refWidth: '100%',
          refHeight: '100%',
          rx: 14,
          ry: 14,
          fill: '#ffffff',
          stroke: '#e5e7eb',
          strokeWidth: 2,
          cursor: 'move',
          filter: {
            name: 'dropShadow',
            args: {
              dx: 0,
              dy: 4,
              blur: 12,
              color: 'rgba(0,0,0,0.1)',
            },
          },
        },
        avatar: {
          cx: 30,
          cy: 45,
          r: 18,
          fill: '#f3f4f6',
          stroke: '#5F95FF',
          strokeWidth: 2.5,
        },
        emoji: {
          x: 30,
          y: 45,
          fontSize: 20,
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
          pointerEvents: 'none',
        },
        name: {
          x: 58,
          y: 36,
          fill: '#1a1a2e',
          fontSize: 14,
          fontWeight: 600,
          pointerEvents: 'none',
        },
        sub: {
          x: 58,
          y: 56,
          fill: '#9ca3af',
          fontSize: 12,
          pointerEvents: 'none',
        },
      },
    }, true);

    // 边 - 更柔和
    Graph.registerEdge('org-edge', {
      zIndex: -1,
      attrs: {
        line: {
          strokeWidth: 2.5,
          stroke: '#cbd5e1',
          sourceMarker: null,
          targetMarker: null,
          strokeLinecap: 'round',
        },
      },
    }, true);
  }, []);
  
  // 初始化图形
  useEffect(() => {
    if (!containerRef.current) return;
    
    const graph = new Graph({
      container: containerRef.current,
      autoResize: true,
      panning: true,
      mousewheel: {
        enabled: true,
        modifiers: ['ctrl', 'meta'],
        minScale: 0.3,
        maxScale: 2,
      },
      background: {
        color: 'transparent',
      },
      grid: false,
      interacting: false,
    });
    
    graphRef.current = graph;
    
    // 监听节点点击事件
    graph.on('node:click', ({ node }) => {
      const data = node.getData();
      if (data?.type === 'dept') {
        setSelectedDept(data.id);
      }
    });
    
    // 监听员工节点拖动开始
    graph.on('node:mousedown', ({ node, e }) => {
      const data = node.getData();
      if (data?.type === 'bot') {
        setDraggingBot(data.id);
        // 创建一个拖动数据传输对象
        const dt = new DataTransfer();
        dt.setData('botId', data.id);
        // 触发拖动事件
        const dragEvent = new DragEvent('dragstart', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        });
        e.target.dispatchEvent(dragEvent);
      }
    });
    
    // 监听右键菜单
    graph.on('node:contextmenu', ({ node, e }) => {
      const data = node.getData();
      if (data?.type === 'dept') {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, deptId: data.id });
      } else if (data?.type === 'bot') {
        e.preventDefault();
        setBotContextMenu({ x: e.clientX, y: e.clientY, botId: data.id });
      }
    });
    
    // 监听画布点击事件（取消选择）
    graph.on('blank:click', () => {
      setSelectedDept(null);
    });
    
    return () => {
      graph.dispose();
    };
  }, []);

  // 关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
      setBotContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);
  
  // 渲染组织架构图
  const renderGraph = useCallback(() => {
    if (!graphRef.current) return;
    
    const graph = graphRef.current;
    graph.clearCells();
    
    if (departments.length === 0) return;
    
    const cells = [];
    
    // 创建部门节点
    departments.forEach((dept) => {
      const assignedCount = Object.values(assignments).filter((deptId) => deptId === dept.id).length;
      const color = getColor(dept.id);
      const isDropTarget = dropTarget === dept.id;
      
      cells.push(graph.createNode({
        id: `dept-${dept.id}`,
        shape: 'dept-node',
        attrs: {
          body: {
            fill: isDropTarget ? '#3b82f6' : color,
            stroke: isDropTarget ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255,255,255,0.3)',
            strokeWidth: isDropTarget ? 4 : 2,
          },
          label: {
            text: dept.name,
          },
          count: {
            text: `${assignedCount} 人`,
          },
        },
        data: { type: 'dept', id: dept.id },
      }));
    });
    
    // 创建员工节点
    agents.forEach((agent) => {
      const deptId = assignments[agent.id];
      if (!deptId) return;
      
      const color = getColor(agent.id);
      const emoji = getEmoji(agent.id);
      
      cells.push(graph.createNode({
        id: `bot-${agent.id}`,
        shape: 'bot-node',
        attrs: {
          avatar: {
            stroke: color,
          },
          emoji: {
            text: emoji,
          },
          name: {
            text: agent.name.length > 10 ? agent.name.slice(0, 10) + '…' : agent.name,
          },
          sub: {
            text: `ID: ${agent.id.slice(0, 8)}`,
          },
        },
        data: { type: 'bot', id: agent.id, deptId },
      }));
    });
    
    // 创建部门层级边
    departments.forEach((dept) => {
      if (!dept.parentId) return;
      cells.push(graph.createEdge({
        shape: 'org-edge',
        source: { cell: `dept-${dept.parentId}` },
        target: { cell: `dept-${dept.id}` },
      }));
    });
    
    // 创建员工到部门的边
    agents.forEach((agent) => {
      const deptId = assignments[agent.id];
      if (!deptId) return;
      cells.push(graph.createEdge({
        shape: 'org-edge',
        source: { cell: `dept-${deptId}` },
        target: { cell: `bot-${agent.id}` },
        attrs: {
          line: {
            stroke: '#d1d5db',
            strokeWidth: 1,
            strokeDasharray: '4 3',
          },
        },
      }));
    });
    
    graph.resetCells(cells);
    
    // 添加节点进入动画
    setTimeout(() => {
      cells.forEach((cell, index) => {
        setTimeout(() => {
          if (cell.isNode()) {
            const currentPos = cell.position();
            cell.position(currentPos.x, currentPos.y - 20, { silent: true });
            cell.attr('body/opacity', 0);
            cell.transition('position', currentPos, {
              duration: 400,
              timing: 'ease-out',
            });
            cell.transition('attrs/body/opacity', 1, {
              duration: 300,
              timing: 'ease-out',
            });
          }
        }, index * 30);
      });
    }, 0);
    
    // 布局
    const nodes = graph.getNodes();
    const edges = graph.getEdges();
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80 });
    g.setDefaultEdgeLabel(() => ({}));
    
    nodes.forEach((node) => {
      const size = node.getSize();
      g.setNode(node.id, { width: size.width, height: size.height });
    });
    
    edges.forEach((edge) => {
      const src = edge.getSource();
      const tgt = edge.getTarget();
      if (src.cell && tgt.cell) {
        g.setEdge(src.cell as string, tgt.cell as string);
      }
    });
    
    dagre.layout(g);
    
    // 批量更新节点位置
    graph.startBatch('update');
    g.nodes().forEach((id) => {
      const node = graph.getCellById(id);
      if (node) {
        const pos = g.node(id);
        node.position(pos.x - pos.width / 2, pos.y - pos.height / 2);
      }
    });
    graph.stopBatch('update');
    
    graph.zoomToFit({ padding: 60, maxScale: 1 });
  }, [departments, assignments, agents]);
  
  useEffect(() => {
    renderGraph();
  }, [renderGraph, dropTarget]);
  
  // 添加部门
  const handleAddDepartment = useCallback(() => {
    if (!newDeptName.trim()) return;
    addDepartment(newDeptName.trim(), selectedDept);
    setNewDeptName('');
    toast.success('部门已添加');
  }, [newDeptName, selectedDept, addDepartment]);
  
  // 删除部门
  const handleDeleteDepartment = useCallback((deptId: string) => {
    const dept = departments.find((d) => d.id === deptId);
    if (!dept) return;
    
    setConfirmDialog({
      title: '删除部门',
      message: `确定要删除"${dept.name}"吗？子部门和员工分配也会被清除。`,
      onConfirm: () => {
        deleteDepartment(deptId);
        if (selectedDept === deptId) {
          setSelectedDept(null);
        }
        toast.success('部门已删除');
        setConfirmDialog(null);
      },
    });
  }, [departments, deleteDepartment, selectedDept]);
  
  // 重命名部门
  const handleRenameDepartment = useCallback(() => {
    if (!editingDept || !editingDept.name.trim()) return;
    updateDepartment(editingDept.id, editingDept.name.trim());
    setEditingDept(null);
    toast.success('部门已重命名');
  }, [editingDept, updateDepartment]);
  
  // 取消分配员工
  const handleUnassignAgent = useCallback((botId: string) => {
    const agent = agents.find((a) => a.id === botId);
    if (!agent) return;
    
    unassignAgent(botId);
    toast.success('员工已移除');
  }, [agents, unassignAgent]);
  
  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, botId: string) => {
    e.dataTransfer.setData('botId', botId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingBot(botId);
    setDragPosition({ x: e.clientX, y: e.clientY });
  }, []);
  
  // 拖拽结束
  const handleDragEnd = useCallback(() => {
    setDraggingBot(null);
    setDragPosition(null);
    setDropTarget(null);
  }, []);
  
  // 拖拽到画布
  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!draggingBot || !graphRef.current) return;
    
    const graph = graphRef.current;
    const p = graph.clientToLocal(e.clientX, e.clientY);
    const deptNode = graph.getNodes().find((n) => {
      const data = n.getData();
      if (data?.type !== 'dept') return false;
      return n.getBBox().containsPoint(p);
    });
    
    if (deptNode) {
      const deptId = deptNode.getData().id;
      
      // 添加高亮效果
      setDropTarget(deptId);
      
      // 延迟执行分配，让动画播放
      setTimeout(() => {
        assignAgent(draggingBot, deptId);
        toast.success('员工已分配');
        setDropTarget(null);
      }, 200);
    }
    
    setDraggingBot(null);
  }, [draggingBot, assignAgent]);
  
  // 拖拽经过画布时高亮目标部门
  const handleCanvasDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragPosition({ x: e.clientX, y: e.clientY });
    
    if (!draggingBot || !graphRef.current) return;
    
    const graph = graphRef.current;
    const p = graph.clientToLocal(e.clientX, e.clientY);
    const deptNode = graph.getNodes().find((n) => {
      const data = n.getData();
      if (data?.type !== 'dept') return false;
      return n.getBBox().containsPoint(p);
    });
    
    if (deptNode) {
      const deptId = deptNode.getData().id;
      if (dropTarget !== deptId) {
        setDropTarget(deptId);
      }
    } else if (dropTarget) {
      setDropTarget(null);
    }
  }, [draggingBot, dropTarget]);

  return (
    <div className="flex h-full gap-6">
      {/* 左侧面板 */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="w-80 flex flex-col gap-6"
      >
        {/* 部门管理 */}
        <div className="rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="text-[15px] font-semibold text-foreground">组织架构</h3>
          </div>
          
          <div className="space-y-3">
            <Input
              value={newDeptName}
              onChange={(e) => setNewDeptName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddDepartment()}
              placeholder={selectedDept ? '添加子部门' : '添加根部门'}
              className="h-10 text-[13px] rounded-xl"
            />
            <Button
              onClick={handleAddDepartment}
              disabled={!newDeptName.trim()}
              className="w-full h-10 text-[13px] font-medium rounded-xl"
            >
              <Plus className="w-4 h-4 mr-2" />
              添加{selectedDept ? '子' : '根'}部门
            </Button>
          </div>
          
          <AnimatePresence>
            {selectedDept && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4 pt-4 border-t border-black/5 dark:border-white/5"
              >
                <div className="text-[13px] text-muted-foreground mb-3">
                  当前选中: {departments.find((d) => d.id === selectedDept)?.name}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const dept = departments.find((d) => d.id === selectedDept);
                      if (dept) setEditingDept({ id: dept.id, name: dept.name });
                    }}
                    className="flex-1 h-9 text-[13px] rounded-xl"
                  >
                    <Edit2 className="w-3.5 h-3.5 mr-1.5" />
                    重命名
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteDepartment(selectedDept)}
                    className="flex-1 h-9 text-[13px] rounded-xl text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    删除
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* 未分配员工 */}
        <div className="flex-1 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 p-5 overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-5 h-5 text-green-600 dark:text-green-400" />
            <h3 className="text-[15px] font-semibold text-foreground">
              员工列表
            </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto -mr-2 pr-2 space-y-3">
            {/* 未分配员工 */}
            {unassignedAgents.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  未分配 ({unassignedAgents.length})
                </div>
                <div className="space-y-2">
                  <AnimatePresence>
                    {unassignedAgents.map((agent) => (
                      <motion.div
                        key={agent.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        draggable
                        onDragStart={(e) => handleDragStart(e, agent.id)}
                        onDragEnd={handleDragEnd}
                        className={cn(
                          'p-3 rounded-xl border cursor-grab active:cursor-grabbing transition-all',
                          'bg-white dark:bg-gray-800 border-black/10 dark:border-white/10',
                          'hover:border-blue-500/50 hover:shadow-lg',
                          draggingBot === agent.id && 'opacity-30 scale-95'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <motion.div 
                            className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold shrink-0"
                            animate={draggingBot === agent.id ? { rotate: [0, -10, 10, -10, 0] } : {}}
                            transition={{ duration: 0.5 }}
                          >
                            {getEmoji(agent.id)}
                          </motion.div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-semibold text-foreground truncate">
                              {agent.name}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {agent.id.slice(0, 12)}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
            
            {/* 已分配员工 */}
            {departments.map((dept) => {
              const deptAgents = agents.filter((agent) => assignments[agent.id] === dept.id);
              if (deptAgents.length === 0) return null;
              
              return (
                <div key={dept.id}>
                  <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
                    <span>{dept.name}</span>
                    <span className="text-[10px] bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                      {deptAgents.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence>
                      {deptAgents.map((agent) => (
                        <motion.div
                          key={agent.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="group relative"
                        >
                          <div
                            draggable
                            onDragStart={(e) => handleDragStart(e, agent.id)}
                            onDragEnd={handleDragEnd}
                            className={cn(
                              'p-3 rounded-xl border cursor-grab active:cursor-grabbing transition-all',
                              'bg-white dark:bg-gray-800 border-black/10 dark:border-white/10',
                              'hover:border-blue-500/50 hover:shadow-lg',
                              draggingBot === agent.id && 'opacity-30 scale-95'
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold shrink-0">
                                {getEmoji(agent.id)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-semibold text-foreground truncate">
                                  {agent.name}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  {agent.id.slice(0, 12)}
                                </div>
                              </div>
                              <button
                                onClick={() => handleUnassignAgent(agent.id)}
                                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 transition-all"
                                title="移除分配"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
            
            {unassignedAgents.length === 0 && agents.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-[13px] text-muted-foreground text-center py-8"
              >
                还没有员工
              </motion.div>
            )}
          </div>
          
          <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/5 text-[11px] text-muted-foreground space-y-1">
            <div>💡 拖拽员工到画布中的部门节点</div>
            <div>❌ 点击 X 按钮移除分配</div>
          </div>
        </div>
      </motion.div>
      
      {/* 画布区域 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex-1 rounded-2xl overflow-hidden relative"
        style={{
          background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%)',
        }}
        onDrop={handleCanvasDrop}
        onDragOver={handleCanvasDragOver}
      >
        {/* 背景装饰 */}
        <div className="absolute inset-0 opacity-30 pointer-events-none" style={{
          backgroundImage: `
            radial-gradient(circle at 20% 30%, rgba(59, 130, 246, 0.08) 0%, transparent 50%),
            radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.08) 0%, transparent 50%),
            radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.05) 0%, transparent 50%)
          `,
        }} />
        
        {/* 微妙的网格纹理 */}
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
          backgroundImage: `
            linear-gradient(rgba(0,0,0,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,0,0,0.05) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }} />
        
        <div ref={containerRef} className="w-full h-full relative" style={{ zIndex: 1 }} />
        
        {departments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 2 }}>
            <div className="text-center">
              <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 flex items-center justify-center backdrop-blur-sm border border-white/20 shadow-xl">
                <Building2 className="w-12 h-12 text-blue-500/50" />
              </div>
              <div className="text-[17px] font-semibold text-foreground/80 mb-2">还没有部门</div>
              <div className="text-[14px] text-muted-foreground/70 max-w-xs">在左侧添加第一个部门开始构建组织架构</div>
            </div>
          </div>
        )}
        
        {/* 操作提示 */}
        <div className="absolute bottom-5 right-5 bg-white/80 dark:bg-gray-800/80 backdrop-blur-md rounded-2xl px-5 py-3 text-[12px] text-muted-foreground border border-white/40 dark:border-white/10 shadow-xl" style={{ zIndex: 2 }}>
          <div className="flex items-center gap-5">
            <span className="flex items-center gap-1.5">
              <span className="text-[14px]">🖱</span>
              <span>拖动画布</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[14px]">⌘</span>
              <span>+ 滚轮缩放</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[14px]">🖱</span>
              <span>右键部门操作</span>
            </span>
          </div>
        </div>
        
        {/* 拖动提示 */}
        <AnimatePresence>
          {draggingBot && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="absolute top-5 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-6 py-3 rounded-2xl shadow-2xl font-medium text-[13px] flex items-center gap-2"
              style={{ zIndex: 3 }}
            >
              <motion.span
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 0.5, repeat: Infinity }}
              >
                👆
              </motion.span>
              拖动到部门节点上释放
            </motion.div>
          )}
        </AnimatePresence>
        
        {/* 拖动预览 */}
        <AnimatePresence>
          {draggingBot && dragPosition && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              style={{
                position: 'fixed',
                left: dragPosition.x,
                top: dragPosition.y,
                pointerEvents: 'none',
                zIndex: 9999,
              }}
              className="transform -translate-x-1/2 -translate-y-1/2"
            >
              <motion.div
                animate={{ 
                  rotate: [0, 5, -5, 0],
                  scale: [1, 1.05, 1],
                }}
                transition={{ duration: 0.5, repeat: Infinity }}
                className="p-3 rounded-xl border-2 border-blue-500 bg-white dark:bg-gray-800 shadow-2xl"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold">
                    {getEmoji(draggingBot)}
                  </div>
                  <div className="text-[13px] font-semibold text-foreground">
                    {agents.find((a) => a.id === draggingBot)?.name}
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      
      {/* 重命名对话框 */}
      <AnimatePresence>
        {editingDept && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={() => setEditingDept(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#f3f1e9] dark:bg-gray-800 rounded-3xl p-6 w-full max-w-md shadow-2xl"
            >
              <h3 className="text-xl font-serif font-normal tracking-tight text-foreground mb-4">
                重命名部门
              </h3>
              <Input
                value={editingDept.name}
                onChange={(e) => setEditingDept({ ...editingDept, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && handleRenameDepartment()}
                className="h-11 text-[13px] rounded-xl mb-4"
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => setEditingDept(null)}
                  className="h-9 text-[13px] font-medium rounded-full px-4"
                >
                  取消
                </Button>
                <Button
                  onClick={handleRenameDepartment}
                  disabled={!editingDept.name.trim()}
                  className="h-9 text-[13px] font-medium rounded-full px-4"
                >
                  确定
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 确认对话框 */}
      <AnimatePresence>
        {confirmDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={() => setConfirmDialog(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#f3f1e9] dark:bg-gray-800 rounded-3xl p-6 w-full max-w-md shadow-2xl"
            >
              <h3 className="text-xl font-serif font-normal tracking-tight text-foreground mb-3">
                {confirmDialog.title}
              </h3>
              <p className="text-[14px] text-muted-foreground mb-6">
                {confirmDialog.message}
              </p>
              <div className="flex gap-3 justify-end">
                <Button
                  variant="outline"
                  onClick={() => setConfirmDialog(null)}
                  className="h-10 text-[13px] font-medium rounded-full px-6"
                >
                  取消
                </Button>
                <Button
                  onClick={confirmDialog.onConfirm}
                  className="h-10 text-[13px] font-medium rounded-full px-6 bg-red-600 hover:bg-red-700"
                >
                  确定删除
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 右键菜单 */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            className="fixed z-50 bg-white dark:bg-gray-800 rounded-xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden min-w-[160px]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                const dept = departments.find((d) => d.id === contextMenu.deptId);
                if (dept) setEditingDept({ id: dept.id, name: dept.name });
                setContextMenu(null);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Edit2 className="w-3.5 h-3.5" />
              重命名
            </button>
            <button
              onClick={() => {
                setSelectedDept(contextMenu.deptId);
                setContextMenu(null);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              添加子部门
            </button>
            <button
              onClick={() => {
                handleDeleteDepartment(contextMenu.deptId);
                setContextMenu(null);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除部门
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {/* 右键菜单 - 员工 */}
      <AnimatePresence>
        {botContextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            style={{ left: botContextMenu.x, top: botContextMenu.y }}
            className="fixed z-50 bg-white dark:bg-gray-800 rounded-xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden min-w-[160px]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                handleUnassignAgent(botContextMenu.botId);
                setBotContextMenu(null);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              移除分配
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
