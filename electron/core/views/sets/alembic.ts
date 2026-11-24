// Alembic migrations as a timeline (view kind: timeline). One node per migration file (id = file, alias = revision id),
// edges down_revision -> revision (tuples for merge migrations), and the table operations of upgrade() as fields.
export const alembic = String.raw`version: 1
name: alembic
description: Alembic migration chain (kind timeline) with the table operations of each upgrade()
rules:
  # Single-line module docstring = the migration message (Alembic's default docstring is multi-line; those fall back to the next rule).
  - id: migration-message
    language: python
    files: ["**/versions/*.py"]
    query: |
      (module . (expression_statement (string (string_content) @doc (#match? @doc "^[^\n]+$")))
        (expression_statement (assignment left: (identifier) @k (#eq? @k "revision") right: (string (string_content) @rev))))
    emit: { node: { id: "@file", label: "@rev: @doc", kind: migration, subtitle: "@stem", aliases: ["@rev"] } }
  - id: migration
    language: python
    files: ["**/versions/*.py"]
    query: |
      (module (expression_statement (assignment left: (identifier) @k (#eq? @k "revision") right: (string (string_content) @rev))))
    emit: { node: { id: "@file", label: "@rev", kind: migration, subtitle: "@stem", aliases: ["@rev"] } }
  - id: root
    language: python
    files: ["**/versions/*.py"]
    query: |
      (module (expression_statement (assignment left: (identifier) @k (#eq? @k "down_revision") right: (none))))
    emit: { node: { id: "@file", role: start } }
  - id: parent
    language: python
    files: ["**/versions/*.py"]
    query: |
      (module (expression_statement (assignment left: (identifier) @k (#eq? @k "down_revision")
        right: [(string (string_content) @prev) (tuple (string (string_content) @prev)) (list (string (string_content) @prev))])))
    emit: { edge: { from: "@prev", to: "@file", kind: revision } }
  - id: table-op
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op
          (#any-of? @op "create_table" "drop_table" "rename_table" "batch_alter_table" "create_table_comment" "drop_table_comment"))
        arguments: (argument_list . (string (string_content) @table)))
    emit: { field: { node: "@file", id: "@op:@table", label: "@op @table" } }
  - id: add-column
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op (#eq? @op "add_column"))
        arguments: (argument_list . (string (string_content) @table)
          . (call arguments: (argument_list . (string (string_content) @column)))))
    emit: { field: { node: "@file", id: "@op:@table.@column", label: "@op @table.@column" } }
  - id: column-op
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op (#any-of? @op "drop_column" "alter_column"))
        arguments: (argument_list . (string (string_content) @table) . (string (string_content) @column)))
    emit: { field: { node: "@file", id: "@op:@table.@column", label: "@op @table.@column" } }
  # Named schema objects: op.create_index("ix", "table", ...), op.drop_index("ix", table_name="table"), op.f("ix") names.
  - id: named-op
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op
          (#any-of? @op "create_index" "drop_index" "create_unique_constraint" "create_check_constraint" "create_primary_key"
            "create_exclude_constraint" "drop_constraint"))
        arguments: (argument_list
          . [(string (string_content) @name)
             (call function: (attribute attribute: (identifier) @f (#eq? @f "f")) arguments: (argument_list . (string (string_content) @name)))]
          . [(string (string_content) @table)
             (keyword_argument name: (identifier) @kw (#eq? @kw "table_name") value: (string (string_content) @table))]))
    emit: { field: { node: "@file", id: "@op:@name", label: "@op @name on @table" } }
  - id: foreign-key
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op (#eq? @op "create_foreign_key"))
        arguments: (argument_list
          . [(string (string_content) @name)
             (call function: (attribute attribute: (identifier) @f (#eq? @f "f")) arguments: (argument_list . (string (string_content) @name)))
             (none) @name]
          . (string (string_content) @table) . (string (string_content) @target)))
    emit: { field: { node: "@file", id: "@op:@name", label: "@op @name: @table -> @target" } }
  - id: execute
    language: python
    files: ["**/versions/*.py"]
    within: { function: "upgrade*" }
    query: |
      (call function: (attribute object: (identifier) @o (#eq? @o "op") attribute: (identifier) @op (#eq? @op "execute"))
        arguments: (argument_list . (_) @sql))
    emit: { field: { node: "@file", id: "@op:@line", label: "@op (line @line)", detail: "@sql" } }
`;
