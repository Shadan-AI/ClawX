/**
 * Self-hosted skill marketplace (aligned with openme gateway `skills.market.search`).
 * Base URL is fixed in ClawX — do not depend on openclaw.json env for search.
 */
export const SKILL_MARKET_BASE_URL = 'https://market.shadanai.com';

export async function fetchSkillMarketSearch(params: {
  q: string;
  page: number;
  limit: number;
}): Promise<{ results: unknown[]; total: number; page: number; limit: number }> {
  const url = new URL('/api/search', SKILL_MARKET_BASE_URL);
  url.searchParams.set('q', params.q);
  url.searchParams.set('page', String(params.page));
  url.searchParams.set('limit', String(params.limit));
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'clawx-host-api/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`技能市场不可用: ${res.status}`);
  }
  return (await res.json()) as { results: unknown[]; total: number; page: number; limit: number };
}
