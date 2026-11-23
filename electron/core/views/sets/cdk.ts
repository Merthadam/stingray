// AWS CDK (TypeScript) stacks and constructs as a graph (view kind: graph; preview). Stacks are classes extending *Stack
// (id = class name); constructs are `new X(this, 'Id', ...)` inside a class (id = "<Class>/<Id>", grouped by class).
// Variables holding constructs are aliases "<Class>:<var>" (top-level code has class "", so ":<var>"), which grants,
// props and addDependency edges use. `this.x = new ...` fields are also "prop:<x>", so `props.x` in another stack links
// to them by property name — a heuristic, so those edges are dashed (certain: false).
const NEW = (args: string, predicate = '') =>
  `(new_expression constructor: [(identifier) @type (member_expression property: (property_identifier) @type)] arguments: (arguments ${args})${predicate})`;
// @type is the constructor as written (`s3.Bucket`, `Bucket`), so the module tells the cloud service apart (shared/views/infra/catalog.ts).
const CONSTRUCT = '(new_expression constructor: [(identifier) (member_expression)] @type arguments: (arguments . (this) . (string (string_fragment) @cid)))';
// A construct reference: `queue`, `this.table`, `props.table`.
const REF = `[(identifier) @ref (member_expression object: (this) property: (property_identifier) @ref)]`;
const PROP_REF = `(member_expression object: (identifier) @p (#eq? @p "props") property: (property_identifier) @ref)`;

export const cdk = String.raw`version: 1
name: cdk
description: AWS CDK stacks and constructs with grants, props and dependencies (kind graph, preview)
rules:
  - id: stack
    language: typescript
    query: |
      (class_declaration name: (type_identifier) @name
        (class_heritage (extends_clause value: [(identifier) @base (member_expression property: (property_identifier) @base)]
          (#match? @base "Stack$"))))
    emit: { node: { id: "@name", label: "@name", kind: stack, subtitle: "@base", group: "@name", symbol: "@name" } }
  - id: stack-group
    language: typescript
    query: |
      (class_declaration name: (type_identifier) @name
        (class_heritage (extends_clause value: [(identifier) @base (member_expression property: (property_identifier) @base)]
          (#match? @base "Stack$"))))
    emit: { group: { id: "@name", label: "@name (@file)" } }
  # const handler = new lambda.Function(this, 'Handler', ...)
  - id: construct-var
    language: typescript
    within: { class: "?*" }
    query: |
      (variable_declarator name: (identifier) @var value: ${CONSTRUCT})
    emit: { node: { id: "@class/@cid", label: "@cid", kind: construct, subtitle: "@type", group: "@class", aliases: ["@class:@var"] } }
  # this.table = new dynamodb.Table(this, 'Trips', ...)
  - id: construct-field
    language: typescript
    within: { class: "?*" }
    query: |
      (assignment_expression left: (member_expression object: (this) property: (property_identifier) @var) right: ${CONSTRUCT})
    emit: { node: { id: "@class/@cid", label: "@cid", kind: construct, subtitle: "@type", group: "@class", aliases: ["@class:@var", "prop:@var"] } }
  - id: construct
    language: typescript
    within: { class: "?*" }
    query: |
      ${CONSTRUCT}
    emit: { node: { id: "@class/@cid", label: "@cid", kind: construct, subtitle: "@type", group: "@class" } }
  # const data = new DataStack(app, 'TravelData', ...) at the app level: the variable names the stack class.
  - id: stack-instance
    language: typescript
    query: |
      (variable_declarator name: (identifier) @var value: ${NEW(`. (_) . (string (string_fragment) @sid)`, ' (#match? @type "Stack$")')})
    emit: { node: { id: "@type", aliases: ["@class:@var"], detail: "@sid" } }
  # bucket.grantRead(fn), props.table.grantReadWriteData(handler): grantee -> resource.
  - id: grant
    language: typescript
    query: |
      (call_expression
        function: (member_expression object: ${REF} property: (property_identifier) @g (#match? @g "^grant"))
        arguments: (arguments . ${REF.replace(/@ref/g, '@to')}))
    emit: { edge: { from: "@class:@to", to: "@class:@ref", kind: grant, label: "@g" } }
  - id: grant-prop
    language: typescript
    query: |
      (call_expression
        function: (member_expression object: ${PROP_REF} property: (property_identifier) @g (#match? @g "^grant"))
        arguments: (arguments . ${REF.replace(/@ref/g, '@to')}))
    emit: { edge: { from: "@class:@to", to: "prop:@ref", kind: grant, label: "@g", certain: false } }
  # new X(this, 'Id', { handler }) / { bucket: logs } / { table: props.table }: the construct uses the passed construct.
  - id: uses
    language: typescript
    within: { class: "?*" }
    query: |
      ${NEW(`. (this) . (string (string_fragment) @cid) . (object [(shorthand_property_identifier) @ref (pair key: (property_identifier) @key value: ${REF})])`)}
    emit: { edge: { from: "@class/@cid", to: "@class:@ref", kind: uses, certain: false } }
  - id: uses-prop
    language: typescript
    within: { class: "?*" }
    query: |
      ${NEW(`. (this) . (string (string_fragment) @cid) . (object (pair key: (property_identifier) @key value: ${PROP_REF}))`)}
    emit: { edge: { from: "@class/@cid", to: "prop:@ref", kind: uses, certain: false } }
  # new ApiStack(app, 'Api', { table: data.table }): the stack uses the other stack's construct.
  - id: stack-uses
    language: typescript
    query: |
      ${NEW(`. (_) . (string) . (object (pair value: (member_expression object: (identifier) @v property: (property_identifier) @ref)))`, ' (#match? @type "Stack$")')}
    emit: { edge: { from: "@type", to: "prop:@ref", kind: uses, certain: false } }
  # api.addDependency(data), restApi.node.addDependency(queue)
  - id: depends
    language: typescript
    query: |
      (call_expression
        function: (member_expression
          object: [${REF.replace(/@ref/g, '@a')} (member_expression object: ${REF.replace(/@ref/g, '@a')} property: (property_identifier) @n (#eq? @n "node"))]
          property: (property_identifier) @m (#eq? @m "addDependency"))
        arguments: (arguments . ${REF.replace(/@ref/g, '@b')}))
    emit: { edge: { from: "@class:@a", to: "@class:@b", kind: depends } }
`;
