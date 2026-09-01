import { useMemo, useState } from 'react';
import {
  CanonicalTree,
  OrganizePlan,
  OrganizeReport,
  executeOrganize,
  planOrganize,
  scanCrateDatabase,
  scanFolderTree,
  selectFolder,
} from './api';
import { Button } from './components/atoms/Button/Button';
import { Card } from './components/atoms/Card/Card';
import { FolderField } from './components/molecules/FolderField/FolderField';
import styles from './App.module.css';

type Status = 'idle' | 'loading' | 'error';
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
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [report, setReport] = useState<OrganizeReport | null>(null);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const trackCount = useMemo(() => (tree ? countTracks(tree) : 0), [tree]);
  const canScan = scanMode === 'folders' ? !!rootPath : !!subcratesDir && !!volumeRoot;

  async function run<T>(action: () => Promise<T>, onSuccess: (result: T) => void) {
    setStatus('loading');
    setError(null);
    try {
      const result = await action();
      onSuccess(result);
      setStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  const pickFolder = (onPicked: (path: string) => void) => async () => {
    const path = await selectFolder();
    if (path) onPicked(path);
  };

  const handleScan = () =>
    run(
      () => (scanMode === 'folders' ? scanFolderTree(rootPath) : scanCrateDatabase(subcratesDir, volumeRoot)),
      (result) => {
        setTree(result);
        setPlan(null);
        setReport(null);
      }
    );

  const handlePlan = () =>
    run(
      () => {
        if (!tree) throw new Error('Scan a library first.');
        return planOrganize(tree, targetRoot, mode);
      },
      (result) => {
        setPlan(result);
        setReport(null);
      }
    );

  const handleExecute = (dryRun: boolean) =>
    run(
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
          <Button onClick={handleScan} disabled={!canScan || status === 'loading'}>
            Scan
          </Button>
          <Button onClick={handlePlan} disabled={!tree || !targetRoot || status === 'loading'}>
            Preview plan (copy)
          </Button>
          <Button onClick={() => handleExecute(true)} disabled={!plan || status === 'loading'}>
            Dry run
          </Button>
          <Button
            variant="primary"
            onClick={() => handleExecute(false)}
            disabled={!plan || status === 'loading'}
          >
            Execute copy
          </Button>
        </div>
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
            Source type: <code>{tree.sourceType}</code> &middot; {trackCount} track(s) found
          </p>
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
