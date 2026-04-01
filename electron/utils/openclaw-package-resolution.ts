import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getOpenClawDir, getOpenClawResolvedDir } from './paths';

type ResolverContext = {
  label: string;
  packageJsonPath: string;
};

function buildResolverContexts(): ResolverContext[] {
  const openclawResolvedPath = getOpenClawResolvedDir();
  const contexts: ResolverContext[] = [];
  const whatsappPluginPackageJsonPath = join(
    openclawResolvedPath,
    'dist',
    'extensions',
    'whatsapp',
    'package.json',
  );
  if (existsSync(whatsappPluginPackageJsonPath)) {
    contexts.push({
      label: 'bundled WhatsApp plugin',
      packageJsonPath: whatsappPluginPackageJsonPath,
    });
  }
  contexts.push({
    label: 'OpenClaw root',
    packageJsonPath: join(openclawResolvedPath, 'package.json'),
  });
  return contexts;
}

export function resolveOpenClawPackageJson(packageName: string): string {
  const specifier = `${packageName}/package.json`;
  const openclawPath = getOpenClawDir();
  const openclawResolvedPath = getOpenClawResolvedDir();
  const failures: string[] = [];

  for (const context of buildResolverContexts()) {
    try {
      return createRequire(context.packageJsonPath).resolve(specifier);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${context.label}: ${reason}`);
    }
  }

  throw new Error(
    `Failed to resolve "${packageName}" from OpenClaw context. ` +
      `openclawPath=${openclawPath}, resolvedPath=${openclawResolvedPath}. ` +
      `Attempts: ${failures.join(' | ')}`,
  );
}

export function createOpenClawPackageRequire(packageJsonPath: string) {
  return createRequire(packageJsonPath);
}
