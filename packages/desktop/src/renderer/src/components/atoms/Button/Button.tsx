import { ButtonHTMLAttributes } from 'react';
import { cx } from '../../../utils/classNames';
import { Spinner } from '../Spinner/Spinner';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
  loading?: boolean;
}

export function Button({ variant = 'default', loading = false, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(styles.button, variant === 'primary' && styles.primary, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
