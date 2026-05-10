/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { useGatewayStore } from './gateway';
import type { Skill, MarketplaceSkill } from '../types/skill';

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
  source?: string;
  baseDir?: string;
  filePath?: string;
  eligible?: boolean; // 技能是否可用(满足操作系统、依赖等要求)
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type ClawHubListResult = {
  slug: string;
  version?: string;
  source?: string;
  baseDir?: string;
};

/** Coalesce concurrent fetchSkills() (e.g. React Strict Mode + gateway state flips). */
let fetchSkillsInFlight: Promise<void> | null = null;
let lastFetchSkillsStartedAt = 0;
let lastFetchSkillsFailedAt = 0;

const FETCH_SKILLS_MIN_INTERVAL_MS = 1_500;
const FETCH_SKILLS_ERROR_COOLDOWN_MS = 10_000;

function mapErrorCodeToSkillErrorKey(
  code: AppError['code'],
  operation: 'fetch' | 'search' | 'install',
): string {
  if (code === 'TIMEOUT') {
    return operation === 'search'
      ? 'searchTimeoutError'
      : operation === 'install'
        ? 'installTimeoutError'
        : 'fetchTimeoutError';
  }
  if (code === 'RATE_LIMIT') {
    return operation === 'search'
      ? 'searchRateLimitError'
      : operation === 'install'
        ? 'installRateLimitError'
        : 'fetchRateLimitError';
  }
  return operation === 'search'
    ? 'searchFailed'
    : operation === 'install'
      ? 'installFailed'
      : 'fetchFailed';
}

