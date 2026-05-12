import { invokeIpc } from '@/lib/api-client';

const DEFAULT_API_URL = 'https://im.shadanai.com/api';

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

async function getBoxImAuth(): Promise<{ tokenKey: string | null; apiUrl: string }> {
  try {
    const result = await invokeIpc<{
      tokenKey?: string | null;
      apiUrl?: string | null;
    } | null>('box-im:getConfig');

    return {
      tokenKey: result?.tokenKey ?? null,
      apiUrl: (result?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ''),
    };
  } catch (error) {
    console.warn('[organization] Failed to get full BoxIM config, falling back to tokenKey:', error);
    try {
      const tokenKey = await invokeIpc<string | null>('box-im:getTokenKey');
      return { tokenKey, apiUrl: DEFAULT_API_URL };
    } catch (tokenError) {
      console.error('[organization] Failed to get tokenKey:', tokenError);
      return { tokenKey: null, apiUrl: DEFAULT_API_URL };
    }
  }
}

export async function getOrganization(): Promise<ApiResponse<OrganizationData>> {
  const { tokenKey, apiUrl } = await getBoxImAuth();

  const response = await fetch(`${apiUrl}/organization/get`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': tokenKey || '',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export async function saveOrganization(canvasData: string, version: number): Promise<ApiResponse<OrganizationData>> {
  const { tokenKey, apiUrl } = await getBoxImAuth();

  const response = await fetch(`${apiUrl}/organization/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': tokenKey || '',
    },
    body: JSON.stringify({ canvasData, version }),
  });

  return response.json();
}

export async function checkOrganizationUpdate(version: number): Promise<ApiResponse<{ hasUpdate: boolean; latestVersion: number }>> {
  const { tokenKey, apiUrl } = await getBoxImAuth();

  const response = await fetch(`${apiUrl}/organization/check-update?version=${version}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': tokenKey || '',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}
