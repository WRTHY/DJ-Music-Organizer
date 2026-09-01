import { Button } from '../../atoms/Button/Button';
import styles from './FolderField.module.css';

interface FolderFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
}

export function FolderField({ label, value, onChange, onBrowse }: FolderFieldProps) {
  return (
    <label className={styles.field}>
      {label}
      <div className={styles.row}>
        <input
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="No folder chosen"
        />
        <Button type="button" onClick={onBrowse}>
          Browse&hellip;
        </Button>
      </div>
    </label>
  );
}
