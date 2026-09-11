import { useEffect, useMemo, useState } from 'react';
import {
  BurnReport,
  CanonicalTree,
  DiffSummary,
  OrganizePlan,
  OrganizeReport,
  ScanProgress,
  burn,
  diffBurn,
  executeOrganize,
  planOrganize,
  scanCrateDatabase,
  scanFolderTree,
  selectFolder,
} from './api';
import { Button } from './components/atoms/Button/Button';
import { Card } from './components/atoms/Card/Card';
import { FolderField } from './components/molecules/FolderField/FolderField';
import { ProgressBar } from './components/atoms/ProgressBar/ProgressBar';
import { SelectionTree } from './components/molecules/SelectionTree/SelectionTree';
import styles from './App.module.css';

// One entry per user-triggered action. Tracking *which* action is running
// (instead of a single boolean) is what lets each button show its own
// "Scanning…" / "Planning…" label — a plain isLoading flag can't tell two
// buttons apart. All four still share one value rather than one boolean
// each, because the actions are sequential and share state (you can't
// plan while a scan is still landing, execute reads the last plan, etc.)
// — so every button disables while any one of them is in flight.
type ActionKey = 'scan' | 'plan' | 'dryRun' | 'execute' | 'diffBurn' | 'burn';
type ScanMode = 'folders' | 'crates';

function countTracks(tree: CanonicalTree): number {
  let count = 0;
  const visit = (node: CanonicalTree['root']) => {
    count += node.tracks.length;
    node.children.forEach(visit);
  };
  visit(tree.root);
  return count;
}

// Mirrors the "excluded subtree" rule from @mlo/core's filterTreeBySelection
// (can't import it here -- see the IPC-seam comment in ipcContract.ts) so
// the summary line above the tree can show a real "X of Y selected" count
// without waiting on a round-trip through planOrganize.
function countSelectedTracks(node: CanonicalTree['root'], excludedKeys: Set<string>): number {
  const key = node.path.join('/');
  if (excludedKeys.has(key)) return 0;
  return node.tracks.length + node.children.reduce((sum: number, c: CanonicalTree['root']) => sum + countSelectedTracks(c, excludedKeys), 0);
}

// "Select none" excludes every *top-level* child, not the root itself --
// @mlo/core's filterTreeBySelection (organizer/selection.ts) deliberately
// never lets the root be excluded (a tree with nothing selected is
// represented as "every top-level node excluded," not "the root is
// excluded"), so excluding the root's own key here would show 0 selected
// in this preview while the real burn/plan still copied everything. This
// stays consistent with that by construction: excluding a node already
// excludes its whole subtree, so listing just the direct children is
// enough, no need to walk deeper.
function topLevelKeys(root: CanonicalTree['root']): Set<string> {
  return new Set(root.children.map((child) => child.path.join('/')));
}

const MAX_SHOWN_FAILURES = 8;

// Both the plain copy flow's execution report and the burn flow's report
// wrap the same OrganizeReport shape, and both were only ever showing the
// per-status *counts* (e.g. "error: 335") with no way to see WHY any of
// those errors happened short of re-running with a debugger attached.
// executeItem (organizer/executor.ts) already captures a real
// `(err as Error).message` per failed item -- e.g. Node's own
// "ENOENT: no such file or directory, open '...'" -- so surface a sample
// of that here instead of leaving it on the floor. Capped rather than
// listing all of them: a uniform failure (like every item hitting the same
// missing-volume-root problem) produces one failure per track, and nobody
// needs to read the same explanation 335 times to understand it.
function FailedItems({ results }: { results: OrganizeReport['results'] }) {
  const failed = results.filter((r) => r.status === 'error');
  if (failed.length === 0) return null;

  const shown = failed.slice(0, MAX_SHOWN_FAILURES);
  const remaining = failed.length - shown.length;

  return (
    <div>
      <p role="alert" className={styles.error}>
        {failed.length} file(s) failed. Showing {shown.length} of them below — look for whether
        they all share the same reason (e.g. every path pointing at a drive that isn't the right
        one right now) rather than treating each as a separate problem.
      </p>
      <ul className={styles.reportList}>
        {shown.map((r) => (
          <li key={r.trackId}>
            <code>{r.sourcePath}</code>
            <br />→ {r.error ?? '(no error message captured)'}
          </li>
        ))}
      </ul>
      {remaining > 0 && <p className={styles.subtitle}>…and {remaining} more with the same status.</p>}
    </div>
  );
}

