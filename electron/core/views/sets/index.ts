// Builtin rule sets (`use: [name]` in a view). Each YAML set is a TS module exporting its YAML text, so it works under
// esbuild and tsx alike. `sqlalchemy` is the TypeScript extractor in electron/core/db-schema/db-schema.ts, computed by the main process.
import { alembic } from './alembic';
import { cdk } from './cdk';
import { langgraph } from './langgraph';
import { terraform } from './terraform';

export const TS_EXTRACTORS = ['sqlalchemy', 'sql'] as const;
export const BUILTIN_SETS: Record<string, { description: string; preview: boolean; yaml: string }> = {
  alembic: { description: 'Alembic migration chain with the table operations of each upgrade() (kind: timeline)', preview: false, yaml: alembic },
  langgraph: { description: 'LangGraph StateGraph nodes, edges and conditional branches (kind: flow)', preview: false, yaml: langgraph },
  terraform: { description: 'Terraform resources, data sources and modules with their references (kind: graph)', preview: true, yaml: terraform },
  cdk: { description: 'AWS CDK stacks and constructs with grants, props and dependencies (kind: graph)', preview: true, yaml: cdk },
};

export const EXTRACTOR_DESCRIPTIONS: Record<typeof TS_EXTRACTORS[number], string> = {
  sqlalchemy: 'SQLAlchemy models as tables (TypeScript extractor)',
  sql: 'SQL DDL in .sql files and code strings as tables (TypeScript extractor)',
};
