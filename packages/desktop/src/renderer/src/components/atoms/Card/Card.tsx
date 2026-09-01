import { ElementType, ComponentPropsWithoutRef } from 'react';
import { cx } from '../../../utils/classNames';
import styles from './Card.module.css';

type CardProps<T extends ElementType> = {
  as?: T;
  tone?: 'base' | 'alt';
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'tone'>;

export function Card<T extends ElementType = 'div'>({
  as,
  tone = 'base',
  className,
  ...rest
}: CardProps<T>) {
  const Tag = as || 'div';
  return <Tag className={cx(styles.card, tone === 'alt' && styles.alt, className)} {...rest} />;
}