export default function App() {
  const [scanMode, setScanMode] = useState<ScanMode>('crates');

  // Folder-tree mode.
  const [rootPath, setRootPath] = useState('');
  // Crate-database mode.
  const [subcratesDir, setSubcratesDir] = useState('');
  const [volumeRoot, setVolumeRoot] = useState('');

  const [targetRoot, setTargetRoot] = useState('');
  const [mode] = useState<'copy' | 'move'>('copy'); // move is a follow-up, see docs/decisions.md

  const [tree, setTree] = useState<CanonicalTree | null>(null);
  // Only set for a crate-database scan (scanCrateDatabase's return type is
  // CanonicalTree & { unresolvedCount } -- folder-tree scans have no such
  // concept, there's no path resolution to fail). Surfaced right here at
  // scan time, not just buried in a burn's verification step afterward --
  // a wrong "Volume root" (e.g. a stale drive letter left over from before
  // a drive got reassigned -- this happens, drive letters aren't stable)
  // would otherwise resolve every track path to a file that doesn't exist,
  // and nothing would say so until a burn failed for what looks like an
  // unrelated reason much later.
  const [unresolvedCount, setUnresolvedCount] = useState<number | null>(null);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [report, setReport] = useState<OrganizeReport | null>(null);

  // Phase 3: burn to flash. A separate destination from targetRoot above --
  // targetRoot is the local canonical-tree copy, burnTarget is a drive/
  // folder getting a full, standalone _Serato_ structure written onto it.
  // Deliberately shares `tree` and `excludedKeys` with the copy flow rather
  // than introducing a second scan/selection just for burning.
  const [burnTarget, setBurnTarget] = useState('');
  // "Use the same folder as Target root" -- the billing/shipping-address
  // pattern James asked for, since the two fields are legitimately
  // different destinations (see the field-audit note in docs/decisions.md,
  // 2026-09-11) but are very often the same path in practice. Kept as its
  // own flag plus the raw `burnTarget` value, rather than copying
  // targetRoot into burnTarget once on check -- a live link (computed
  // below as `effectiveBurnTarget`) means editing Target root afterward
  // keeps both in sync, and unchecking restores whatever was typed into
  // Burn target before, instead of losing it.
  const [burnTargetSameAsTargetRoot, setBurnTargetSameAsTargetRoot] = useState(false);
  const [diffSummary, setDiffSummary] = useState<DiffSummary | null>(null);
  const [burnReport, setBurnReport] = useState<BurnReport | null>(null);

  const [loadingAction, setLoadingAction] = useState<ActionKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  // Subscribed for the app's lifetime, not just while a scan is running --
  // there's no harm in an idle listener, and it avoids a subscribe/
  // unsubscribe dance racing against handleScan's own state updates.
  useEffect(() => window.mlo.onScanProgress(setScanProgress), []);

  const trackCount = useMemo(() => (tree ? countTracks(tree) : 0), [tree]);
  const selectedCount = useMemo(
    () => (tree ? countSelectedTracks(tree.root, excludedKeys) : 0),
    [tree, excludedKeys]
  );
  const canScan = scanMode === 'folders' ? !!rootPath : !!subcratesDir && !!volumeRoot;
  const isBusy = loadingAction !== null;
  // The value every burn action and the Burn target field itself should
  // actually use -- see the burnTargetSameAsTargetRoot state comment above.
  const effectiveBurnTarget = burnTargetSameAsTargetRoot ? targetRoot : burnTarget;

  async function run<T>(key: ActionKey, action: () => Promise<T>, onSuccess: (result: T) => void) {
    setLoadingAction(key);
    setError(null);
    try {
      const result = await action();
      onSuccess(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAction(null);
    }
  }

  const pickFolder = (onPicked: (path: string) => void) => async () => {
    const path = await selectFolder();
    if (path) onPicked(path);
  };

  const handleScan = () => {
    setScanProgress(null);
    return run(
      'scan',
      () => (scanMode === 'folders' ? scanFolderTree(rootPath) : scanCrateDatabase(subcratesDir, volumeRoot)),
      (result) => {
        setTree(result);
        // Branching on scanMode (rather than a runtime `in` check on `result`)
        // because TS can't narrow a generic `run<T>` result via `in` -- it
        // still types the property as `unknown` afterward. scanMode is
        // exactly the condition that decided which of scanFolderTree /
        // scanCrateDatabase ran, so it's both correct and clearer here.
        setUnresolvedCount(
          scanMode === 'crates' ? (result as CanonicalTree & { unresolvedCount: number }).unresolvedCount : null
        );
        setExcludedKeys(new Set());
        setPlan(null);
        setReport(null);
        setDiffSummary(null);
        setBurnReport(null);
      }
    );
  };

  const handlePlan = () =>
    run(
      'plan',
      () => {
        if (!tree) throw new Error('Scan a library first.');
        return planOrganize(tree, targetRoot, mode, Array.from(excludedKeys));
      },
      (result) => {
        setPlan(result);
        setReport(null);
      }
    );

  const handleExecute = (dryRun: boolean) =>
    run(
      dryRun ? 'dryRun' : 'execute',
      () => {
        if (!plan) throw new Error('Preview a plan first.');
        return executeOrganize(plan, dryRun);
      },
      setReport
    );

  const handleDiffBurn = () =>
    run(
      'diffBurn',
      () => {
        if (!tree) throw new Error('Scan a library first.');
        if (!effectiveBurnTarget) throw new Error('Choose a burn target first.');
        return diffBurn(tree, effectiveBurnTarget, 'copy', Array.from(excludedKeys));
      },
      (result) => {
        setDiffSummary(result);
        setBurnReport(null);
      }
    );

  const handleBurn = () =>
    run(
      'burn',
      () => {
        if (!tree) throw new Error('Scan a library first.');
        if (!effectiveBurnTarget) throw new Error('Choose a burn target first.');
        return burn(tree, effectiveBurnTarget, 'copy', Array.from(excludedKeys));
      },
      (result) => {
        setBurnReport(result);
        setDiffSummary(result.diffSummary);
      }
    );

  return (
    <main className={styles.main}>
      <h1>Music Library Organizer</h1>
      <p className={styles.subtitle}>
        Reads your Serato organization and copies files into a mirrored, tool-agnostic tree under a
        target folder you choose.
      </p>

      <section className={styles.controls}>
        <div className={styles.modeRow}>
          <label>
            <input
              type="radio"
              checked={scanMode === 'crates'}
              onChange={() => setScanMode('crates')}
            />{' '}
            Serato crate database (confirmed source for a real Serato library)
          </label>
          <label>
            <input
              type="radio"
              checked={scanMode === 'folders'}
              onChange={() => setScanMode('folders')}
            />{' '}
            Real folders on disk
          </label>
        </div>

        {scanMode === 'crates' ? (
          <>
            <FolderField
              label="_Serato_/Subcrates folder"
              value={subcratesDir}
              onChange={setSubcratesDir}
              onBrowse={pickFolder(setSubcratesDir)}
            />
            <FolderField
              label="Volume root (parent of _Serato_, e.g. E:\)"
              value={volumeRoot}
              onChange={setVolumeRoot}
              onBrowse={pickFolder(setVolumeRoot)}
            />
          </>
        ) : (
          <FolderField
            label="Serato-managed root folder"
            value={rootPath}
            onChange={setRootPath}
            onBrowse={pickFolder(setRootPath)}
          />
        )}

        <FolderField
          label="Target root (canonical structure goes here)"
          value={targetRoot}
          onChange={setTargetRoot}
          onBrowse={pickFolder(setTargetRoot)}
        />

        <div className={styles.actions}>
          <Button onClick={handleScan} disabled={!canScan || isBusy} loading={loadingAction === 'scan'}>
            {loadingAction === 'scan' ? 'Scanning…' : 'Scan'}
          </Button>
          <Button onClick={handlePlan} disabled={!tree || !targetRoot || isBusy} loading={loadingAction === 'plan'}>
            {loadingAction === 'plan' ? 'Planning…' : 'Preview plan (copy)'}
          </Button>
          <Button onClick={() => handleExecute(true)} disabled={!plan || isBusy} loading={loadingAction === 'dryRun'}>
            {loadingAction === 'dryRun' ? 'Running dry run…' : 'Dry run'}
          </Button>
          <Button
            variant="primary"
            onClick={() => handleExecute(false)}
            disabled={!plan || isBusy}
            loading={loadingAction === 'execute'}
          >
            {loadingAction === 'execute' ? 'Copying…' : 'Execute copy'}
          </Button>
        </div>

        {loadingAction === 'scan' && scanProgress && (
          <ProgressBar
            label={
              scanMode === 'crates'
                ? `Reading ${scanProgress.current}`
                : `Scanning ${scanProgress.current}`
            }
            detail={
              scanProgress.total
                ? `${scanProgress.processed} / ${scanProgress.total} crates · ${scanProgress.tracksFound} tracks`
                : `${scanProgress.tracksFound} tracks found`
            }
            fraction={scanProgress.total ? scanProgress.processed / scanProgress.total : undefined}
          />
        )}
      </section>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {tree && (
        <Card tone="alt" as="section" className={styles.section}>
          <h2>Scan result</h2>
          <p>
            Source type: <code>{tree.sourceType}</code> &middot;{' '}
            {selectedCount === trackCount
              ? `${trackCount} track(s) found`
              : `${selectedCount} of ${trackCount} track(s) selected`}
          </p>
          {unresolvedCount !== null && unresolvedCount > 0 && (
            <p role="alert" className={styles.error}>
              {unresolvedCount} of {trackCount} track path(s) didn't resolve to a real file on disk
              just now. This almost always means "Volume root" above is wrong for this drive right
              now — most often a drive letter that held this library earlier and has since been
              reassigned to something else. Fix "Volume root" and scan again before copying or
              burning anything: a burn will still "succeed" at writing a crate database even when
              the tracks it references don't actually exist at the destination, and the failure
              won't be obvious until verification (or opening the drive in Serato) much later.
            </p>
          )}
          <p className={styles.subtitle}>
            Uncheck a crate or folder to leave it out of the copy — unchecking a parent leaves out
            everything inside it too. Use the buttons below to start from either end instead of
            clicking through every box.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => setExcludedKeys(new Set())} disabled={isBusy}>
              Select all
            </Button>
            <Button onClick={() => setExcludedKeys(topLevelKeys(tree.root))} disabled={isBusy}>
              Select none
            </Button>
          </div>
          <div className={styles.tableWrap}>
            <SelectionTree root={tree.root} excludedKeys={excludedKeys} onChange={setExcludedKeys} />
          </div>
        </Card>
      )}

      {plan && (
        <section className={styles.section}>
          <h2>
            Plan preview ({plan.items.length} file(s), mode: {plan.mode})
          </h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.cell}>Source</th>
                  <th className={styles.cell}>Target</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={`${item.trackId}-${item.targetPath}`}>
                    <td className={styles.cell}>{item.sourcePath}</td>
                    <td className={styles.cell}>{item.targetPath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && (
        <Card tone="alt" as="section" className={styles.section}>
          <h2>{report.dryRun ? 'Dry run report' : 'Execution report'}</h2>
          <ul className={styles.reportList}>
            {Object.entries(report.summary).map(([status, count]) => (
              <li key={status}>
                {status}: {count}
              </li>
            ))}
          </ul>
          <FailedItems results={report.results} />
        </Card>
      )}

      {tree && (
        <Card tone="alt" as="section" className={styles.section}>
          <h2>Burn to flash</h2>
          <p className={styles.subtitle}>
            Writes a complete, standalone Serato structure onto a drive or folder — audio files
            plus a freshly regenerated crate database — separate from the target root above. Safe
            to run more than once: a track already burned there is skipped, not re-copied, unless
            its content has actually changed. Respects the same crate/folder selection as the copy
            flow above.
          </p>

          <div className={styles.modeRow}>
            <label>
              <input
                type="checkbox"
                checked={burnTargetSameAsTargetRoot}
                onChange={(e) => setBurnTargetSameAsTargetRoot(e.target.checked)}
              />{' '}
              Use the same folder as "Target root" above
            </label>
          </div>

          <FolderField
            label="Burn target (a drive or folder — never your live E:\_Serato_ until the Phase 2 hardware checkpoint has happened)"
            value={effectiveBurnTarget}
            onChange={setBurnTarget}
            onBrowse={pickFolder(setBurnTarget)}
            disabled={burnTargetSameAsTargetRoot}
          />

          <div className={styles.actions}>
            <Button
              onClick={handleDiffBurn}
              disabled={!tree || !effectiveBurnTarget || isBusy}
              loading={loadingAction === 'diffBurn'}
            >
              {loadingAction === 'diffBurn' ? 'Comparing…' : 'Preview burn'}
            </Button>
            <Button
              variant="primary"
              onClick={handleBurn}
              disabled={!tree || !effectiveBurnTarget || isBusy}
              loading={loadingAction === 'burn'}
            >
              {loadingAction === 'burn' ? 'Burning…' : 'Burn'}
            </Button>
          </div>

          {diffSummary && (
            <p>
              {diffSummary.new} new &middot; {diffSummary.changed} changed &middot;{' '}
              {diffSummary.unchanged} already up to date
            </p>
          )}

          {burnReport && (
            <>
              <p
                role={burnReport.verification.ok ? undefined : 'alert'}
                className={burnReport.verification.ok ? styles.subtitle : styles.error}
              >
                {burnReport.verification.ok
                  ? 'Verified: every track on the target volume reads back correctly, in the right crate.'
                  : `Verification found a problem — ${burnReport.verification.unresolvedCount} unresolved, ` +
                    `${burnReport.verification.missingTrackIds.length} missing, ` +
                    `${burnReport.verification.unexpectedTrackIds.length} unexpected, ` +
                    `${burnReport.verification.misplacedTrackIds.length} in the wrong crate. Don't disconnect the ` +
                    'drive — see docs/roadmap.md\u2019s Phase 3 failure-injection notes before retrying.'}
              </p>
              <ul className={styles.reportList}>
                {Object.entries(burnReport.organizeReport.summary).map(([status, count]) => (
                  <li key={status}>
                    {status}: {count}
                  </li>
                ))}
              </ul>
              <FailedItems results={burnReport.organizeReport.results} />
            </>
          )}
        </Card>
      )}
    </main>
  );
}
