import type {
  BurnReport,
  CanonicalNode,
  CanonicalTree,
  DatabaseV2Source,
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
  DatabaseV2Source,
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

/**
 * `burn`-only extension of `BurnArgs` (Phase 3b, docs/roadmap.md): adds
 * the optional already-analyzed `database V2` to carry per-track
 * analysis state forward from (see `DatabaseV2Source`'s doc in
 * `@mlo/core`'s burnToFlash.ts). Deliberately NOT added to `BurnArgs`
 * itself -- `diffBurn` is a read-only preview that never touches
 * `database V2` at all (see the diffBurn channel comment above), so
 * giving it a field it would silently ignore is exactly the kind of
 * drift this shared-contract file exists to prevent.
 */
export interface BurnExecuteArgs extends BurnArgs {
  /**
   * Omit to let main/ipcHandlers.ts apply its own default (currently
   * James's library backup, see `DEFAULT_SOURCE_DATABASE_V2` below) --
   * applied only when that default file actually exists, never forced.
   * Pass explicitly to override it; an explicit path that doesn't exist
   * fails the burn loudly rather than silently falling back -- see
   * `BurnOptions.sourceDatabaseV2`'s doc in `@mlo/core`.
   */
  sourceDatabaseV2?: DatabaseV2Source;
}

/**
 * The already-analyzed `database V2` a real burn reads from by default
 * when the caller doesn't specify one -- James's library backup, not his
 * live `E:\_Serato_\database V2`, so this feature can never read (let
 * alone write) the one database he actually uses every session (Phase
 * 3b UI wiring decision, docs/decisions.md 2026-09-14). A plain shared
 * constant rather than something computed independently in main and
 * renderer code: main/ipcHandlers.ts applies it as the fallback when
 * `sourceDatabaseV2` is omitted (after confirming the file is actually
 * there -- see that file), and the renderer displays this exact value
 * read-only on the "Burn to flash" card, so there's exactly one place to
 * update if this path ever needs to change, not two that could drift.
 */
export const DEFAULT_SOURCE_DATABASE_V2: DatabaseV2Source = {
  filePath: String.raw`E:\LIBRARY BACKUP 9_10_2026\_Serato_\database V2`,
  volumeRoot: String.raw`E:\LIBRARY BACKUP 9_10_2026`,
};

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
  burn(args: BurnExecuteArgs): Promise<BurnReport>;
}
