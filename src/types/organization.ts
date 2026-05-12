export type ParentType = 'dept' | 'bot';

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  parentType?: ParentType;
}

export interface Assignment {
  [botId: string]: string;
}

export interface NodeRelation {
  childId: string;
  childType: ParentType;
  parentId: string;
  parentType: ParentType;
}

export interface OrgData {
  departments: Department[];
  assignments: Assignment;
  relations?: NodeRelation[];
}
