import type { DbColumn, DbSchemaResult } from '../../../shared/contracts/db-schema';

const column = (name: string, type: string | null, line: number, extra: Partial<DbColumn> = {}): DbColumn =>
  ({ name, attribute: name, type, primaryKey: false, nullable: true, unique: false, foreignKeys: [], inheritedFrom: null, line, ...extra });
const fk = (target: string, targetTable: string | null, ondelete: string | null = null) => [{ target, targetTable, ondelete }];
const timestamps = [column('created_at', 'DateTime', 9, { nullable: false, inheritedFrom: 'TimestampMixin' }), column('updated_at', 'DateTime', 10, { nullable: null, inheritedFrom: 'TimestampMixin' })];
export const demoDbSchema = (workspaceId: string): DbSchemaResult => ({
  workspaceId, scannedAt: Date.now(), filesScanned: 48, filesParsed: 6, truncated: false,
  groups: [{
    id: 'app/db/base.py:Base', name: 'Base', file: 'app/db/base.py', line: 7, tables: [
      { name: 'memberships', schema: null, fullName: 'memberships', model: 'Membership', file: 'app/models/organization.py', line: 31, columns: [
        column('user_id', 'Uuid', 33, { primaryKey: true, nullable: false, foreignKeys: fk('users.id', 'users', 'CASCADE') }),
        column('organization_id', 'Uuid', 34, { primaryKey: true, nullable: false, foreignKeys: fk('organizations.id', 'organizations', 'CASCADE') }),
        column('role', 'String(32)', 35, { nullable: false }), ...timestamps,
      ], relationships: [] },
      { name: 'organizations', schema: null, fullName: 'organizations', model: 'Organization', file: 'app/models/organization.py', line: 12, columns: [
        column('id', 'Uuid', 14, { primaryKey: true, nullable: false }), column('slug', 'String(64)', 15, { nullable: false, unique: true }),
        column('display_name', 'String(255)', 16, { nullable: false }), ...timestamps,
      ], relationships: [{ name: 'members', targetModel: 'User', targetTable: 'users', collection: true, backPopulates: 'organizations', secondary: 'memberships', line: 18 }] },
      { name: 'posts', schema: null, fullName: 'posts', model: 'Post', file: 'app/models/post.py', line: 9, columns: [
        column('id', 'Integer', 11, { primaryKey: true, nullable: false }),
        column('author_id', 'Uuid', 12, { nullable: false, foreignKeys: fk('users.id', 'users', 'SET NULL') }),
        column('legacy_category_id', 'Integer', 13, { foreignKeys: fk('categories.id', null) }),
        { ...column('body', 'Text', 14), attribute: 'content' }, ...timestamps,
      ], relationships: [{ name: 'author', targetModel: 'User', targetTable: 'users', collection: false, backPopulates: 'posts', secondary: null, line: 16 }] },
      { name: 'users', schema: null, fullName: 'users', model: 'User', file: 'app/models/user.py', line: 10, columns: [
        column('id', 'Uuid', 12, { primaryKey: true, nullable: false }), column('email', 'String(320)', 13, { nullable: false, unique: true }),
        column('name', 'String(120)', 14), column('is_active', null, 15, { nullable: null, unique: null }), ...timestamps,
      ], relationships: [
        { name: 'posts', targetModel: 'Post', targetTable: 'posts', collection: true, backPopulates: 'author', secondary: null, line: 17 },
        { name: 'organizations', targetModel: 'Organization', targetTable: 'organizations', collection: true, backPopulates: 'members', secondary: 'memberships', line: 18 },
        { name: 'sessions', targetModel: null, targetTable: null, collection: null, backPopulates: null, secondary: null, line: 19 },
      ] },
    ],
  }, {
    id: 'analytics/models.py:AnalyticsBase', name: 'AnalyticsBase', file: 'analytics/models.py', line: 5, tables: [
      { name: 'events', schema: 'analytics', fullName: 'analytics.events', model: 'Event', file: 'analytics/models.py', line: 9, columns: [
        column('id', 'BigInteger', 11, { primaryKey: true, nullable: false }), column('name', 'String(80)', 12, { nullable: false }),
        column('session_id', 'Uuid', 13, { foreignKeys: fk('analytics.sessions.id', 'analytics.sessions') }), column('payload', 'JSON', 14),
      ], relationships: [{ name: 'session', targetModel: 'Session', targetTable: 'analytics.sessions', collection: false, backPopulates: null, secondary: null, line: 16 }] },
      { name: 'sessions', schema: 'analytics', fullName: 'analytics.sessions', model: 'Session', file: 'analytics/models.py', line: 19, columns: [
        column('id', 'Uuid', 21, { primaryKey: true, nullable: false }), column('started_at', 'DateTime', 22, { nullable: false }),
      ], relationships: [] },
    ],
  }],
  warnings: [{ file: 'app/models/user.py', line: 15, message: 'Column type is computed at runtime; shown as unknown.' }],
});
