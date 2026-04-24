import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Department, Assignment, OrgData, NodeRelation } from '../types/organization';
import { getOrganization, saveOrganization } from '../api/organization';
import { toast } from 'sonner';

interface OrganizationState {
  departments: Department[];
  assignments: Assignment;
  relations: NodeRelation[]; // 新增：节点关系
  isLoading: boolean;
  isSaving: boolean;
  
  // 部门操作
  addDepartment: (name: string, parentId: string | null, parentType?: 'dept' | 'bot') => string;
  updateDepartment: (id: string, name: string) => void;
  deleteDepartment: (id: string) => void;
  moveDepartment: (deptId: string, newParentId: string | null, newParentType?: 'dept' | 'bot') => void;
  
  // 员工分配操作
  assignAgent: (botId: string, parentId: string, parentType?: 'dept' | 'bot') => void;
  unassignAgent: (botId: string) => void;
  
  // 批量操作
  loadOrgData: (data: OrgData) => void;
  clearAll: () => void;
  
  // 服务器同步
  loadFromServer: () => Promise<void>;
  saveToServer: () => Promise<void>;
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
      departments: [],
      assignments: {},
      relations: [],
      isLoading: false,
      isSaving: false,
      
      addDepartment: (name: string, parentId: string | null, parentType: 'dept' | 'bot' = 'dept') => {
        const id = `dept-${Date.now()}`;
        const newDept: Department = { 
          id, 
          name, 
          parentId,
          parentType: parentId ? parentType : undefined
        };
        
        set((state) => {
          const newRelations = parentId 
            ? [...state.relations, { childId: id, childType: 'dept', parentId, parentType }]
            : state.relations;
          
          return {
            departments: [...state.departments, newDept],
            relations: newRelations,
          };
        });
        return id;
      },
      
      updateDepartment: (id: string, name: string) => {
        set((state) => ({
          departments: state.departments.map((dept) =>
            dept.id === id ? { ...dept, name } : dept
          ),
        }));
      },
      
      moveDepartment: (deptId: string, newParentId: string | null, newParentType: 'dept' | 'bot' = 'dept') => {
        set((state) => {
          // 检查是否会造成循环引用
          const wouldCreateCycle = (targetId: string | null, sourceId: string): boolean => {
            if (!targetId) return false;
            if (targetId === sourceId) return true;
            
            const parent = state.departments.find(d => d.id === targetId);
            if (!parent || !parent.parentId) return false;
            
            return wouldCreateCycle(parent.parentId, sourceId);
          };
          
          if (wouldCreateCycle(newParentId, deptId)) {
            return state; // 不允许循环引用
          }
          
          // 更新部门的父级
          const newDepartments = state.departments.map((dept) =>
            dept.id === deptId 
              ? { ...dept, parentId: newParentId, parentType: newParentId ? newParentType : undefined }
              : dept
          );
          
          // 更新关系
          const newRelations = state.relations.filter((rel) => rel.childId !== deptId);
          if (newParentId) {
            newRelations.push({
              childId: deptId,
              childType: 'dept',
              parentId: newParentId,
              parentType: newParentType,
            });
          }
          
          return {
            departments: newDepartments,
            relations: newRelations,
          };
        });
      },
      
      deleteDepartment: (id: string) => {
        const { departments, assignments, relations } = get();
        
        // 找到所有子节点（部门和员工）
        const childIds = new Set<string>();
        const findChildren = (parentId: string) => {
          // 查找子部门
          departments.forEach((dept) => {
            if (dept.parentId === parentId) {
              childIds.add(dept.id);
              findChildren(dept.id);
            }
          });
          
          // 查找子员工
          relations.forEach((rel) => {
            if (rel.parentId === parentId && rel.childType === 'bot') {
              childIds.add(rel.childId);
            }
          });
        };
        findChildren(id);
        
        // 删除部门及其子部门
        const idsToDelete = new Set([id, ...childIds]);
        const newDepartments = departments.filter((dept) => !idsToDelete.has(dept.id));
        
        // 取消分配到这些节点的员工
        const newAssignments = { ...assignments };
        Object.keys(newAssignments).forEach((botId) => {
          if (idsToDelete.has(newAssignments[botId])) {
            delete newAssignments[botId];
          }
        });
        
        // 删除相关的关系
        const newRelations = relations.filter(
          (rel) => !idsToDelete.has(rel.parentId) && !idsToDelete.has(rel.childId)
        );
        
        set({ departments: newDepartments, assignments: newAssignments, relations: newRelations });
      },
      
      assignAgent: (botId: string, parentId: string, parentType: 'dept' | 'bot' = 'dept') => {
        set((state) => {
          // 移除旧的关系
          const newRelations = state.relations.filter((rel) => rel.childId !== botId);
          
          // 添加新的关系
          newRelations.push({
            childId: botId,
            childType: 'bot',
            parentId,
            parentType,
          });
          
          return {
            assignments: { ...state.assignments, [botId]: parentId },
            relations: newRelations,
          };
        });
      },
      
      unassignAgent: (botId: string) => {
        set((state) => {
          const newAssignments = { ...state.assignments };
          delete newAssignments[botId];
          
          // 移除相关的关系
          const newRelations = state.relations.filter((rel) => rel.childId !== botId);
          
          return { 
            assignments: newAssignments,
            relations: newRelations,
          };
        });
      },
      
      loadOrgData: (data: OrgData) => {
        set({
          departments: data.departments,
          assignments: data.assignments,
          relations: data.relations || [],
        });
      },
      
      clearAll: () => {
        set({ departments: [], assignments: {}, relations: [] });
      },
      
      // 从服务器加载
      loadFromServer: async () => {
        set({ isLoading: true });
        try {
          const response = await getOrganization();
          if (response.code === 200 && response.data) {
            const canvasData = response.data.canvasData;
            if (canvasData && canvasData !== '{}') {
              const data: OrgData = JSON.parse(canvasData);
              set({
                departments: data.departments || [],
                assignments: data.assignments || {},
                relations: data.relations || [],
              });
            }
          }
        } catch (error) {
          console.error('加载组织架构失败:', error);
          toast.error('加载组织架构失败');
        } finally {
          set({ isLoading: false });
        }
      },
      
      // 保存到服务器
      saveToServer: async () => {
        const { departments, assignments, relations } = get();
        set({ isSaving: true });
        try {
          const data: OrgData = { departments, assignments, relations };
          const canvasData = JSON.stringify(data);
          const response = await saveOrganization(canvasData);
          if (response.code === 200) {
            toast.success('保存成功');
          } else {
            toast.error('保存失败');
          }
        } catch (error) {
          console.error('保存组织架构失败:', error);
          toast.error('保存失败');
        } finally {
          set({ isSaving: false });
        }
      },
    }),
    {
      name: 'organization-storage',
    }
  )
);
