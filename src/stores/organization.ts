import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { toast } from 'sonner';
import { checkOrganizationUpdate, getOrganization, saveOrganization } from '../api/organization';
import type { Assignment, Department, NodeRelation, OrgData, ParentType } from '../types/organization';

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
  hasLoadedFromServer: boolean;
  serverHasData: boolean;
  syncStatus: 'idle' | 'syncing' | 'saved' | 'error' | 'conflict';
  lastSyncError: string | null;
  addDepartment: (name: string, parentId: string | null, parentType?: ParentType) => string;
  updateDepartment: (id: string, name: string) => void;
  deleteDepartment: (id: string) => void;
  moveDepartment: (deptId: string, newParentId: string | null, newParentType?: ParentType) => void;
  assignAgent: (botId: string, parentId: string, parentType?: ParentType) => void;
  unassignAgent: (botId: string) => void;
  loadOrgData: (data: OrgData) => void;
  clearAll: () => void;
  loadFromServer: () => Promise<void>;
  saveToServer: (force?: boolean) => Promise<void>;
  checkUpdate: () => Promise<void>;
  startSync: () => void;
  stopSync: () => void;
  markDirty: () => void;
  startAutoSave: () => void;
  stopAutoSave: () => void;
}

const ORG_SYNC_CLEANUP_KEY = '__orgSyncCleanup';
const ORG_AUTOSAVE_TIMER_KEY = '__orgAutoSaveTimer';
const ORG_AUTOSAVE_SCHEDULE_KEY = '__orgScheduleAutoSave';
const ORG_AUTOSAVE_DELAY_MS = 800;

function nodeKey(type: ParentType | 'bot', id: string): string {
  return `${type}:${id}`;
}

function uniqueDepartments(input: Department[]): Department[] {
  const seen = new Set<string>();
  const result: Department[] = [];
  for (const dept of input) {
    if (!dept?.id || seen.has(dept.id)) continue;
    seen.add(dept.id);
    result.push({
      id: dept.id,
      name: (dept.name || '未命名部门').trim() || '未命名部门',
      parentId: dept.parentId ?? null,
      parentType: dept.parentId ? 'dept' : undefined,
    });
  }
  return result;
}

function buildRelations(departments: Department[], assignments: Assignment): NodeRelation[] {
  const relations: NodeRelation[] = [];

  for (const dept of departments) {
    if (!dept.parentId) continue;
    relations.push({
      childId: dept.id,
      childType: 'dept',
      parentId: dept.parentId,
      parentType: 'dept',
    });
  }

  for (const [botId, parentId] of Object.entries(assignments)) {
    if (!botId || !parentId) continue;
    relations.push({
      childId: botId,
      childType: 'bot',
      parentId,
      parentType: 'dept',
    });
  }

  return relations;
}

function normalizeOrgData(data: Partial<OrgData> | null | undefined): OrgData {
  const departments = uniqueDepartments(Array.isArray(data?.departments) ? data!.departments : []);
  const deptIds = new Set(departments.map((dept) => dept.id));
  const sanitizedDepartments = departments.map((dept) => {
    if (!dept.parentId || deptIds.has(dept.parentId)) {
      return dept;
    }
    return { ...dept, parentId: null, parentType: undefined };
  });
  const sanitizedDeptIds = new Set(sanitizedDepartments.map((dept) => dept.id));
  const assignments: Assignment = {};

  for (const [botId, parentId] of Object.entries(data?.assignments ?? {})) {
    if (typeof botId !== 'string' || !botId.trim()) continue;
    if (typeof parentId !== 'string' || !parentId.trim()) continue;
    assignments[botId] = parentId;
  }

  for (const relation of data?.relations ?? []) {
    if (!relation || relation.childType !== 'bot') continue;
    if (relation.childId && relation.parentId && !assignments[relation.childId]) {
      assignments[relation.childId] = relation.parentId;
    }
  }

  const sanitizedAssignments: Assignment = {};
  for (const [botId, parentId] of Object.entries(assignments)) {
    if (typeof parentId === 'string' && sanitizedDeptIds.has(parentId)) {
      sanitizedAssignments[botId] = parentId;
    }
  }

  return {
    departments: sanitizedDepartments,
    assignments: sanitizedAssignments,
    relations: buildRelations(sanitizedDepartments, sanitizedAssignments),
  };
}

