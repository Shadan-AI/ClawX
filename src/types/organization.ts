/**
 * 组织架构类型定义
 */

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
}

export interface Assignment {
  [botId: string]: string; // botId -> deptId
}

export interface OrgData {
  departments: Department[];
  assignments: Assignment;
}
