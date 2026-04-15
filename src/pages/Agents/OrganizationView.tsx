import { useEffect, useRef, useState } from 'react';
import { Graph, Node, Edge } from '@antv/x6';
import dagre from 'dagre';
import { useOrganizationStore } from '../../stores/organization';
import { useAgentsStore } from '../../stores/agents';
import { Building2, Plus, Trash2, Edit2, Users } from 'lucide-react';
import type { Department } from '../../types/organization';

export function OrganizationView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [newDeptName, setNewDeptName] = useState('');
  const [editingDept, setEditingDept] = useState<{ id: string; name: string } | null>(null);
  
  const { departments, assignments, addDepartment, updateDepartment, deleteDepartment, assignAgent, unassignAgent } = useOrganizationStore();
  const { agents } = useAgentsStore();
  
  // 获取未分配的员工
  const unassignedAgents = agents.filter((agent) => !assignments[agent.id]);
  
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
      },
      background: {
        color: '#1a1a1a',
      },
      grid: {
        visible: true,
        type: 'dot',
        args: {
          color: '#333',
          thickness: 1,
        },
      },
    });
    
    graphRef.current = graph;
    
    // 监听节点点击事件
    graph.on('node:click', ({ node }) => {
      const nodeId = node.id;
      if (nodeId.startsWith('dept-')) {
        setSelectedDept(nodeId);
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
  
  // 渲染组织架构图
  useEffect(() => {
    if (!graphRef.current) return;
    
    const graph = graphRef.current;
    graph.clearCells();
    
    if (departments.length === 0) {
      return;
    }
    
    // 创建 dagre 图
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80 });
    g.setDefaultEdgeLabel(() => ({}));
    
    // 添加部门节点
    departments.forEach((dept) => {
      const assignedCount = Object.values(assignments).filter((deptId) => deptId === dept.id).length;
      g.setNode(dept.id, { width: 180, height: 80, label: dept.name, count: assignedCount });
    });
    
    // 添加边
    departments.forEach((dept) => {
      if (dept.parentId) {
        g.setEdge(dept.parentId, dept.id);
      }
    });
    
    // 计算布局
    dagre.layout(g);
    
    // 创建节点
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    
    g.nodes().forEach((nodeId) => {
      const nodeData = g.node(nodeId);
      const dept = departments.find((d) => d.id === nodeId);
      if (!dept) return;
      
      const node = graph.createNode({
        id: nodeId,
        x: nodeData.x - nodeData.width / 2,
        y: nodeData.y - nodeData.height / 2,
        width: nodeData.width,
        height: nodeData.height,
        shape: 'rect',
        attrs: {
          body: {
            fill: selectedDept === nodeId ? '#3b82f6' : '#2563eb',
            stroke: '#1e40af',
            strokeWidth: 2,
            rx: 8,
            ry: 8,
          },
          label: {
            text: `${dept.name}\n(${nodeData.count} 人)`,
            fill: '#fff',
            fontSize: 14,
            fontWeight: 'bold',
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
          },
        },
      });
      
      nodes.push(node);
    });
    
    // 创建边
    g.edges().forEach((edge) => {
      const edgeData = g.edge(edge);
      const points = edgeData.points || [];
      
      const e = graph.createEdge({
        source: edge.v,
        target: edge.w,
        vertices: points.slice(1, -1).map((p) => ({ x: p.x, y: p.y })),
        attrs: {
          line: {
            stroke: '#4b5563',
            strokeWidth: 2,
            targetMarker: null,
          },
        },
      });
      
      edges.push(e);
    });
    
    graph.addNodes(nodes);
    graph.addEdges(edges);
    
    // 居中显示
    graph.centerContent();
  }, [departments, assignments, selectedDept]);
  
  // 添加部门
  const handleAddDepartment = () => {
    if (!newDeptName.trim()) return;
    addDepartment(newDeptName.trim(), selectedDept);
    setNewDeptName('');
  };
  
  // 删除部门
  const handleDeleteDepartment = (deptId: string) => {
    if (confirm('确定要删除这个部门吗？子部门和员工分配也会被清除。')) {
      deleteDepartment(deptId);
      if (selectedDept === deptId) {
        setSelectedDept(null);
      }
    }
  };
  
  // 重命名部门
  const handleRenameDepartment = () => {
    if (!editingDept || !editingDept.name.trim()) return;
    updateDepartment(editingDept.id, editingDept.name.trim());
    setEditingDept(null);
  };
  
  // 拖拽开始
  const handleDragStart = (e: React.DragEvent, botId: string) => {
    e.dataTransfer.setData('botId', botId);
  };
  
  // 拖拽到部门
  const handleDrop = (e: React.DragEvent, deptId: string) => {
    e.preventDefault();
    const botId = e.dataTransfer.getData('botId');
    if (botId) {
      assignAgent(botId, deptId);
    }
  };
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  
  return (
    <div className="flex h-full">
      {/* 左侧面板 */}
      <div className="w-80 border-r border-gray-700 bg-gray-800 p-4 overflow-y-auto">
        <div className="space-y-6">
          {/* 部门管理 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Building2 className="w-5 h-5 text-blue-400" />
              <h3 className="text-lg font-semibold text-white">组织架构</h3>
            </div>
            
            <div className="space-y-2">
              <input
                type="text"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddDepartment()}
                placeholder={selectedDept ? '添加子部门' : '添加根部门'}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleAddDepartment}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              >
                <Plus className="w-4 h-4" />
                添加{selectedDept ? '子' : '根'}部门
              </button>
            </div>
            
            {selectedDept && (
              <div className="mt-3 p-3 bg-gray-700 rounded">
                <div className="text-sm text-gray-300 mb-2">
                  当前选中: {departments.find((d) => d.id === selectedDept)?.name}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const dept = departments.find((d) => d.id === selectedDept);
                      if (dept) setEditingDept({ id: dept.id, name: dept.name });
                    }}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
                  >
                    <Edit2 className="w-3 h-3" />
                    重命名
                  </button>
                  <button
                    onClick={() => handleDeleteDepartment(selectedDept)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    删除
                  </button>
                </div>
              </div>
            )}
          </div>
          
          {/* 未分配员工 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-5 h-5 text-green-400" />
              <h3 className="text-lg font-semibold text-white">
                未分配员工 ({unassignedAgents.length})
              </h3>
            </div>
            
            <div className="space-y-2">
              {unassignedAgents.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-4">
                  所有员工都已分配
                </div>
              ) : (
                unassignedAgents.map((agent) => (
                  <div
                    key={agent.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, agent.id)}
                    className="p-3 bg-gray-700 hover:bg-gray-600 rounded cursor-move transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold">
                        {agent.name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white truncate">
                          {agent.name}
                        </div>
                        <div className="text-xs text-gray-400 truncate">
                          {agent.description || '暂无描述'}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          
          {/* 提示 */}
          <div className="p-3 bg-gray-700 rounded text-xs text-gray-300 space-y-1">
            <div>💡 拖拽员工到画布中的部门节点</div>
            <div>💡 点击部门节点可以添加子部门</div>
            <div>💡 右键部门节点可以重命名或删除</div>
          </div>
        </div>
      </div>
      
      {/* 画布区域 */}
      <div className="flex-1 relative">
        <div ref={containerRef} className="w-full h-full" />
        
        {departments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <Building2 className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <div className="text-lg mb-2">还没有部门</div>
              <div className="text-sm">在左侧添加第一个部门开始构建组织架构</div>
            </div>
          </div>
        )}
      </div>
      
      {/* 重命名对话框 */}
      {editingDept && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-96">
            <h3 className="text-lg font-semibold text-white mb-4">重命名部门</h3>
            <input
              type="text"
              value={editingDept.name}
              onChange={(e) => setEditingDept({ ...editingDept, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && handleRenameDepartment()}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-blue-500 mb-4"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setEditingDept(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleRenameDepartment}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