/** Skill market row (gateway skills.market.search). */
export type MarketSkillRow = {
  slug: string;
  displayName: string;
  summary: string;
  installUrl?: string;
};

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  error: string | null;

  marketResults: MarketSkillRow[];
  marketLoading: boolean;
  marketError: string | null;
  marketTotal: number;
  marketPage: number;

  // Actions
  fetchSkills: (options?: { force?: boolean }) => Promise<void>;
  searchSkills: (query: string) => Promise<void>;
  searchMarketSkills: (query: string, append?: boolean) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  installMarketSkill: (slug: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  searchResults: [],
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  marketResults: [],
  marketLoading: false,
  marketError: null,
  marketTotal: 0,
  marketPage: 0,

  fetchSkills: async (options) => {
    const force = options?.force === true;
    if (fetchSkillsInFlight) {
      return fetchSkillsInFlight;
    }
    const now = Date.now();
    const state = get();
    if (!force && now - lastFetchSkillsStartedAt < FETCH_SKILLS_MIN_INTERVAL_MS) {
      return;
    }
    if (!force && state.error && now - lastFetchSkillsFailedAt < FETCH_SKILLS_ERROR_COOLDOWN_MS) {
      return;
    }
    const doFetch = async (): Promise<void> => {
      lastFetchSkillsStartedAt = Date.now();
      // Only show loading state if we have no skills yet (initial load)
      if (get().skills.length === 0) {
        set({ loading: true, error: null });
      }
      try {
        // 1. Fetch from Gateway (running skills)
        const gatewayData = await useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');

        // 2. Fetch from ClawHub (installed on disk)
        const clawhubResult = await hostApiFetch<{ success: boolean; results?: ClawHubListResult[]; error?: string }>('/api/clawhub/list');

        // 3. Fetch configurations directly from Electron (since Gateway doesn't return them)
        const configResult = await hostApiFetch<Record<string, { apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');

        let combinedSkills: Skill[] = [];
        const currentSkills = get().skills;

        // Map gateway skills info
        if (gatewayData.skills) {
          combinedSkills = gatewayData.skills.map((s: GatewaySkillStatus) => {
            // Merge with direct config if available
            const directConfig = configResult[s.skillKey] || {};

            return {
              id: s.skillKey,
              slug: s.slug || s.skillKey,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
              icon: s.emoji || '📦',
              version: s.version || '1.0.0',
              author: s.author,
              config: {
                ...(s.config || {}),
                ...directConfig,
              },
              isCore: s.bundled && s.always,
              isBundled: s.bundled,
              source: s.source,
              baseDir: s.baseDir,
              filePath: s.filePath,
            };
          });
        } else if (currentSkills.length > 0) {
          // ... if gateway down ...
          combinedSkills = [...currentSkills];
        }

        // Merge with ClawHub results
        if (clawhubResult.success && clawhubResult.results) {
          clawhubResult.results.forEach((cs: ClawHubListResult) => {
            const existing = combinedSkills.find(s => s.id === cs.slug);
            if (existing) {
              if (!existing.baseDir && cs.baseDir) {
                existing.baseDir = cs.baseDir;
              }
              if (!existing.source && cs.source) {
                existing.source = cs.source;
              }
              return;
            }
            const directConfig = configResult[cs.slug] || {};
            combinedSkills.push({
              id: cs.slug,
              slug: cs.slug,
              name: cs.slug,
              description: 'Recently installed, initializing...',
              enabled: false,
              icon: '⌛',
              version: cs.version || 'unknown',
              author: undefined,
              config: directConfig,
              isCore: false,
              isBundled: false,
              source: cs.source || 'openclaw-managed',
              baseDir: cs.baseDir,
            });
          });
        }

        lastFetchSkillsFailedAt = 0;
        set({ skills: combinedSkills, loading: false, error: null });
      } catch (error) {
        console.error('Failed to fetch skills:', error);
        const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
        lastFetchSkillsFailedAt = Date.now();
        set({ loading: false, error: mapErrorCodeToSkillErrorKey(appError.code, 'fetch') });
      } finally {
        fetchSkillsInFlight = null;
      }
    };
    fetchSkillsInFlight = doFetch();
    return fetchSkillsInFlight;
  },

  searchSkills: async (query: string) => {
    set({ searching: true, searchError: null });
    try {
      const result = await hostApiFetch<{ success: boolean; results?: MarketplaceSkill[]; error?: string }>('/api/clawhub/search', {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
      if (result.success) {
        set({ searchResults: result.results || [] });
      } else {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      set({ searchError: mapErrorCodeToSkillErrorKey(appError.code, 'search') });
    } finally {
      set({ searching: false });
    }
  },

  searchMarketSkills: async (query: string, append = false) => {
    const q = query.trim();
    const nextPage = append ? get().marketPage + 1 : 1;
    set({ marketLoading: true, marketError: null });
    try {
      const data = await hostApiFetch<{
        results?: Array<{
          slug?: string;
          displayName?: string;
          name?: string;
          summary?: string;
          description?: string;
          installUrl?: string;
        }>;
        total?: number;
        page?: number;
      }>('/api/skill-market/search', {
        method: 'POST',
        body: JSON.stringify({ q, page: nextPage, limit: 20 }),
      });
      const raw = data.results ?? [];
      const rows: MarketSkillRow[] = raw.flatMap((r) => {
        const slug = String(r.slug ?? '').trim();
        if (!slug) return [];
        const displayName = String(r.displayName ?? r.name ?? slug).trim() || slug;
        const summary = String(r.summary ?? r.description ?? '').trim();
        const row: MarketSkillRow = { slug, displayName, summary };
        if (r.installUrl) row.installUrl = r.installUrl;
        return [row];
      });
      set((state) => ({
        marketResults: append ? [...state.marketResults, ...rows] : rows,
        marketTotal: typeof data.total === 'number' ? data.total : rows.length,
        marketPage: typeof data.page === 'number' ? data.page : nextPage,
        marketLoading: false,
      }));
    } catch (error) {
      set({
        marketError: error instanceof Error ? error.message : String(error),
        marketLoading: false,
      });
    }
  },

  installSkill: async (slug: string, version?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, version }),
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        throw new Error(mapErrorCodeToSkillErrorKey(appError.code, 'install'));
      }
      // Refresh skills after install
      await get().fetchSkills({ force: true });
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  installMarketSkill: async (slug: string) => {
    const key = `market:${slug}`;
    set((state) => ({ installing: { ...state.installing, [key]: true } }));
    try {
      await useGatewayStore.getState().rpc<{ ok?: boolean }>('skills.market.install', { slug }, 120_000);
      await get().fetchSkills({ force: true });
    } finally {
      set((state) => {
        const next = { ...state.installing };
        delete next[key];
        return { installing: next };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }
      // Refresh skills after uninstall
      await get().fetchSkills({ force: true });
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  enableSkill: async (skillId) => {
    const { updateSkill } = get();

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: true });
      updateSkill(skillId, { enabled: true });
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: false });
      updateSkill(skillId, { enabled: false });
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },
}));
