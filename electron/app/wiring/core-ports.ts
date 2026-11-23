// Imported for its side effect by every electron/app/wiring module and process entry.
import { nodeHasher } from '../../adapters/driven/fs/hash';
import { provideHasher } from '../../core/shared/ports';

provideHasher(nodeHasher);
