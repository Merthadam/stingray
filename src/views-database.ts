// Pure adapter: DbSchemaResult -> generic ViewResult. Shared by the main process and the browser demo,
// so it must not import Node modules.
import type { DbSchemaResult } from './db-schema';
import type { DiagramEdge, DiagramGroup, DiagramNode, GraphStatus, ViewResult, ViewSummary, ViewWarning } from './views';

export const DATABASE_VIEW: ViewSummary = {
  id: 'database', name: 'Database', kind: 'tables',
  description: 'SQLAlchemy models in this worktree, read statically', builtin: true, file: null, error: null,
};

const MAX_WARNINGS = 200;

export function databaseView(result: DbSchemaResult, graph: GraphStatus = { state: 'unavailable', message: null }): ViewResult {
  const groups: DiagramGroup[] = [];
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const warnings: ViewWarning[] = result.warnings.slice(0, MAX_WARNINGS)
    .map(w => ({ file: w.file, line: w.line, message: w.message }));
  const warn = (w: ViewWarning) => { if (warnings.length < MAX_WARNINGS) warnings.push(w); };
  const nodeId = (groupId: string, fullName: string) => `${groupId}#${fullName}`;
  let foreignKeys = 0, relationships = 0;

  for (const group of result.groups) {
    groups.push({
      id: group.id, label: group.name,
      source: group.file !== null && group.line !== null ? { file: group.file, line: group.line } : null,
    });
    const tables = new Map(group.tables.map(t => [t.fullName, t]));
    const pairedRelationships = new Set<string>(); // `${fullName}.${name}` already drawn as part of a pair

    for (const table of group.tables) {
      const id = nodeId(group.id, table.fullName);
      nodes.push({
        id, label: table.fullName, kind: 'table', subtitle: table.model, group: group.id,
        source: { file: table.file, line: table.line }, symbol: null, role: null, order: null, detail: null,
        fields: table.columns.map(c => {
          const badges: string[] = [];
          if (c.primaryKey) badges.push('PK');
          if (c.foreignKeys.length) badges.push('FK');
          if (c.unique === true) badges.push('UQ');
          if (c.nullable === true) badges.push('NULL');
          const detail = [c.attribute !== c.name ? `attribute ${c.attribute}` : null, c.inheritedFrom ? `from ${c.inheritedFrom}` : null]
            .filter(Boolean).join(' · ') || null;
          return {
            id: c.attribute, label: c.name, type: c.type, badges, detail,
            source: c.inheritedFrom === null ? { file: table.file, line: c.line } : null,
          };
        }),
      });

      for (const column of table.columns) {
        const source = column.inheritedFrom === null ? { file: table.file, line: column.line } : null;
        column.foreignKeys.forEach((fk, index) => {
          const target = fk.targetTable === null ? undefined : tables.get(fk.targetTable);
          if (!target) {
            warn({ file: source?.file ?? null, line: source?.line ?? null,
              message: `Foreign key ${fk.target} on ${table.model}.${column.attribute}: target table not found` });
            return;
          }
          const targetName = fk.target.split('.').pop();
          edges.push({
            id: `fk:${id}:${column.attribute}:${index}`, kind: 'foreign-key', style: 'solid', certain: true,
            from: id, fromField: column.attribute,
            to: nodeId(group.id, target.fullName),
            toField: target.columns.find(c => c.name === targetName)?.attribute ?? null,
            label: fk.ondelete ? `on delete ${fk.ondelete}` : null, source,
          });
          foreignKeys++;
        });
      }

      const relIds = new Set<string>();
      for (const rel of table.relationships) {
        if (pairedRelationships.has(`${table.fullName}.${rel.name}`)) continue;
        const target = rel.targetTable === null ? undefined : tables.get(rel.targetTable);
        const source = { file: table.file, line: rel.line };
        if (!target) {
          warn({ ...source, message: `Relationship ${table.model}.${rel.name}: target ${rel.targetModel ?? 'model'} not found` });
          continue;
        }
        const back = rel.backPopulates === null ? undefined : target.relationships.find(r =>
          r.name === rel.backPopulates && r.backPopulates === rel.name && r.targetTable === table.fullName && r !== rel);
        if (back) pairedRelationships.add(`${target.fullName}.${back.name}`);
        // Mixins can contribute a relationship with the same name more than once; keep edge ids unique.
        let relId = `rel:${id}:${rel.name}`;
        for (let n = 2; relIds.has(relId); n++) relId = `rel:${id}:${rel.name}:${n}`;
        relIds.add(relId);
        edges.push({
          id: relId, kind: 'relationship', style: 'dashed', certain: true,
          from: id, fromField: null, to: nodeId(group.id, target.fullName), toField: null,
          label: back ? `${rel.name} / ${back.name}` : rel.name + (rel.collection === true ? ' (many)' : ''),
          source,
        });
        relationships++;
      }
    }
  }

  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ...DATABASE_VIEW,
    workspaceId: result.workspaceId, computedAt: result.scannedAt, truncated: result.truncated,
    groups, nodes, edges, warnings, graph, diagnostics: null, layout: null,
    stats: { filesScanned: result.filesScanned, filesParsed: result.filesParsed, tables: nodes.length, foreignKeys, relationships },
  };
}
