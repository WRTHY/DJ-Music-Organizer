// Thin re-export so App.tsx's imports read the same as they did when this
// was a fetch-based client (see git history: packages/web/src/api.ts).
// Every call here is really `window.mlo.*`, i.e. IPC through the preload
// bridge — there is no HTTP involved anywhere in this app anymore.
import type { CanonicalTree, OrganizeMode, OrganizePlan } from '../../shared/ipcContract';

export type {
  BurnPhase,
  BurnProgress,
  BurnReport,
  CanonicalNode,
  CanonicalTree,
  DetectSeratoSourceResult,
  DiffSummary,
  OrganizeMode,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeReport,
  RekordboxBurnPhase,
  RekordboxBurnProgress,
  RekordboxBurnReport,
  ScanProgress,
} from '../../shared/ipcContract';

// A value (not a type), so re-exported separately from the block above --
// the renderer displays this exact constant read-only on the "Burn to
// flash" card rather than hardcoding its own copy of the path. See its
// doc in ipcContract.ts for why this stays a single shared constant.
export { DEFAULT_SOURCE_DATABASE_V2 } from '../../shared/ipcContract';

export function selectFolder() {
  return window.mlo.selectFolder();
}

export function detectSeratoSource(rootPath: string) {
  return window.mlo.detectSeratoSource(rootPath);
}

export function scanFolderTree(rootPath: string) {
  return window.mlo.scanFolderTree(rootPath);
}

export function scanCrateDatabase(subcratesDir: string, volumeRoot: string) {
  return window.mlo.scanCrateDatabase({ subcratesDir, volumeRoot });
}

export function planOrganize(
  tree: CanonicalTree,
  targetRoot: string,
  mode: OrganizeMode,
  excludedKeys?: string[]
) {
  return window.mlo.planOrganize({ tree, targetRoot, mode, excludedKeys });
}

export function executeOrganize(plan: OrganizePlan, dryRun: boolean) {
  return window.mlo.executeOrganize({ plan, dryRun });
}

export function diffBurn(
  tree: CanonicalTree,
  targetRoot: string,
  mode: OrganizeMode = 'copy',
  excludedKeys?: string[]
) {
  return window.mlo.diffBurn({ tree, targetRoot, mode, excludedKeys });
}

export function burn(
  tree: CanonicalTree,
  targetRoot: string,
  mode: OrganizeMode = 'copy',
  excludedKeys?: string[]
) {
  return window.mlo.burn({ tree, targetRoot, mode, excludedKeys });
}

// Phase 5 (docs/roadmap.md): burn-to-Rekordbox. Just a device root, not a
// template/output file pair -- see BurnRekordboxArgs's doc in
// ipcContract.ts for the path convention this derives from it, and why
// there's no separate preview call the way diffBurn/burn have one.
export function burnRekordbox(tree: CanonicalTree, deviceRoot: string, excludedKeys?: string[]) {
  return window.mlo.burnRekordbox({ tree, deviceRoot, excludedKeys });
}
