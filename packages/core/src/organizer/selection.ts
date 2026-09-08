import { CanonicalNode, CanonicalTree } from '../types';

/**
 * A node's stable identity for selection purposes -- its path segments
 * joined. Matches what the desktop renderer uses to key checkbox state
 * (packages/desktop/src/renderer/src/components/molecules/SelectionTree),
 * kept intentionally trivial (`path.join('/')`) so the two stay in sync
 * without the renderer needing to import this module (it can't -- see
 * the IPC-seam comment in shared/ipcContract.ts).
 */
export function nodeKey(pathSegments: string[]): string {
  return pathSegments.join('/');
}

/**
 * Returns a new tree with every excluded node's subtree removed.
 * Excluding a node excludes everything beneath it -- deselecting a crate
 * or folder in the UI deselects its contents too, there's no way to
 * exclude a parent while keeping a child. Branches that end up with no
 * tracks anywhere beneath them (either originally empty, or emptied by
 * exclusion) are dropped entirely, so a filtered plan never tries to
 * create an empty folder.
 *
 * This is what makes the UI's "toggle what gets copied" feature real
 * rather than cosmetic: `planOrganize` runs against the filtered tree,
 * not the original scan.
 */
export function filterTreeBySelection(
  tree: CanonicalTree,
  excludedKeys: ReadonlySet<string>
): CanonicalTree {
  const filteredRoot = filterNode(tree.root, excludedKeys, true);
  return {
    ...tree,
    root: filteredRoot ?? { ...tree.root, children: [], tracks: [] },
  };
}

function filterNode(
  node: CanonicalNode,
  excludedKeys: ReadonlySet<string>,
  isRoot: boolean
): CanonicalNode | null {
  if (!isRoot && excludedKeys.has(nodeKey(node.path))) return null;

  const children = node.children
    .map((child) => filterNode(child, excludedKeys, false))
    .filter((child): child is CanonicalNode => child !== null);

  if (!isRoot && children.length === 0 && node.tracks.length === 0) {
    return null;
  }

  return { ...node, children };
}
