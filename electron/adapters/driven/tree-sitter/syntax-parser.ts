import { Language, Parser, Query } from 'web-tree-sitter';
import type { SyntaxParser } from '../../../core/shared/ports';
import { initTreeSitter } from './grammars';

export const webTreeSitter: SyntaxParser = {
  loadLanguage: file => initTreeSitter().then(() => Language.load(file)),
  parser: language => { const parser = new Parser(); parser.setLanguage(language); return parser; },
  query: (language, source) => new Query(language, source),
};
