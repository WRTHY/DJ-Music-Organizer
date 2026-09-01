// Thin re-export so App.tsx's imports read the same as they did when this
// was a fetch-based client (see git history: packages/web/src/api.ts).
// Every call here is really `window.mlo.*`, i.e. IPC through the preload
// bridge — there is no HTTP involved anywhere in this app anymore.
import type { CanonicalTree, OrganizeMode, OrganizePlan } from '../../shared/ipcContract';

export type {
  CanonicalNode,
  CanonicalTree,
  DetectSeratoSourceResult,
  OrganizeMode,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeReport,
} from '../../shared/ipcContract';

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

export function planOrganize(tree: CanonicalTree, targetRoot: string, mode: OrganizeMode) {
  return window.mlo.planOrganize({ tree, targetRoot, mode });
}

export function executeOrganize(plan: OrganizePlan, dryRun: boolean) {
  return window.mlo.executeOrganize({ plan, dryRun });
}
