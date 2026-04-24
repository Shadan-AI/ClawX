import request from './request';

export interface OrganizationData {
  id?: number;
  ownerId?: number;
  canvasData: string;
  createdTime?: string;
  updatedTime?: string;
}

/**
 * 获取组织架构
 */
export function getOrganization() {
  return request<OrganizationData>({
    url: '/organization/get',
    method: 'GET',
  });
}

/**
 * 保存组织架构
 */
export function saveOrganization(canvasData: string) {
  return request<OrganizationData>({
    url: '/organization/save',
    method: 'POST',
    data: { canvasData },
  });
}
