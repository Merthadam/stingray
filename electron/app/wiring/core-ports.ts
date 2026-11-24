// Imported for its side effect by every electron/app/wiring module and process entry.
import { nodeGlobMatcher } from '../../adapters/driven/fs/glob';
import { nodeHasher } from '../../adapters/driven/fs/hash';
import { webTreeSitter } from '../../adapters/driven/tree-sitter/syntax-parser';
import { provideGlobMatcher, provideHasher, provideSyntaxParser } from '../../core/shared/ports';

provideHasher(nodeHasher);
provideGlobMatcher(nodeGlobMatcher);
provideSyntaxParser(webTreeSitter);
