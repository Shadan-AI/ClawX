import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/x6';
import dagre from 'dagre';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, Plus, Trash2, Edit2, Users, Bot, X, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
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
  const hasInitialLayoutRef = useRef(false);
  
  const { departments, assignments, addDepartment, updateDepartment, deleteDepartment, assignAgent, unassignAgent, loadFromServer, saveToServer, startSync, stopSync, startAutoSave, stopAutoSave, syncStatus, lastSyncTime, hasLocalChanges, isLoading, isSaving } = useOrganizationStore();
  const { agents } = useAgentsStore();
  
  // 组件加载时从服务器加载数据并开始同步
  useEffect(() => {
    loadFromServer();
    startSync();
    startAutoSave();
    
    return () => {
      stopSync();
      stopAutoSave();
    };
  }, [loadFromServer, startSync, stopSync, startAutoSave, stopAutoSave]);
  
  // 获取未分配的员工
  const unassignedAgents = useMemo(
    () => agents.filter((agent) => !assignments[agent.id]),
    [agents, assignments]
  );

  // 注册自定义节点
  useEffect(() => {
    // 部门节点 - 使用 HTML 渲染而不是 SVG
    Graph.registerNode(
      'dept-node',
      {
        inherit: 'rect',
        width: 240,
        height: 80,
        attrs: {
          body: {
            strokeWidth: 0,
            fill: 'transparent',
          },
        },
        markup: [
          {
            tagName: 'foreignObject',
            selector: 'fo',
            children: [
              {
                tagName: 'body',
                selector: 'foBody',
                ns: 'http://www.w3.org/1999/xhtml',
                children: [
                  {
                    tagName: 'div',
                    selector: 'content',
                  },
                ],
              },
            ],
          },
        ],
        attrs: {
          fo: {
            refWidth: '100%',
            refHeight: '100%',
          },
          foBody: {
            xmlns: 'http://www.w3.org/1999/xhtml',
            style: {
              width: '100%',
              height: '100%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            },
          },
        },
      },
      true
    );

    // 员工节点 - 使用 HTML 渲染
    Graph.registerNode(
      'bot-node',
      {
        inherit: 'rect',
        width: 180,
        height: 90,
        attrs: {
          body: {
            strokeWidth: 0,
            fill: 'transparent',
          },
        },
        markup: [
          {
            tagName: 'foreignObject',
            selector: 'fo',
            children: [
              {
                tagName: 'body',
                selector: 'foBody',
                ns: 'http://www.w3.org/1999/xhtml',
                children: [
                  {
                    tagName: 'div',
                    selector: 'content',
                  },
                ],
              },
            ],
          },
        ],
        attrs: {
          fo: {
            refWidth: '100%',
            refHeight: '100%',
          },
          foBody: {
            xmlns: 'http://www.w3.org/1999/xhtml',
            style: {
              width: '100%',
              height: '100%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            },
          },
        },
      },
      true
    );

    // 边
    Graph.registerEdge('org-edge', {
      inherit: 'edge',
      zIndex: 0,
      connector: { name: 'rounded' },
      router: { name: 'orth' },
      attrs: {
        line: {
          strokeWidth: 2.5,
          stroke: '#94a3b8',
          strokeOpacity: 1,
          sourceMarker: null,
          targetMarker: null,
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
        color: '#f8f6f0',
      },
      grid: false,
      interacting: {
        nodeMovable: false, // 禁用简单移动，我们用拖放来改变层级
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
      },
    });
    
    graphRef.current = graph;
    
    // 监听节点点击事件
    graph.on('node:click', ({ node }) => {
      const data = node.getData();
      if (data?.type === 'dept' || data?.type === 'bot') {
        setSelectedDept(data.id);
      }
    });
    
    // 监听员工节点拖动开始 - 禁用画布上的拖动
    graph.on('node:mousedown', ({ node, e }) => {
      const data = node.getData();
      if (data?.type === 'bot') {
        // 禁用画布上员工节点的拖动
        e.preventDefault();
        e.stopPropagation();
      }
    });
    
    // 监听右键菜单
    graph.on('node:contextmenu', ({ node, e }) => {
      e.preventDefault();
      e.stopPropagation();
      const data = node.getData();
      if (data?.type === 'dept') {
        setBotContextMenu(null); // 关闭员工菜单
        setContextMenu({ x: e.clientX, y: e.clientY, deptId: data.id });
      } else if (data?.type === 'bot') {
        setContextMenu(null); // 关闭部门菜单
        setBotContextMenu({ x: e.clientX, y: e.clientY, botId: data.id });
      }
    });
    
    // 监听画布空白区域右键菜单
    graph.on('blank:contextmenu', ({ e }) => {
      e.preventDefault();
      e.stopPropagation();
      // 空白区域不显示任何菜单
    });
    
    // 监听画布点击事件（取消选择）
    graph.on('blank:click', () => {
      setSelectedDept(null);
    });
    
    // 监听容器大小变化，自动适配画布
    const resizeObserver = new ResizeObserver(() => {
      if (graph.getNodes().length > 0) {
        // 使用 requestAnimationFrame 确保在下一帧执行
        requestAnimationFrame(() => {
          graph.zoomToFit({ 
            padding: 60, 
            maxScale: 1,
          });
        });
      }
    });
    
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => {
      resizeObserver.disconnect();
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
  
  // 递归计算部门总人数(包括所有子孙节点)
  const getDepartmentTotalCount = useCallback((deptId: string): number => {
    let total = 0;
    
    // 1. 找到所有直接分配给该部门的员工
    const directAgents = Object.entries(assignments)
      .filter(([_, assignedTo]) => assignedTo === deptId)
      .map(([botId]) => botId);
    
    total += directAgents.length;
    
    // 2. 递归计算分配给这些员工的下级员工
    const countAgentSubordinates = (botId: string): number => {
      const subordinates = Object.entries(assignments)
        .filter(([_, assignedTo]) => assignedTo === botId)
        .map(([subBotId]) => subBotId);
      
      let count = subordinates.length;
      subordinates.forEach(subBotId => {
        count += countAgentSubordinates(subBotId);
      });
      return count;
    };
    
    directAgents.forEach(botId => {
      total += countAgentSubordinates(botId);
    });
    
    // 3. 递归计算子部门的人数
    const childDepts = departments.filter(d => d.parentId === deptId);
    childDepts.forEach(child => {
      total += getDepartmentTotalCount(child.id);
    });
    
    return total;
  }, [assignments, departments]);

  // 渲染组织架构图
  const renderGraph = useCallback(() => {
    if (!graphRef.current) return;
    
    const graph = graphRef.current;
    
    if (departments.length === 0) {
      graph.clearCells();
      return;
    }
    
    // 获取现有节点和边
    const existingNodes = new Map(graph.getNodes().map(n => [n.id, n]));
    const existingEdges = new Map(graph.getEdges().map(e => [e.id, e]));
    
    const newNodeIds = new Set<string>();
    const newEdgeIds = new Set<string>();
    
    // 创建或更新部门节点
    departments.forEach((dept) => {
      const nodeId = `dept-${dept.id}`;
      newNodeIds.add(nodeId);
      
      const assignedCount = getDepartmentTotalCount(dept.id);
      const color = getColor(dept.id);
      const isDropTarget = dropTarget === dept.id;
      
      const existingNode = existingNodes.get(nodeId);
      
      if (existingNode) {
        // 更新现有节点
        existingNode.setAttrs({
          content: {
            html: `
              <div style="
                width: 240px;
                height: 80px;
                background: ${isDropTarget ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : color};
                border: ${isDropTarget ? '3px' : '2px'} solid ${isDropTarget ? '#60a5fa' : color};
                border-radius: 16px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: white;
                font-family: Georgia, Cambria, 'Times New Roman', Times, serif;
                box-shadow: ${isDropTarget ? '0 8px 16px -2px rgba(59, 130, 246, 0.4), 0 0 0 4px rgba(59, 130, 246, 0.2)' : '0 4px 6px -1px rgba(0, 0, 0, 0.1)'};
                transition: all 0.2s ease;
                transform: ${isDropTarget ? 'scale(1.05)' : 'scale(1)'};
              ">
                <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${dept.name}</div>
                <div style="font-size: 13px; font-weight: 500;">${assignedCount} 人</div>
                ${isDropTarget ? '<div style="font-size: 11px; margin-top: 4px; opacity: 0.9;">📍 释放以分配</div>' : ''}
              </div>
            `,
          },
        });
      } else {
        // 创建新节点
        const node = graph.addNode({
          id: nodeId,
          shape: 'dept-node',
          x: 100,
          y: 100,
          data: { type: 'dept', id: dept.id },
          attrs: {
            content: {
              html: `
                <div style="
                  width: 240px;
                  height: 80px;
                  background: ${color};
                  border: 2px solid ${color};
                  border-radius: 16px;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  color: white;
                  font-family: Georgia, Cambria, 'Times New Roman', Times, serif;
                  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                  animation: nodeEnter 0.4s ease-out;
                ">
                  <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">${dept.name}</div>
                  <div style="font-size: 13px; font-weight: 500;">${assignedCount} 人</div>
                </div>
                <style>
                  @keyframes nodeEnter {
                    from {
                      opacity: 0;
                      transform: translateY(-20px) scale(0.95);
                    }
                    to {
                      opacity: 1;
                      transform: translateY(0) scale(1);
                    }
                  }
                  @keyframes nodeExit {
                    from {
                      opacity: 1;
                      transform: translateY(0) scale(1);
                    }
                    to {
                      opacity: 0;
                      transform: translateY(20px) scale(0.95);
                    }
                  }
                </style>
              `,
            },
          },
        });
      }
    });
    
    // 创建或更新员工节点
    agents.forEach((agent) => {
      const parentId = assignments[agent.id];
      if (!parentId) return;
      
      const nodeId = `bot-${agent.id}`;
      newNodeIds.add(nodeId);
      
      const color = getColor(agent.id);
      const emoji = getEmoji(agent.id);
      const isDropTarget = dropTarget === agent.id;
      
      const existingNode = existingNodes.get(nodeId);
      
      const nodeHtml = `
        <div style="
          width: 180px;
          height: 90px;
          background: ${isDropTarget ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '#f3f1e9'};
          border: ${isDropTarget ? '3px' : '2px'} solid ${isDropTarget ? '#34d399' : color};
          border-radius: 14px;
          display: flex;
          align-items: center;
          padding: 12px;
          font-family: Georgia, Cambria, 'Times New Roman', Times, serif;
          box-shadow: ${isDropTarget ? '0 8px 16px -2px rgba(16, 185, 129, 0.4), 0 0 0 4px rgba(16, 185, 129, 0.2)' : '0 2px 4px rgba(0, 0, 0, 0.1)'};
          animation: nodeEnter 0.4s ease-out;
          transform: ${isDropTarget ? 'scale(1.05)' : 'scale(1)'};
          transition: all 0.2s ease;
        ">
          <div style="
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: ${isDropTarget ? '#fff' : '#f8f6f0'};
            border: 2px solid ${isDropTarget ? '#34d399' : color};
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            flex-shrink: 0;
          ">${emoji}</div>
          <div style="margin-left: 12px; flex: 1; min-width: 0;">
            <div style="font-size: 14px; font-weight: 600; color: ${isDropTarget ? '#fff' : '#1a1a2e'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${agent.name.length > 10 ? agent.name.slice(0, 10) + '…' : agent.name}
            </div>
            <div style="font-size: 12px; color: ${isDropTarget ? 'rgba(255,255,255,0.8)' : '#9ca3af'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${isDropTarget ? '📍 释放以分配' : 'ID: ' + agent.id.slice(0, 8)}
            </div>
          </div>
        </div>
        <style>
          @keyframes nodeEnter {
            from {
              opacity: 0;
              transform: translateY(-20px) scale(0.95);
            }
            to {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
          @keyframes nodeExit {
            from {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
            to {
              opacity: 0;
              transform: translateY(20px) scale(0.95);
            }
          }
        </style>
      `;
      
      if (existingNode) {
        // 更新现有节点
        existingNode.setAttrs({
          content: {
            html: nodeHtml,
          },
        });
      } else {
        // 创建新节点
        graph.addNode({
          id: nodeId,
          shape: 'bot-node',
          x: 100,
          y: 100,
          data: { type: 'bot', id: agent.id, parentId },
          attrs: {
            content: {
              html: nodeHtml,
            },
          },
        });
      }
    });
    
    // 创建部门层级边
    departments.forEach((dept) => {
      if (!dept.parentId) return;
      
      const parentNodeId = dept.parentType === 'bot' 
        ? `bot-${dept.parentId}` 
        : `dept-${dept.parentId}`;
      const edgeId = `edge-dept-${dept.parentId}-${dept.id}`;
      newEdgeIds.add(edgeId);
      
      if (!existingEdges.has(edgeId)) {
        graph.addEdge({
          id: edgeId,
          shape: 'org-edge',
          source: { cell: parentNodeId },
          target: { cell: `dept-${dept.id}` },
        });
      }
    });
    
    // 创建员工到父节点的边
    agents.forEach((agent) => {
      const parentId = assignments[agent.id];
      if (!parentId) return;
      
      // 判断父节点类型
      const isParentBot = agents.some((a) => a.id === parentId);
      const parentNodeId = isParentBot ? `bot-${parentId}` : `dept-${parentId}`;
      
      const edgeId = `edge-bot-${agent.id}-${parentId}`;
      newEdgeIds.add(edgeId);
      
      if (!existingEdges.has(edgeId)) {
        graph.addEdge({
          id: edgeId,
          shape: 'org-edge',
          source: { cell: parentNodeId },
          target: { cell: `bot-${agent.id}` },
          attrs: {
            line: {
              stroke: '#d1d5db',
              strokeWidth: 1,
              strokeOpacity: 1,
              strokeDasharray: '4 3',
            },
          },
        });
      }
    });
    
    // 移除不再需要的节点（立即删除，不用动画）
    existingNodes.forEach((node, id) => {
      if (!newNodeIds.has(id)) {
        node.remove();
      }
    });
    
    // 移除不再需要的边（立即删除）
    existingEdges.forEach((edge, id) => {
      if (!newEdgeIds.has(id)) {
        edge.remove();
      }
    });
    
    // 布局所有节点
    const allNodes = graph.getNodes();
    const allEdges = graph.getEdges();
    
    if (allNodes.length === 0) return;
    
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80 });
    g.setDefaultEdgeLabel(() => ({}));
    
    allNodes.forEach((node) => {
      const size = node.getSize();
      g.setNode(node.id, { width: size.width, height: size.height });
    });
    
    allEdges.forEach((edge) => {
      const src = edge.getSource();
      const tgt = edge.getTarget();
      if (src.cell && tgt.cell) {
        g.setEdge(src.cell as string, tgt.cell as string);
      }
    });
    
    dagre.layout(g);
    
    // 更新所有节点位置
    allNodes.forEach((node) => {
      const pos = g.node(node.id);
      if (pos) {
        const targetX = pos.x - pos.width / 2;
        const targetY = pos.y - pos.height / 2;
        
        // 直接设置位置，不使用动画（避免 API 问题）
        node.setPosition(targetX, targetY);
      }
    });
    
    // 缩放到合适大小
    if (allNodes.length > 0) {
      // 如果是第一次布局，或者节点数量发生了显著变化，重新缩放
      const shouldZoom = !hasInitialLayoutRef.current;
      
      if (shouldZoom) {
        setTimeout(() => {
          graph.zoomToFit({ 
            padding: 60, 
            maxScale: 1,
          });
          hasInitialLayoutRef.current = true;
        }, 100);
      }
    } else {
      // 如果没有节点了，重置标记
      hasInitialLayoutRef.current = false;
    }
  }, [departments, assignments, agents, dropTarget, getDepartmentTotalCount]);
  
  useEffect(() => {
    renderGraph();
  }, [renderGraph]);
  
  // 添加部门
  const handleAddDepartment = useCallback(() => {
    if (!newDeptName.trim()) return;
    
    // 判断父节点类型
    let parentType: 'dept' | 'bot' = 'dept';
    if (selectedDept) {
      // 检查是否是员工 ID
      const isBot = agents.some((agent) => agent.id === selectedDept);
      if (isBot) {
        parentType = 'bot';
      }
    }
    
    addDepartment(newDeptName.trim(), selectedDept, parentType);
    setNewDeptName('');
    toast.success('部门已添加');
  }, [newDeptName, selectedDept, addDepartment, agents]);
  
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
  
  // 跳转到对话界面
  const handleChatWithAgent = useCallback((agentId: string) => {
    // 跳转到对话页面，并通过 state 传递需要创建新会话的 agentId
    navigate('/', { state: { createNewSessionFor: agentId } });
  }, [navigate]);
  
  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, botId: string) => {
    e.dataTransfer.setData('botId', botId);
    e.dataTransfer.effectAllowed = 'move';
    
    // 隐藏浏览器默认的拖动预览
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
    
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
    const targetNode = graph.getNodes().find((n) => {
      const data = n.getData();
      if (data?.type !== 'dept' && data?.type !== 'bot') return false;
      return n.getBBox().containsPoint(p);
    });
    
    if (targetNode) {
      const nodeData = targetNode.getData();
      const parentId = nodeData.id;
      const parentType = nodeData.type as 'dept' | 'bot';
      
      // 防止将员工拖到自己身上
      if (parentType === 'bot' && parentId === draggingBot) {
        toast.error('不能将员工分配到自己下面');
        setDraggingBot(null);
        setDragPosition(null);
        setDropTarget(null);
        return;
      }
      
      assignAgent(draggingBot, parentId, parentType);
      toast.success('员工已分配');
    }
    
    setDraggingBot(null);
    setDragPosition(null);
    setDropTarget(null);
  }, [draggingBot, assignAgent]);
  
  // 拖拽经过画布时高亮目标部门
  const handleCanvasDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    
    setDragPosition({ x: e.clientX, y: e.clientY });
    
    if (!draggingBot || !graphRef.current) return;
    
    const graph = graphRef.current;
    const p = graph.clientToLocal(e.clientX, e.clientY);
    const targetNode = graph.getNodes().find((n) => {
      const data = n.getData();
      if (data?.type !== 'dept' && data?.type !== 'bot') return false;
      // 排除自己
      if (data?.type === 'bot' && data?.id === draggingBot) return false;
      return n.getBBox().containsPoint(p);
    });
    
    const newTarget = targetNode ? targetNode.getData().id : null;
    
    // 只在目标改变时更新状态，减少重渲染
    if (dropTarget !== newTarget) {
      setDropTarget(newTarget);
    }
  }, [draggingBot, dropTarget]);

  return (
    <div className="flex h-full gap-6">
      {/* 左侧面板 */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="w-72 flex flex-col gap-6"
      >
        {/* 部门管理 */}
        <div className="rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h3 className="text-[15px] font-semibold text-foreground">组织架构</h3>
            </div>
            <div className="flex items-center gap-2">
              {/* 同步状态指示器 */}
              <div className="flex items-center gap-1.5 text-[11px]">
                {syncStatus === 'syncing' && (
                  <>
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-muted-foreground">同步中</span>
                  </>
                )}
                {syncStatus === 'saved' && (
                  <>
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-muted-foreground">已保存</span>
                  </>
                )}
                {syncStatus === 'error' && (
                  <>
                    <div className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-red-500">错误</span>
                  </>
                )}
                {syncStatus === 'conflict' && (
                  <>
                    <div className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span className="text-yellow-600">冲突</span>
                  </>
                )}
                {hasLocalChanges && syncStatus === 'idle' && (
                  <>
                    <div className="w-2 h-2 rounded-full bg-orange-500" />
                    <span className="text-muted-foreground">未保存</span>
                  </>
                )}
              </div>
              
              {/* 手动刷新按钮 */}
              <Button
                onClick={() => loadFromServer()}
                disabled={isLoading}
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                title="刷新数据"
              >
                <svg 
                  xmlns="http://www.w3.org/2000/svg" 
                  width="14" 
                  height="14" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                  className={isLoading ? 'animate-spin' : ''}
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                </svg>
              </Button>
            </div>
          </div>
          
          <div className="space-y-3">
            <Input
              value={newDeptName}
              onChange={(e) => setNewDeptName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddDepartment()}
              placeholder={
                selectedDept 
                  ? (agents.some((a) => a.id === selectedDept) 
                      ? '添加子部门到员工' 
                      : '添加子部门')
                  : '添加根部门'
              }
              className="h-10 text-[13px] rounded-xl"
            />
            <div className="flex gap-2">
              <Button
                onClick={handleAddDepartment}
                disabled={!newDeptName.trim()}
                className="flex-1 h-10 text-[13px] font-medium rounded-xl"
              >
                <Plus className="w-4 h-4 mr-2" />
                添加{selectedDept ? '子' : '根'}部门
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  hasInitialLayoutRef.current = false;
                  renderGraph();
                  toast.success('布局已重置');
                }}
                className="h-10 text-[13px] font-medium rounded-xl px-3"
                title="重置布局"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                </svg>
              </Button>
            </div>
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
                  当前选中: {
                    departments.find((d) => d.id === selectedDept)?.name || 
                    agents.find((a) => a.id === selectedDept)?.name ||
                    '未知节点'
                  }
                </div>
                <div className="flex gap-2">
                  {departments.find((d) => d.id === selectedDept) && (
                    <>
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
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* 未分配员工 */}
        <div className="flex-1 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 p-5 overflow-hidden flex flex-col min-h-0">
          <div className="flex items-center gap-2 mb-4 shrink-0">
            <Users className="w-5 h-5 text-green-600 dark:text-green-400" />
            <h3 className="text-[15px] font-semibold text-foreground">
              员工列表
            </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto -mr-2 pr-2 space-y-3 min-h-0">
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
                        draggable
                        onDragStart={(e) => handleDragStart(e, agent.id)}
                        onDragEnd={handleDragEnd}
                        className={cn(
                          'group p-3 rounded-xl border cursor-grab active:cursor-grabbing transition-all',
                          'bg-[#f8f6f0] dark:bg-white/[0.02] border-black/5 dark:border-white/5',
                          'hover:border-primary/40 hover:bg-[#f3f1e9] dark:hover:bg-white/[0.06] hover:shadow-md',
                          draggingBot === agent.id && 'opacity-30'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold shrink-0"
                          >
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
                            onClick={(e) => {
                              e.stopPropagation();
                              handleChatWithAgent(agent.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-primary/10 text-primary transition-all"
                            title="开始对话"
                          >
                            <MessageCircle className="w-4 h-4" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
            

            
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
          
          <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/5 text-[11px] text-muted-foreground space-y-1 shrink-0">
            <div>💡 拖拽员工到部门或其他员工节点</div>
            <div>❌ 点击 X 按钮移除分配</div>
            <div>🖱 右键节点查看更多操作</div>
          </div>
        </div>
      </motion.div>
      
      {/* 画布区域 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex-1 rounded-2xl overflow-hidden relative bg-[#f8f6f0] dark:bg-gray-900 border border-black/5 dark:border-white/5"
        onDrop={handleCanvasDrop}
        onDragOver={handleCanvasDragOver}
        onDragEnd={handleDragEnd}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div ref={containerRef} className="w-full h-full relative z-0" />
        
        {departments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="text-center">
              <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 flex items-center justify-center backdrop-blur-sm border border-white/20 shadow-xl">
                <Building2 className="w-12 h-12 text-blue-500/50" />
              </div>
              <div className="text-[17px] font-serif font-semibold text-foreground/80 mb-2" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
                还没有部门
              </div>
              <div className="text-[14px] text-muted-foreground/70 max-w-xs">在左侧添加第一个部门开始构建组织架构</div>
            </div>
          </div>
        )}
        
        {/* 操作提示 */}
        <div className="absolute bottom-5 right-5 bg-[#f3f1e9]/90 dark:bg-gray-800/90 backdrop-blur-md rounded-2xl px-5 py-3 text-[12px] text-muted-foreground border border-black/10 dark:border-white/10 shadow-xl z-10">
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
              className="absolute top-5 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-6 py-3 rounded-2xl shadow-2xl font-medium text-[13px] flex items-center gap-2 z-20"
            >
              <motion.span
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 0.5, repeat: Infinity }}
              >
                👆
              </motion.span>
              拖动到部门或员工节点上释放
            </motion.div>
          )}
        </AnimatePresence>
        
        {/* 拖动预览 */}
        <AnimatePresence>
          {draggingBot && dragPosition && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              style={{
                position: 'fixed',
                left: dragPosition.x,
                top: dragPosition.y,
                pointerEvents: 'none',
                zIndex: 9999,
                willChange: 'transform',
              }}
              className="transform -translate-x-1/2 -translate-y-1/2"
            >
              <div className="p-3 rounded-xl border-2 border-blue-500 bg-white dark:bg-gray-800 shadow-2xl">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold">
                    {getEmoji(draggingBot)}
                  </div>
                  <div className="text-[13px] font-semibold text-foreground">
                    {agents.find((a) => a.id === draggingBot)?.name}
                  </div>
                </div>
              </div>
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
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                setTimeout(() => {
                  const dept = departments.find((d) => d.id === contextMenu.deptId);
                  if (dept) setEditingDept({ id: dept.id, name: dept.name });
                }, 0);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Edit2 className="w-3.5 h-3.5" />
              重命名
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                // 使用 setTimeout 确保菜单先关闭
                setTimeout(() => {
                  setSelectedDept(contextMenu.deptId);
                }, 0);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              添加子部门
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const deptId = contextMenu.deptId;
                setContextMenu(null);
                setTimeout(() => {
                  handleDeleteDepartment(deptId);
                }, 0);
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
              onClick={(e) => {
                e.stopPropagation();
                const botId = botContextMenu.botId;
                setBotContextMenu(null);
                setTimeout(() => {
                  setSelectedDept(botId);
                }, 0);
              }}
              className="w-full px-4 py-2.5 text-left text-[13px] text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              添加子部门
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const botId = botContextMenu.botId;
                setBotContextMenu(null);
                setTimeout(() => {
                  handleUnassignAgent(botId);
                }, 0);
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
