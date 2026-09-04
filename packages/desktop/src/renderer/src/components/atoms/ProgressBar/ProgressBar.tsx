import { cx } from '../../../utils/classNames';
import styles from './ProgressBar.module.css';

interface ProgressBarProps {
  /** 0-1. Omit (or leave undefined) for indeterminate mode -- no known total yet. */
  fraction?: number;
  /** Left-aligned label, e.g. "Scanning House/Deep House…". */
  label: string;
  /** Right-aligned detail, e.g. "142 tracks found" or "37 / 210 crates". */
  detail?: string;
}

export function ProgressBar({ fraction, label, detail }: ProgressBarProps) {
  const determinate = fraction !== undefined;
  const pct = determinate ? Math.max(0, Math.min(1, fraction!)) * 100 : 0;

  return (
    <div className={styles.wrap} role="status">
      <div className={styles.label}>
        <span>{label}</span>
        {detail && <span>{detail}</span>}
      </div>
      <div
        className={cx(styles.track, !determinate && styles.indeterminate)}
        aria-hidden={!determinate}
      >
        <div className={styles.fill} style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
