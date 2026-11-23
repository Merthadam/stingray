import path from 'node:path';
import type { GlobMatcher } from '../../../core/shared/ports';

export const nodeGlobMatcher: GlobMatcher = { matches: (file, glob) => path.posix.matchesGlob(file, glob) };
