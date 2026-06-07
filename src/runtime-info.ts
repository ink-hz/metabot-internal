export type BridgeRuntimeName = 'node' | 'bun';

export interface BridgeRuntimeInfo {
  activeRuntime: BridgeRuntimeName;
  activeVersion: string;
  productionDefaultRuntime: 'node';
  pm2Launch: string;
  bunOptInLaunch: string;
  bunVerified: boolean;
  nativeDependencies: string[];
}

const NATIVE_RUNTIME_DEPENDENCIES = ['better-sqlite3', 'node-pty'] as const;

export function getBridgeRuntimeInfo(): BridgeRuntimeInfo {
  const versions = process.versions as Record<string, string | undefined>;
  const bunVersion = versions.bun;
  const activeRuntime: BridgeRuntimeName = bunVersion ? 'bun' : 'node';

  return {
    activeRuntime,
    activeVersion: bunVersion ?? versions.node ?? process.version,
    productionDefaultRuntime: 'node',
    pm2Launch: 'node --import tsx src/index.ts',
    bunOptInLaunch: 'bun run src/index.ts',
    bunVerified: activeRuntime === 'bun',
    nativeDependencies: [...NATIVE_RUNTIME_DEPENDENCIES],
  };
}
