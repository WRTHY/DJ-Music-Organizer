// Same tiny helper as the reference portfolio: join truthy class names,
// drop the rest. Keeps CSS Modules readable when a class is conditional
// (`cx(styles.button, variant === 'primary' && styles.primary)`) without
// pulling in a library for it.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
