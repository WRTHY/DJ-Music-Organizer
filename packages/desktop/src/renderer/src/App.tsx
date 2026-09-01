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
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Music Library Organizer</h1>
      <p style={{ color: '#555' }}>
        Reads your Serato organization and copies files into a mirrored, tool-agnostic tree under a
        target folder you choose.
      </p>

      <section style={{ display: 'grid', gap: '0.75rem', marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem' }}>
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

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={handleScan} disabled={!canScan || status === 'loading'}>
            Scan
          </button>
          <button onClick={handlePlan} disabled={!tree || !targetRoot || status === 'loading'}>
            Preview plan (copy)
          </button>
          <button onClick={() => handleExecute(true)} disabled={!plan || status === 'loading'}>
            Dry run
          </button>
          <button
            onClick={() => handleExecute(false)}
            disabled={!plan || status === 'loading'}
            style={{ fontWeight: 600 }}
          >
            Execute copy
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" style={{ color: '#b00020', marginTop: '1rem' }}>
          {error}
        </p>
      )}

      {tree && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2>Scan result</h2>
          <p>
            Source type: <code>{tree.sourceType}</code> &middot; {trackCount} track(s) found
          </p>
        </section>
      )}

      {plan && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2>
            Plan preview ({plan.items.length} file(s), mode: {plan.mode})
          </h2>
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid #ddd', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={cellStyle}>Source</th>
                  <th style={cellStyle}>Target</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={`${item.trackId}-${item.targetPath}`}>
                    <td style={cellStyle}>{item.sourcePath}</td>
                    <td style={cellStyle}>{item.targetPath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2>{report.dryRun ? 'Dry run report' : 'Execution report'}</h2>
          <ul>
            {Object.entries(report.summary).map(([status, count]) => (
              <li key={status}>
                {status}: {count}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function FolderField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <label>
      {props.label}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: 4 }}>
        <input
          style={inputStyle}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="No folder chosen"
        />
        <button type="button" onClick={props.onBrowse}>
          Browse&hellip;
        </button>
      </div>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '0.5rem',
  boxSizing: 'border-box',
};

const cellStyle: React.CSSProperties = {
  border: '1px solid #eee',
  padding: '4px 8px',
  textAlign: 'left',
};
