import { ButtonHTMLAttributes } from 'react';
import { cx } from '../../../utils/classNames';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
}

export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(styles.button, variant === 'primary' && styles.primary, className)}
      {...rest}
    />
  );
}