function parseCanvasData(canvasData?: string | null): OrgData {
  if (!canvasData || canvasData === '{}') {
    return normalizeOrgData({ departments: [], assignments: {}, relations: [] });
  }
  return normalizeOrgData(JSON.parse(canvasData) as OrgData);
}

function isOrgDataEmpty(data: OrgData): boolean {
  return data.departments.length === 0 && Object.keys(data.assignments).length === 0;
}

function getWindowRegistry(): Window & Record<string, unknown> {
  return window as unknown as Window & Record<string, unknown>;
}

function buildParentMap(departments: Department[], assignments: Assignment): Map<string, string> {
  const map = new Map<string, string>();

  for (const dept of departments) {
    if (!dept.parentId) continue;
    map.set(nodeKey('dept', dept.id), nodeKey('dept', dept.parentId));
  }

  for (const [botId, parentId] of Object.entries(assignments)) {
    map.set(nodeKey('bot', botId), nodeKey('dept', parentId));
  }

  return map;
}

function wouldCreateCycle(
  childId: string,
  childType: 'dept' | 'bot',
  parentId: string | null,
  parentType: ParentType | undefined,
  departments: Department[],
  assignments: Assignment,
): boolean {
  if (!parentId || !parentType) return false;
  const target = nodeKey(childType, childId);
  let current = nodeKey(parentType, parentId);
  const parentMap = buildParentMap(departments, assignments);
  const visited = new Set<string>();

  while (current) {
    if (current === target) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentMap.get(current) ?? '';
  }

  return false;
}

function collectDepartmentSubtree(
  rootDeptId: string,
  departments: Department[],
  assignments: Assignment,
): { departmentIds: Set<string>; botIds: Set<string> } {
  const departmentIds = new Set<string>();
  const botIds = new Set<string>();
  const deptChildren = new Map<string, string[]>();
  const botChildren = new Map<string, string[]>();

  for (const dept of departments) {
    if (!dept.parentId) continue;
    const list = deptChildren.get(dept.parentId) ?? [];
    list.push(dept.id);
    deptChildren.set(dept.parentId, list);
  }

  for (const [botId, parentId] of Object.entries(assignments)) {
    if (!parentId) continue;
    const list = botChildren.get(parentId) ?? [];
    list.push(botId);
    botChildren.set(parentId, list);
  }

  const walkDept = (deptId: string) => {
    if (departmentIds.has(deptId)) return;
    departmentIds.add(deptId);
    for (const childDeptId of deptChildren.get(deptId) ?? []) {
      walkDept(childDeptId);
    }
    for (const childBotId of botChildren.get(deptId) ?? []) {
      walkBot(childBotId);
    }
  };

  const walkBot = (botId: string) => {
    if (botIds.has(botId)) return;
    botIds.add(botId);
    for (const childBotId of botChildren.get(botId) ?? []) {
      walkBot(childBotId);
    }
  };

  walkDept(rootDeptId);
  return { departmentIds, botIds };
}

function scheduleAutoSaveFromWindow(): void {
  const schedule = getWindowRegistry()[ORG_AUTOSAVE_SCHEDULE_KEY];
  if (typeof schedule === 'function') {
    (schedule as () => void)();
  }
}

