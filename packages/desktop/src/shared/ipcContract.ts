import type {
  BurnReport,
  CanonicalNode,
  CanonicalTree,
  DiffSummary,
  OrganizeMode,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeReport,
  ScanProgress,
  SeratoSourceType,
} from '@mlo/core';

// Re-exported so renderer code imports everything it needs from this one
// shared file, rather than reaching past the IPC boundary into @mlo/core
// directly (the renderer's tsconfig doesn't even include core's types —
// this file is the deliberate seam between them).
export type {
  BurnReport,
  CanonicalNode,
  CanonicalTree,
  DiffSummary,
  OrganizeMode,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeReport,
  ScanProgress,
  SeratoSourceType,
};

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
  // Phase 3 (docs/roadmap.md): burn-to-flash. diffBurn is a read-only
  // preview (still hashes and caches, since that work isn't wasted --
  // see main/ipcHandlers.ts) that never touches the target volume; burn
  // is the real, write-capable operation.
  diffBurn: 'burn:diff',
  burn: 'burn:execute',
} as const;

export interface DetectSeratoSourceResult {
  // Was a hand-duplicated 3-value literal union; that's exactly the kind
  // of drift this file's re-export pattern (see the comment above) exists
  // to prevent -- it fell out of sync when SeratoSourceType grew a 4th
  // value ('rekordbox-playlists') for the Rekordbox reader, breaking the
  // build. Sourced from @mlo/core directly instead so this can't happen
  // again. detectSourceType() itself only ever produces the original
  // three today (Rekordbox detection isn't wired into this IPC call yet)
  // -- the wider type just matches its real, already-widened return type.
  sourceType: SeratoSourceType;
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

/**
 * Shared by both burn-related calls (Phase 3, docs/roadmap.md): a target
 * volume/drive to burn onto, plus the same tree + selection the ordinary
 * copy flow already uses -- burning respects whatever's checked in the
 * SelectionTree just like planOrganize does, rather than introducing a
 * second, separate selection concept.
 */
export interface BurnArgs {
  tree: CanonicalTree;
  targetRoot: string;
  mode?: OrganizeMode;
  excludedKeys?: string[];
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
  /** Read-only preview: counts what's new/unchanged/changed without writing anything to targetRoot. */
  diffBurn(args: BurnArgs): Promise<DiffSummary>;
  /** The real burn -- copies what's new/changed, then regenerates the full crate database and verifies it. */
  burn(args: BurnArgs): Promise<BurnReport>;
}
