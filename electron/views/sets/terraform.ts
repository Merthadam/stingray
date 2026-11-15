// Terraform (HCL) resources, data sources, modules and outputs as a graph (view kind: graph; preview). Nodes are keyed by
// their Terraform address (aws_s3_bucket.logs, data.x.y, module.net, output.z) and grouped by file. Reference edges come
// from expressions inside the block; queries cannot search descendants, so the expression shapes are spelled out below.

// An address `root.a(.a2)` at the start of an expression (`aws_vpc.main.id`, `data.x.y.json`, `module.net.vpc_id`).
const REF = '(expression (variable_expr (identifier) @r) . (get_attr (identifier) @a) . (get_attr (identifier) @a2)?)';
// Expressions that contain another expression: list items, object values, "${...}" interpolations, function arguments.
const wrap = (x: string) => [
  `(expression (collection_value (tuple ${x})))`,
  `(expression (collection_value (object (object_elem val: ${x}))))`,
  `(expression (template_expr (quoted_template (template_interpolation ${x}))))`,
  `(expression (function_call (function_arguments ${x})))`,
];
const DEPTH1 = `[${[REF, ...wrap(REF)].join(' ')}]`;
const DEPTH2 = `[${[REF, ...wrap(DEPTH1)].join(' ')}]`;
// Attributes of the block body, of nested blocks (environment {}, statement {}) and of blocks nested in those.
const BODY = [
  `(body (attribute ${DEPTH2}))`,
  `(body (block (body (attribute ${DEPTH2}))))`,
  `(body (block (body (block (body (attribute ${DEPTH1}))))))`,
];
const LABEL = (c: string) => `(string_lit (template_literal) @${c})`;
// resource "type" "name" / data "type" "name" blocks and module "name" / output "name" blocks.
const TWO_LABELS = `(block (identifier) @b (#any-of? @b "resource" "data") . ${LABEL('l1')} . ${LABEL('l2')}`;
const ONE_LABEL = `(block (identifier) @b (#any-of? @b "module" "output") . ${LABEL('l1')}`;
const NOT_ADDRESS = '(#not-any-of? @r "data" "var" "local" "each" "count" "self" "path" "terraform")';
// References (including depends_on): from resource/data blocks and from module/output blocks, to resources/modules and
// to data sources; one rule for the block's own attributes and one for nested blocks (keeps each query under 8 KiB).
const REFERENCE_RULES = [
  { id: 'ref', block: TWO_LABELS, from: '@b.@l1.@l2', to: '@r.@a', predicate: NOT_ADDRESS },
  { id: 'ref-data', block: TWO_LABELS, from: '@b.@l1.@l2', to: 'data.@a.@a2', predicate: '(#eq? @r "data")' },
  { id: 'module-ref', block: ONE_LABEL, from: '@b.@l1', to: '@r.@a', predicate: NOT_ADDRESS },
  { id: 'module-ref-data', block: ONE_LABEL, from: '@b.@l1', to: 'data.@a.@a2', predicate: '(#eq? @r "data")' },
].flatMap(r => [[r.id, BODY.slice(0, 1)], [`${r.id}-nested`, BODY.slice(1)]].map(([id, bodies]) => `  - id: ${id}
    language: terraform
    query: |
      ${(bodies as string[]).map(body => `${r.block} ${body} ${r.predicate})`).join('\n      ')}
    emit: { edge: { from: "${r.from}", to: "${r.to}", kind: ref } }
`)).join('');

export const terraform = String.raw`version: 1
name: terraform
description: Terraform resources, data sources, modules and outputs with their references (kind graph, preview)
rules:
  - id: resource
    language: terraform
    query: |
      ${TWO_LABELS} (#eq? @b "resource"))
    emit: { node: { id: "@l1.@l2", label: "@l1.@l2", kind: resource, group: "@file", aliases: ["resource.@l1.@l2"] } }
  - id: data
    language: terraform
    query: |
      ${TWO_LABELS} (#eq? @b "data"))
    emit: { node: { id: "data.@l1.@l2", label: "data.@l1.@l2", kind: data, group: "@file" } }
  - id: module-source
    language: terraform
    query: |
      (block (identifier) @b (#eq? @b "module") . ${LABEL('name')}
        (body (attribute (identifier) @k (#eq? @k "source") (expression (literal_value ${LABEL('source')})))))
    emit: { node: { id: "module.@name", label: "module.@name", kind: module, subtitle: "@source", group: "@file" } }
  - id: module
    language: terraform
    query: |
      (block (identifier) @b (#eq? @b "module") . ${LABEL('name')})
    emit: { node: { id: "module.@name", label: "module.@name", kind: module, group: "@file" } }
  - id: output
    language: terraform
    query: |
      (block (identifier) @b (#eq? @b "output") . ${LABEL('name')})
    emit: { node: { id: "output.@name", label: "output.@name", kind: output, group: "@file" } }
${REFERENCE_RULES}`;
