import { useState } from 'react';
import { CanonicalNode } from '../../../api';
import { cx } from '../../../utils/classNames';
import styles from './SelectionTree.module.css';

/**
 * Node identity for selection/expansion state. MUST match @mlo/core's
 * organizer/selection.ts `nodeKey` exactly -- the renderer can't import
 * core directly (see the seam comment in shared/ipcContract.ts), so this
 * is kept deliberately trivial to minimize drift risk between the two.
 */
function nodeKeyFor(pathSegments: string[]): string {
  return pathSegments.join('/');
}

function countTracks(node: CanonicalNode): number {
  return node.tracks.length + node.children.reduce((sum: number, c: CanonicalNode) => sum + countTracks(c), 0);
}

function someDescendantExcluded(node: CanonicalNode, excludedKeys: Set<string>): boolean {
  return node.children.some(
    (child: CanonicalNode) => excludedKeys.has(nodeKeyFor(child.path)) || someDescendantExcluded(child, excludedKeys)
  );
}

function collectKeys(node: CanonicalNode, into: Set<string>): void {
  for (const child of node.children as CanonicalNode[]) {
    into.delete(nodeKeyFor(child.path));
    collectKeys(child, into);
  }
}

interface SelectionTreeProps {
  root: CanonicalNode;
  excludedKeys: Set<string>;
  onChange: (next: Set<string>) => void;
}

/**
 * A checkbox tree over a scanned CanonicalTree, so a user can deselect
 * whole crates/folders before planning -- not every scanned track has to
 * end up in the copy. Excluding a node excludes its whole subtree; a
 * child under an excluded parent shows disabled (re-check the parent
 * first) rather than supporting an independent "carve-out," which keeps
 * the exclusion set small and the behavior predictable.
 */
export function SelectionTree({ root, excludedKeys, onChange }: SelectionTreeProps) {
  const toggle = (node: CanonicalNode, nextChecked: boolean) => {
    const key = nodeKeyFor(node.path);
    const next = new Set(excludedKeys);
    if (nextChecked) {
      next.delete(key);
    } else {
      next.add(key);
    }
    // Either way, this node's own state now governs -- any descendant
    // keys left over from a previous individual toggle are redundant.
    collectKeys(node, next);
    onChange(next);
  };

  return (
    <div className={styles.tree}>
      {root.children.map((child: CanonicalNode) => (
        <TreeRow
          key={nodeKeyFor(child.path)}
          node={child}
          depth={0}
          ancestorExcluded={false}
          excludedKeys={excludedKeys}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  node: CanonicalNode;
  depth: number;
  ancestorExcluded: boolean;
  excludedKeys: Set<string>;
  onToggle: (node: CanonicalNode, nextChecked: boolean) => void;
}

function TreeRow({ node, depth, ancestorExcluded, excludedKeys, onToggle }: TreeRowProps) {
  // Top level starts expanded (you want to see your crates at a glance);
  // deeper levels start collapsed, since a 5-year library can nest deep
  // and showing all of it by default would just be a wall of rows.
  const [expanded, setExpanded] = useState(depth === 0);

  const key = nodeKeyFor(node.path);
  const excludedHere = excludedKeys.has(key);
  const disabled = ancestorExcluded;
  const effectivelyExcluded = ancestorExcluded || excludedHere;
  const indeterminate = !effectivelyExcluded && someDescendantExcluded(node, excludedKeys);
  const checked = !effectivelyExcluded && !indeterminate;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div className={styles.row} style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className={styles.toggleSpacer} />
        )}
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={checked}
          disabled={disabled}
          ref={(el) => {
            if (el) el.indeterminate = indeterminate;
          }}
          onChange={(e) => onToggle(node, e.target.checked)}
        />
        <span className={cx(styles.name, disabled && styles.disabled)}>{node.name}</span>
        <span className={styles.count}>{countTracks(node)} track(s)</span>
      </div>
      {hasChildren &&
        expanded &&
        node.children.map((child: CanonicalNode) => (
          <TreeRow
            key={nodeKeyFor(child.path)}
            node={child}
            depth={depth + 1}
            ancestorExcluded={disabled || excludedHere}
            excludedKeys={excludedKeys}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}
