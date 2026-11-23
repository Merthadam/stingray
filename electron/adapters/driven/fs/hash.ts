import { createHash } from 'node:crypto';
import type { Hasher } from '../../../core/shared/ports';

export const nodeHasher: Hasher = { sha256: text => createHash('sha256').update(text).digest('hex') };
