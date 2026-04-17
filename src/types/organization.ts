/**
 * 组织架构类型定义
 */

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  parentType?: 'dept' | 'bot'; // 父节点类型
}

export interface Assignment {
  [botId: string]: string; // botId -> deptId or parentBotId
}

// 新增：节点关系类型
export interface NodeRelation {
  childId: string;
  childType: 'dept' | 'bot';
  parentId: string;
  parentType: 'dept' | 'bot';
}

export interface OrgData {
  departments: Department[];
  assignments: Assignment;
  relations?: NodeRelation[]; // 新增：节点关系
}
