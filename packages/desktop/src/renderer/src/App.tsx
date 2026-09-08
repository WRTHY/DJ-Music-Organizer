import { useEffect, useMemo, useState } from 'react';
import {
  CanonicalTree,
  OrganizePlan,
  OrganizeReport,
  ScanProgress,
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
type ActionKey = 'scan' | 'plan' | 'dryRun' | 'execute';
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
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [report, setReport] = useState<OrganizeReport | null>(null);

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
        setExcludedKeys(new Set());
        setPlan(null);
        setReport(null);
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
          <p className={styles.subtitle}>
            Uncheck a crate or folder to leave it out of the copy — unchecking a parent leaves out
            everything inside it too.
          </p>
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
        </Card>
      )}
    </main>
  );
}
