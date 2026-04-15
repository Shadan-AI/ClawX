/**
 * Official Employee Templates
 * 官方数字员工模板定义
 */

import type { EmployeeTemplate } from '@/types/template';

export const OFFICIAL_TEMPLATES: EmployeeTemplate[] = [
  {
    id: 'customer-service',
    name: '客服助手',
    description: '专业的客户服务，处理咨询、投诉和售后问题',
    icon: '👨‍💼',
    skills: [
      'web-search',
      'knowledge-base',
      'email',
      'calendar',
    ],
    model: 'glm-5',
    isOfficial: true,
    category: 'customer-service',
  },
  {
    id: 'tech-support',
    name: '技术支持',
    description: '解决技术问题，提供专业的技术指导和故障排查',
    icon: '🔧',
    skills: [
      'code-interpreter',
      'web-search',
      'file-analysis',
      'database-query',
    ],
    model: 'claude-sonnet-4-5-20250929',
    isOfficial: true,
    category: 'technical',
  },
  {
    id: 'content-creator',
    name: '内容创作',
    description: '创作文章、文案、社交媒体内容和营销材料',
    icon: '✍️',
    skills: [
      'web-search',
      'image-generation',
      'file-operations',
    ],
    model: 'glm-5',
    isOfficial: true,
    category: 'creative',
  },
  {
    id: 'data-analyst',
    name: '数据分析',
    description: '分析数据、生成报表、可视化展示和洞察发现',
    icon: '📊',
    skills: [
      'code-interpreter',
      'file-analysis',
      'database-query',
      'chart-generation',
    ],
    model: 'claude-sonnet-4-5-20250929',
    isOfficial: true,
    category: 'analysis',
  },
  {
    id: 'sales-consultant',
    name: '销售顾问',
    description: '产品推荐、客户跟进、销售数据分析',
    icon: '💼',
    skills: [
      'web-search',
      'email',
      'calendar',
      'database-query',
    ],
    model: 'glm-5',
    isOfficial: true,
    category: 'customer-service',
  },
  {
    id: 'research-assistant',
    name: '研究助手',
    description: '文献检索、资料整理、研究报告撰写',
    icon: '🔬',
    skills: [
      'web-search',
      'file-analysis',
      'file-operations',
      'knowledge-base',
    ],
    model: 'claude-sonnet-4-5-20250929',
    isOfficial: true,
    category: 'analysis',
  },
  {
    id: 'general-assistant',
    name: '通用助手',
    description: '全能型助手，适合各种日常任务',
    icon: '🤖',
    skills: [
      'web-search',
      'file-operations',
      'calendar',
    ],
    model: 'glm-5',
    isOfficial: true,
    category: 'general',
  },
];

/**
 * 根据ID获取模板
 */
export function getTemplateById(id: string): EmployeeTemplate | undefined {
  return OFFICIAL_TEMPLATES.find(t => t.id === id);
}

/**
 * 根据分类获取模板列表
 */
export function getTemplatesByCategory(category: EmployeeTemplate['category']): EmployeeTemplate[] {
  return OFFICIAL_TEMPLATES.filter(t => t.category === category);
}