function makeStatePatch(departments: Department[], assignments: Assignment) {
  return {
    departments,
    assignments,
    relations: buildRelations(departments, assignments),
    hasLocalChanges: true,
  };
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
      hasLoadedFromServer: false,
      serverHasData: false,
      syncStatus: 'idle',
      lastSyncError: null,

      addDepartment: (name, parentId, _parentType = 'dept') => {
        const trimmedName = name.trim() || '未命名部门';
        const id = `dept-${Date.now()}`;
        set((state) => {
          const validParentId = parentId && state.departments.some((dept) => dept.id === parentId) ? parentId : null;
          const nextDepartments = [
            ...state.departments,
            {
              id,
              name: trimmedName,
              parentId: validParentId,
              parentType: validParentId ? ('dept' as const) : undefined,
            },
          ];
          return makeStatePatch(nextDepartments, state.assignments);
        });
        scheduleAutoSaveFromWindow();
        return id;
      },

      updateDepartment: (id, name) => {
        const trimmedName = name.trim() || '未命名部门';
        set((state) => makeStatePatch(
          state.departments.map((dept) => (dept.id === id ? { ...dept, name: trimmedName } : dept)),
          state.assignments,
        ));
        scheduleAutoSaveFromWindow();
      },

      deleteDepartment: (id) => {
        const state = get();
        const { departmentIds, botIds } = collectDepartmentSubtree(id, state.departments, state.assignments);
        const nextDepartments = state.departments.filter((dept) => !departmentIds.has(dept.id));
        const nextAssignments: Assignment = {};

        for (const [botId, parentId] of Object.entries(state.assignments)) {
          if (botIds.has(botId)) continue;
          if (departmentIds.has(parentId) || botIds.has(parentId)) continue;
          nextAssignments[botId] = parentId;
        }

        set(makeStatePatch(nextDepartments, nextAssignments));
        scheduleAutoSaveFromWindow();
      },

      moveDepartment: (deptId, newParentId, _newParentType = 'dept') => {
        const state = get();
        const validParentId = newParentId && state.departments.some((dept) => dept.id === newParentId) ? newParentId : null;
        if (wouldCreateCycle(deptId, 'dept', validParentId, validParentId ? 'dept' : undefined, state.departments, state.assignments)) {
          toast.error('不能把部门移动到自己的下级节点下面');
          return;
        }
        const nextDepartments = state.departments.map((dept) => (
          dept.id === deptId
            ? { ...dept, parentId: validParentId, parentType: validParentId ? ('dept' as const) : undefined }
            : dept
        ));
        set(makeStatePatch(nextDepartments, state.assignments));
        scheduleAutoSaveFromWindow();
      },

      assignAgent: (botId, parentId, _parentType = 'dept') => {
        const state = get();
        if (!state.departments.some((dept) => dept.id === parentId)) {
          toast.error('请将员工分配到部门节点');
          return;
        }
        const nextAssignments = { ...state.assignments, [botId]: parentId };
        set(makeStatePatch(state.departments, nextAssignments));
        scheduleAutoSaveFromWindow();
      },

      unassignAgent: (botId) => {
        const nextAssignments = { ...get().assignments };
        delete nextAssignments[botId];
        set(makeStatePatch(get().departments, nextAssignments));
        scheduleAutoSaveFromWindow();
      },

      loadOrgData: (data) => {
        const normalized = normalizeOrgData(data);
        set({
          departments: normalized.departments,
          assignments: normalized.assignments,
          relations: normalized.relations ?? [],
          hasLocalChanges: false,
        });
      },

      clearAll: () => {
        set({
          departments: [],
          assignments: {},
          relations: [],
          hasLocalChanges: true,
        });
        scheduleAutoSaveFromWindow();
      },

      loadFromServer: async () => {
        set({ isLoading: true, syncStatus: 'syncing', lastSyncError: null });
        try {
          const response = await getOrganization();
          if (response.code !== 200) {
            const message = response.message || '加载组织架构失败';
            set({ isLoading: false, syncStatus: 'error', lastSyncError: message });
            if (response.code !== 400) {
              toast.error(message);
            }
            return;
          }

          const parsed = parseCanvasData(response.data?.canvasData);
          set({
            departments: parsed.departments,
            assignments: parsed.assignments,
            relations: parsed.relations ?? [],
            version: response.data?.version ?? 0,
            lastSyncTime: Date.now(),
            hasLocalChanges: false,
            hasLoadedFromServer: true,
            serverHasData: !isOrgDataEmpty(parsed),
            syncStatus: 'saved',
            lastSyncError: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '网络错误';
          console.error('[organization] load failed:', error);
          set({ syncStatus: 'error', lastSyncError: message });
          toast.error('加载组织架构失败');
        } finally {
          set({ isLoading: false });
        }
      },

      saveToServer: async (force = false) => {
        const state = get();
        if (!state.hasLocalChanges && !force) return;

        if (!state.hasLoadedFromServer) {
          const message = '组织架构尚未从服务器加载完成，已阻止保存';
          set({ syncStatus: 'error', lastSyncError: message });
          toast.error(message);
          return;
        }

        try {
          const data = normalizeOrgData({
            departments: state.departments,
            assignments: state.assignments,
            relations: state.relations,
          });

          if (state.serverHasData && isOrgDataEmpty(data)) {
            const message = '已阻止空组织架构覆盖服务器已有数据，请刷新后再操作';
            set({ syncStatus: 'error', lastSyncError: message });
            toast.error(message);
            return;
          }

          if (!state.serverHasData && isOrgDataEmpty(data)) {
            set({
              hasLocalChanges: false,
              syncStatus: 'saved',
              lastSyncError: null,
            });
            return;
          }

          set({ isSaving: true, syncStatus: 'syncing', lastSyncError: null });
          let version = state.version;

          if (force) {
            const latest = await getOrganization();
            if (latest.code === 200 && latest.data) {
              version = latest.data.version;
            }
          }

          const response = await saveOrganization(JSON.stringify(data), version);
          if (response.code === 200) {
            set({
              relations: data.relations ?? [],
              version: response.data.version,
              lastSyncTime: Date.now(),
              hasLocalChanges: false,
              serverHasData: !isOrgDataEmpty(data),
              syncStatus: 'saved',
              lastSyncError: null,
            });
            return;
          }

          if (response.code === 409) {
            set({ syncStatus: 'conflict', lastSyncError: '组织架构已在其他端被修改' });
            toast.error('组织架构已在其他端被修改', {
              duration: 5000,
              action: {
                label: '强制保存',
                onClick: () => {
                  void get().saveToServer(true);
                },
              },
            });
            return;
          }

          const message = response.message || '保存失败';
          set({ syncStatus: 'error', lastSyncError: message });
          toast.error(message);
        } catch (error) {
          console.error('[organization] save failed:', error);
          set({ syncStatus: 'error', lastSyncError: '网络错误' });
          toast.error('保存组织架构失败');
        } finally {
          set({ isSaving: false });
        }
      },

      checkUpdate: async () => {
        const state = get();
        if (state.isSyncing || state.isSaving) return;

        set({ isSyncing: true });
        try {
          const response = await checkOrganizationUpdate(state.version);
          if (response.code === 200 && response.data.hasUpdate) {
            if (state.hasLocalChanges) {
              set({ syncStatus: 'conflict', lastSyncError: '服务端有更新，当前页面也有未保存修改' });
              toast.warning('服务端有新的组织架构变更，请先处理冲突');
            } else {
              await get().loadFromServer();
            }
          }
        } catch (error) {
          console.error('[organization] check update failed:', error);
        } finally {
          set({ isSyncing: false });
        }
      },

      startSync: () => {
        const win = getWindowRegistry();
        const oldCleanup = win[ORG_SYNC_CLEANUP_KEY];
        if (typeof oldCleanup === 'function') {
          (oldCleanup as () => void)();
        }

        const checkNow = () => {
          if (!document.hidden && !get().hasLocalChanges) {
            void get().checkUpdate();
          }
        };

        document.addEventListener('visibilitychange', checkNow);
        window.addEventListener('focus', checkNow);
        win[ORG_SYNC_CLEANUP_KEY] = () => {
          document.removeEventListener('visibilitychange', checkNow);
          window.removeEventListener('focus', checkNow);
        };
      },

      stopSync: () => {
        const win = getWindowRegistry();
        const cleanup = win[ORG_SYNC_CLEANUP_KEY];
        if (typeof cleanup === 'function') {
          (cleanup as () => void)();
          delete win[ORG_SYNC_CLEANUP_KEY];
        }
      },

      markDirty: () => {
        set({ hasLocalChanges: true });
      },

      startAutoSave: () => {
        const win = getWindowRegistry();
        win[ORG_AUTOSAVE_SCHEDULE_KEY] = () => {
          const currentTimer = win[ORG_AUTOSAVE_TIMER_KEY];
          if (typeof currentTimer === 'number') {
            window.clearTimeout(currentTimer);
          }
          win[ORG_AUTOSAVE_TIMER_KEY] = window.setTimeout(() => {
            const state = get();
            if (state.hasLocalChanges && !state.isSaving) {
              void state.saveToServer();
            }
          }, ORG_AUTOSAVE_DELAY_MS);
        };
      },

      stopAutoSave: () => {
        const win = getWindowRegistry();
        const timer = win[ORG_AUTOSAVE_TIMER_KEY];
        if (typeof timer === 'number') {
          window.clearTimeout(timer);
          delete win[ORG_AUTOSAVE_TIMER_KEY];
        }
        delete win[ORG_AUTOSAVE_SCHEDULE_KEY];
      },
    }),
    {
      name: 'organization-storage',
      partialize: (state) => ({
        departments: state.departments,
        assignments: state.assignments,
        relations: state.relations,
        version: state.version,
        lastSyncTime: state.lastSyncTime,
      }),
    },
  ),
);
