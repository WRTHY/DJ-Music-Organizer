import { Button } from '../../atoms/Button/Button';
import styles from './FolderField.module.css';

interface FolderFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
  /**
   * When true, both the text input and the Browse button are inert and
   * take on the browser/design-system's native disabled look -- used by
   * App.tsx's "use the same folder as Target root" checkbox so the Burn
   * target field visibly (not just functionally) can't be edited directly
   * while it's following another field. Optional and defaults to false so
   * every existing caller is unaffected.
   */
  disabled?: boolean;
}

export function FolderField({ label, value, onChange, onBrowse, disabled = false }: FolderFieldProps) {
  return (
    <label className={styles.field}>
      {label}
      <div className={styles.row}>
        <input
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="No folder chosen"
          disabled={disabled}
        />
        <Button type="button" onClick={onBrowse} disabled={disabled}>
          Browse&hellip;
        </Button>
      </div>
    </label>
  );
}
