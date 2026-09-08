import type {
  CanonicalNode,
  CanonicalTree,
  OrganizeMode,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeReport,
  ScanProgress,
} from '@mlo/core';

// Re-exported so renderer code imports everything it needs from this one
// shared file, rather than reaching past the IPC boundary into @mlo/core
// directly (the renderer's tsconfig doesn't even include core's types —
// this file is the deliberate seam between them).
export type { CanonicalNode, CanonicalTree, OrganizeMode, OrganizePlan, OrganizePlanItem, OrganizeReport, ScanProgress };

/**
 * The whole IPC surface between the renderer and the main process, in one
 * place. main/registerIpc.ts implements this, preload/index.ts exposes it
 * via contextBridge, and renderer code (src/renderer) calls it through
 * `window.mlo`. Keeping the shape in one shared file means a change here
 * shows up as a type error in both main and renderer if either side falls
 * out of sync — that's the whole point of doing this in TypeScript instead
 * of just agreeing on channel names by convention.
 */

export const IPC_CHANNELS = {
  selectFolder: 'dialog:selectFolder',
  detectSeratoSource: 'serato:detect',
  scanFolderTree: 'serato:scanFolderTree',
  scanCrateDatabase: 'serato:scanCrateDatabase',
  // Not invoked directly -- main pushes events on this channel (via
  // webContents.send) while a scanFolderTree/scanCrateDatabase call is
  // still in flight. invoke/handle is strictly request/response, so a
  // long scan needs this separate push channel for progress; the final
  // result still comes back as the invoke's own return value.
  scanProgress: 'serato:scanProgress',
  planOrganize: 'organize:plan',
  executeOrganize: 'organize:execute',
} as const;

export interface DetectSeratoSourceResult {
  sourceType: 'serato-folders' | 'serato-crates' | 'mixed';
  hasSubcratesDir: boolean;
  subcratesDir: string | null;
  hasRealSubfolders: boolean;
}

export interface ScanCrateDatabaseArgs {
  subcratesDir: string;
  volumeRoot: string;
}

export interface PlanOrganizeArgs {
  /** The tree from a prior scanFolderTree/scanCrateDatabase call — plan never re-scans. */
  tree: CanonicalTree;
  targetRoot: string;
  mode: OrganizeMode;
  /**
   * Node keys (path segments joined with '/', matching @mlo/core's
   * organizer/selection.ts `nodeKey`) the user deselected in the
   * SelectionTree UI. Excluding a node excludes its whole subtree.
   * Omitted or empty means "everything selected" -- the original,
   * unfiltered behavior.
   */
  excludedKeys?: string[];
}

export interface ExecuteOrganizeArgs {
  plan: OrganizePlan;
  dryRun: boolean;
}

/** The API surface the preload script exposes on `window.mlo`. */
export interface MloApi {
  selectFolder(): Promise<string | null>;
  detectSeratoSource(rootPath: string): Promise<DetectSeratoSourceResult>;
  scanFolderTree(rootPath: string): Promise<CanonicalTree>;
  scanCrateDatabase(args: ScanCrateDatabaseArgs): Promise<CanonicalTree & { unresolvedCount: number }>;
  /**
   * Subscribes to progress events for whichever scan is currently in
   * flight. Returns an unsubscribe function (a React useEffect cleanup
   * fits this directly). Not request/response like the rest of this API
   * -- see the scanProgress channel comment above.
   */
  onScanProgress(callback: (progress: ScanProgress) => void): () => void;
  planOrganize(args: PlanOrganizeArgs): Promise<OrganizePlan>;
  executeOrganize(args: ExecuteOrganizeArgs): Promise<OrganizeReport>;
}
