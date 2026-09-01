import styles from './Spinner.module.css';

// Purely decorative — the button text next to it ("Scanning…") already
// carries the state for screen readers via the button's aria-busy, so this
// stays out of the accessibility tree.
export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}
