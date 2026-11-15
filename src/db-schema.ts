// Main <-> renderer contract for the Database tab.
// Results come from static parsing of Python models and SQL DDL; repository code is never executed.

export interface DbForeignKey {
  target: string;               // literal as written, e.g. "users.id" or "auth.users.id"
  targetTable: string | null;   // DbTable.fullName in targetGroup (default: same group), or null if not found
  ondelete: string | null;
  onupdate?: string | null;
  targetGroup?: string;         // explicit group for cross-file SQL foreign keys
  referencedTable?: string;     // SQL target before resolution (may omit the referenced column)
  referencedColumn?: string | null;
}

export interface DbColumn {
  name: string;                 // DB column name: explicit first string arg, else attribute
  attribute: string;            // Python attribute name
  type: string | null;          // "String(255)", "Integer", ...; null = unknown
  primaryKey: boolean;
  nullable: boolean | null;     // null = not statically known
  unique: boolean | null;
  foreignKeys: DbForeignKey[];
  inheritedFrom: string | null; // mixin/abstract class name, else null
  file?: string;                // SQL ALTER columns can originate in a different migration file
  line: number;                 // 1-based; in file or DbTable.file unless inheritedFrom is set
}

export interface DbRelationship {
  name: string;                 // Python attribute name
  targetModel: string | null;   // class name; null = unresolved
  targetTable: string | null;   // DbTable.fullName in the same group
  collection: boolean | null;   // list/uselist; null = unknown
  backPopulates: string | null;
  secondary: string | null;     // association table name/expression text, if declared
  line: number;
}

export interface DbTable {
  name: string;                 // __tablename__
  schema: string | null;
  fullName: string;             // "schema.name" or "name"; unique key within a group
  model: string;                // class name
  file: string;                 // worktree-relative POSIX path
  line: number;
  columns: DbColumn[];
  relationships: DbRelationship[];
}

export interface DbBaseGroup {
  id: string;                   // "<file>:<BaseName>" or "unresolved"
  name: string;                 // e.g. "Base", or "Unresolved base"
  file: string | null;
  line: number | null;
  tables: DbTable[];            // sorted by fullName
}

export interface DbWarning { file: string; line: number | null; message: string }

export interface DbSchemaResult {
  workspaceId: string;
  scannedAt: number;            // Date.now() when the scan finished
  filesScanned: number;         // candidate source files read
  filesParsed: number;          // source files that passed the extractor prefilter and were parsed
  truncated: boolean;           // an entry/file cap was hit
  groups: DbBaseGroup[];        // sorted by file, then name; [] = no models found
  warnings: DbWarning[];        // capped at 200
}
