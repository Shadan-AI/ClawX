import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Department, Assignment, OrgData } from '../types/organization';

interface OrganizationState {
  departments: Department[];
  assignments: Assignment;
  
  // 部门操作
  addDepartment: (name: string, parentId: string | null) => string;
  updateDepartment: (id: string, name: string) => void;
  deleteDepartment: (id: string) => void;
  
  // 员工分配操作
  assignAgent: (botId: string, deptId: string) => void;
  unassignAgent: (botId: string) => void;
  
  // 批量操作
  loadOrgData: (data: OrgData) => void;
  clearAll: () => void;
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
      departments: [],
      assignments: {},
      
      addDepartment: (name: string, parentId: string | null) => {
        const id = `dept-${Date.now()}`;
        set((state) => ({
          departments: [...state.departments, { id, name, parentId }],
        }));
        return id;
      },
      
      updateDepartment: (id: string, name: string) => {
        set((state) => ({
          departments: state.departments.map((dept) =>
            dept.id === id ? { ...dept, name } : dept
          ),
        }));
      },
      
      deleteDepartment: (id: string) => {
        const { departments, assignments } = get();
        
        // 找到所有子部门
        const childIds = new Set<string>();
        const findChildren = (parentId: string) => {
          departments.forEach((dept) => {
            if (dept.parentId === parentId) {
              childIds.add(dept.id);
              findChildren(dept.id);
            }
          });
        };
        findChildren(id);
        
        // 删除部门及其子部门
        const idsToDelete = new Set([id, ...childIds]);
        const newDepartments = departments.filter((dept) => !idsToDelete.has(dept.id));
        
        // 取消分配到这些部门的员工
        const newAssignments = { ...assignments };
        Object.keys(newAssignments).forEach((botId) => {
          if (idsToDelete.has(newAssignments[botId])) {
            delete newAssignments[botId];
          }
        });
        
        set({ departments: newDepartments, assignments: newAssignments });
      },
      
      assignAgent: (botId: string, deptId: string) => {
        set((state) => ({
          assignments: { ...state.assignments, [botId]: deptId },
        }));
      },
      
      unassignAgent: (botId: string) => {
        set((state) => {
          const newAssignments = { ...state.assignments };
          delete newAssignments[botId];
          return { assignments: newAssignments };
        });
      },
      
      loadOrgData: (data: OrgData) => {
        set({
          departments: data.departments,
          assignments: data.assignments,
        });
      },
      
      clearAll: () => {
        set({ departments: [], assignments: {} });
      },
    }),
    {
      name: 'organization-storage',
    }
  )
);
