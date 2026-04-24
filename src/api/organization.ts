const API_URL = 'https://im.shadanai.com/api';

export interface OrganizationData {
  id?: number;
  ownerId?: number;
  canvasData: string;
  version: number;
  createdTime?: string;
  updatedTime?: string;
}

interface ApiResponse<T> {
  code: number;
  data: T;
  message?: string;
}

/**
 * 获取 token
 */
function getToken(): string {
  // 从 localStorage 获取 tokenKey
  const tokenKey = localStorage.getItem('tokenKey');
  return tokenKey || '';
}

/**
 * 获取组织架构
 */
export async function getOrganization(): Promise<ApiResponse<OrganizationData>> {
  const token = getToken();
  
  const response = await fetch(`${API_URL}/organization/get`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': token,
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return response.json();
}

/**
 * 保存组织架构
 */
export async function saveOrganization(canvasData: string, version: number): Promise<ApiResponse<OrganizationData>> {
  const token = getToken();
  
  const response = await fetch(`${API_URL}/organization/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': token,
    },
    body: JSON.stringify({ canvasData, version }),
  });
  
  const data = await response.json();
  
  // 不管状态码,都返回 JSON,让调用方处理
  return data;
}

/**
 * 检查是否有更新
 */
export async function checkOrganizationUpdate(version: number): Promise<ApiResponse<{ hasUpdate: boolean; latestVersion: number }>> {
  const token = getToken();
  
  const response = await fetch(`${API_URL}/organization/check-update?version=${version}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': token,
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return response.json();
}
