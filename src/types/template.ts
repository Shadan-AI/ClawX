/**
 * Employee Template Types
 * 数字员工模板类型定义
 */

export interface EmployeeTemplate {
  /** 模板唯一标识 */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 模板图标（emoji） */
  icon: string;
  /** 包含的技能ID列表 */
  skills: string[];
  /** 推荐的模型ID */
  model?: string;
  /** 是否为官方模板 */
  isOfficial: boolean;
  /** 模板分类 */
  category?: 'customer-service' | 'technical' | 'creative' | 'analysis' | 'general';
}
