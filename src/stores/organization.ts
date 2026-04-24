import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Department, Assignment, OrgData, NodeRelation } from '../types/organization';
import { getOrganization, saveOrganization, checkOrganizationUpdate } from '../api/organization';
import { toast } from 'sonner';

interface OrganizationState {
  departments: Department[];
  assignments: Assignment;
  relations: NodeRelation[];
  version: number;
  lastSyncTime: number;
  hasLocalChanges: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isSyncing: boolean;
  syncStatus: 'idle' | 'syncing' | 'saved' | 'error' | 'conflict';
  lastSyncError: string | null;
  
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
  saveToServer: (force?: boolean) => Promise<void>;
  checkUpdate: () => Promise<void>;
  startSync: () => void;
  stopSync: () => void;
  markDirty: () => void;
  startAutoSave: () => void;
  stopAutoSave: () => void;
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
      departments: [],
      assignments: {},
      relations: [],
      version: 0,
      lastSyncTime: 0,
      hasLocalChanges: false,
      isLoading: false,
      isSaving: false,
      isSyncing: false,
      syncStatus: 'idle',
      lastSyncError: null,
      
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
            hasLocalChanges: true,
          };
        });
        
        // 触发自动保存
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
        
        return id;
      },
      
      updateDepartment: (id: string, name: string) => {
        set((state) => ({
          departments: state.departments.map((dept) =>
            dept.id === id ? { ...dept, name } : dept
          ),
          hasLocalChanges: true,
        }));
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
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
            hasLocalChanges: true,
          };
        });
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
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
        
        set({ departments: newDepartments, assignments: newAssignments, relations: newRelations, hasLocalChanges: true });
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
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
            hasLocalChanges: true,
          };
        });
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
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
            hasLocalChanges: true,
          };
        });
        const schedule = (window as any).__orgScheduleAutoSave;
        if (schedule) schedule();
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
        set({ isLoading: true, syncStatus: 'syncing' });
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
                version: response.data.version,
                lastSyncTime: Date.now(),
                hasLocalChanges: false,
                syncStatus: 'saved',
                lastSyncError: null,
              });
            }
          }
        } catch (error) {
          console.error('加载组织架构失败:', error);
          set({ syncStatus: 'error', lastSyncError: '加载失败' });
          toast.error('加载组织架构失败');
        } finally {
          set({ isLoading: false });
        }
      },
      
      // 保存到服务器
      saveToServer: async (force = false) => {
        const { departments, assignments, relations, version } = get();
        set({ isSaving: true, syncStatus: 'syncing' });
        try {
          const data: OrgData = { departments, assignments, relations };
          const canvasData = JSON.stringify(data);
          
          // 如果是强制保存,先获取最新版本号
          let saveVersion = version;
          if (force) {
            const latest = await getOrganization();
            if (latest.code === 200 && latest.data) {
              saveVersion = latest.data.version;
            }
          }
          
          const response = await saveOrganization(canvasData, saveVersion);
          
          if (response.code === 200) {
            set({ 
              version: response.data.version,
              lastSyncTime: Date.now(),
              hasLocalChanges: false,
              syncStatus: 'saved',
              lastSyncError: null,
            });
            // 不显示 toast,用状态指示器就够了
          } else if (response.code === 409) {
            // 版本冲突
            set({ syncStatus: 'conflict', lastSyncError: '数据已被其他端修改' });
            toast.error('数据已被其他端修改', {
              duration: 5000,
              action: {
                label: '强制保存',
                onClick: () => {
                  get().saveToServer(true);
                },
              },
            });
          } else {
            set({ syncStatus: 'error', lastSyncError: response.message || '保存失败' });
            toast.error(response.message || '保存失败');
          }
        } catch (error) {
          console.error('保存组织架构失败:', error);
          set({ syncStatus: 'error', lastSyncError: '网络错误' });
          toast.error('保存失败');
        } finally {
          set({ isSaving: false });
        }
      },
      
      // 检查更新
      checkUpdate: async () => {
        const { version, hasLocalChanges } = get();
        if (get().isSyncing) return;
        
        set({ isSyncing: true });
        try {
          const response = await checkOrganizationUpdate(version);
          if (response.code === 200 && response.data.hasUpdate) {
            if (hasLocalChanges) {
              // 有冲突,提示用户
              toast.warning('服务器数据已更新,但你有未保存的本地修改', {
                action: {
                  label: '查看',
                  onClick: () => {
                    // TODO: 显示冲突对话框
                    console.log('显示冲突对话框');
                  },
                },
              });
            } else {
              // 无冲突,自动更新
              await get().loadFromServer();
              toast.info('已同步最新数据');
            }
          }
        } catch (error) {
          console.error('检查更新失败:', error);
        } finally {
          set({ isSyncing: false });
        }
      },
      
      // 开始自动同步
      startSync: () => {
        // 清理旧的定时器
        const oldInterval = (window as any).__orgSyncInterval;
        if (oldInterval) {
          clearInterval(oldInterval);
        }
        
        let lastActivityTime = Date.now();
        
        // 监听用户活动
        const updateActivity = () => {
          lastActivityTime = Date.now();
        };
        
        // 监听鼠标和键盘活动
        document.addEventListener('mousedown', updateActivity);
        document.addEventListener('keydown', updateActivity);
        
        const syncInterval = setInterval(() => {
          // 只在以下条件都满足时才同步:
          // 1. 页面可见
          // 2. 用户至少 5 秒没有操作
          // 3. 没有正在保存
          const idleTime = Date.now() - lastActivityTime;
          const shouldSync = !document.hidden && idleTime > 5000 && !get().isSaving;
          
          if (shouldSync) {
            get().checkUpdate();
          }
        }, 10000); // 10秒检查一次
        
        // 保存到 window 对象
        (window as any).__orgSyncInterval = syncInterval;
        (window as any).__orgSyncCleanup = () => {
          document.removeEventListener('mousedown', updateActivity);
          document.removeEventListener('keydown', updateActivity);
        };
      },
      
      // 停止自动同步
      stopSync: () => {
        const syncInterval = (window as any).__orgSyncInterval;
        if (syncInterval) {
          clearInterval(syncInterval);
          delete (window as any).__orgSyncInterval;
        }
        
        const cleanup = (window as any).__orgSyncCleanup;
        if (cleanup) {
          cleanup();
          delete (window as any).__orgSyncCleanup;
        }
      },
      
      // 标记有本地修改
      markDirty: () => {
        set({ hasLocalChanges: true });
      },
      
      // 开始自动保存(2秒防抖)
      startAutoSave: () => {
        // 清理旧的定时器
        const oldTimer = (window as any).__orgAutoSaveTimer;
        if (oldTimer) {
          clearTimeout(oldTimer);
        }
        
        // 监听数据变化,自动保存
        const scheduleAutoSave = () => {
          const timer = (window as any).__orgAutoSaveTimer;
          if (timer) {
            clearTimeout(timer);
          }
          
          (window as any).__orgAutoSaveTimer = setTimeout(() => {
            const { hasLocalChanges, isSaving } = get();
            if (hasLocalChanges && !isSaving) {
              get().saveToServer();
            }
          }, 2000); // 2秒后自动保存
        };
        
        // 保存调度函数
        (window as any).__orgScheduleAutoSave = scheduleAutoSave;
      },
      
      // 停止自动保存
      stopAutoSave: () => {
        const timer = (window as any).__orgAutoSaveTimer;
        if (timer) {
          clearTimeout(timer);
          delete (window as any).__orgAutoSaveTimer;
        }
        delete (window as any).__orgScheduleAutoSave;
      },
    }),
    {
      name: 'organization-storage',
    }
  )
);
