import { createHash } from 'node:crypto';

/** Stable id for a track, derived from its current absolute path. */
export function idForPath(absolutePath: string): string {
  return createHash('sha1').update(absolutePath).digest('hex').slice(0, 16);
}
