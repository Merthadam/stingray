// Db-schema core with the real fs walker, under the pre-port signatures the CLI, the worker and the existing tests use.
import './core-ports';
import { nodeSchemaFiles } from '../../adapters/driven/fs/schema-files';
import { codegraphGrammarDir } from '../../adapters/driven/tree-sitter/grammars';
import { extractDbSchema as coreDb, extractSqlSchema as coreSql } from '../../core/db-schema';

export const extractDbSchema = (workspaceId: string, root: string, grammarPath: string) => coreDb(workspaceId, root, grammarPath, nodeSchemaFiles);
export const extractSqlSchema = (workspaceId: string, root: string, grammarDir = codegraphGrammarDir()) => coreSql(workspaceId, root, grammarDir, nodeSchemaFiles);
export { applySqlConstraints, parseSqlDdl } from '../../core/db-schema';
