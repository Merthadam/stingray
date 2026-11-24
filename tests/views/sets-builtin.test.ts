// Builtin rule sets evaluated on the sample projects in tests/fixtures/views/.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { ViewKind } from '../../shared/contracts/views';
import { evaluate, createFileProvider, codegraphGrammarDir, parseRuleFileYaml, BUILTIN_SETS, TS_EXTRACTORS, EXTRACTOR_DESCRIPTIONS, withInfraServices } from '../../electron/app/wiring/views';

const fixtures = path.join(import.meta.dirname, '../fixtures/views');
const KINDS: Record<string, ViewKind> = { alembic: 'timeline', langgraph: 'flow', terraform: 'graph', cdk: 'graph' };

async function run(name: string) {
  const { rules } = parseRuleFileYaml(BUILTIN_SETS[name].yaml, null, name, `builtin/${name}`); // throws on schema errors
  const out = await evaluate({
    view: { id: name, kind: KINDS[name], scope: { include: ['**/*'], exclude: [] }, rules, graph: null, flowchart: null, builtins: [], include: [], exclude: [] },
    files: createFileProvider(path.join(fixtures, name)), graph: null, graphStatus: { state: 'indexing', message: null }, grammarDir: codegraphGrammarDir(),
  });
  const label = (id: string) => out.nodes.find(n => n.id === id)?.label ?? id;
  return { out, edges: out.edges.map(e => `${label(e.from)} ${e.certain ? '->' : '..>'} ${label(e.to)}${e.label ? ` [${e.label}]` : ''}`).sort() };
}

test('every builtin set parses and evaluates its fixture without rule errors or unresolved references', async () => {
  assert.deepEqual(Object.keys(BUILTIN_SETS).sort(), Object.keys(KINDS).sort());
  for (const name of Object.keys(KINDS)) {
    const { out } = await run(name);
    assert.deepEqual(out.diagnostics.rules.flatMap(r => r.errors), [], name);
    assert.deepEqual(out.diagnostics.unresolved, [], name);
    assert.deepEqual(out.warnings, [], name);
    assert.ok(out.nodes.length > 0, name);
  }
});

test('alembic: migration chain with merge, root role and upgrade() operations only', async () => {
  const { out, edges } = await run('alembic');
  assert.deepEqual(out.nodes.map(n => [n.label, n.role]), [
    ['0001', 'start'], ['0002: Add destination pins', null], ['0003: Add conversations', null], ['0004: Merge heads', null]]);
  assert.deepEqual(edges, [
    '0001 -> 0002: Add destination pins', '0001 -> 0003: Add conversations',
    '0002: Add destination pins -> 0004: Merge heads', '0003: Add conversations -> 0004: Merge heads']);
  assert.deepEqual(out.nodes.map(n => n.fields.map(f => f.label)), [
    ['create_table plans', 'create_index ix_plans_title on plans'],
    ['create_table destination_pins', 'add_column plans.budget', 'create_foreign_key fk_pins_plan: destination_pins -> plans'],
    ['create_table conversations'],
    ['alter_column plans.title', 'execute (line 10)'],
  ]);
});

test('langgraph: steps with handlers, START/END roles, labelled conditional branches', async () => {
  const { out, edges } = await run('langgraph');
  assert.deepEqual(out.groups.map(g => g.label), ['builder']);
  assert.deepEqual(out.nodes.map(n => [n.label, n.role, n.subtitle, n.detail]), [
    ['chat', null, 'ConversationNode', 'ConversationNode(adapter)'], ['plan', null, 'plan_node', 'plan_node'],
    ['summarize', null, 'summarize', null], ['START', 'start', null, null], ['END', 'end', null, null]]);
  assert.deepEqual(edges, [
    'START ..> chat [else]', 'START ..> plan [1. needs_plan]', 'chat -> END', 'plan ..> plan [retry]', 'plan ..> summarize [done]', 'summarize -> END'].sort());
});

test('terraform: resources, data sources, modules and outputs with reference edges', async () => {
  const { out, edges } = await run('terraform');
  const ids = out.nodes.map(n => n.id);
  for (const id of ['aws_vpc.main', 'aws_lambda_function.api', 'data.aws_iam_policy_document.assume_lambda', 'module.network', 'module.storage', 'output.vpc_id'])
    assert.ok(ids.includes(id), id);
  for (const e of ['aws_lambda_function.api -> aws_iam_role.lambda', 'module.storage -> module.network', 'aws_subnet.private -> aws_vpc.main',
    'aws_iam_role.lambda -> data.aws_iam_policy_document.assume_lambda', 'output.bucket_name -> aws_s3_bucket.uploads'])
    assert.ok(edges.includes(e), e);
});

test('cdk: stacks, constructs grouped by stack, grants, props and dependencies', async () => {
  const { out, edges } = await run('cdk');
  assert.deepEqual(out.nodes.map(n => `${n.group}/${n.label}:${n.subtitle}`).sort(), [
    'ApiStack/Api:apigw.LambdaRestApi', 'ApiStack/ApiStack:Stack', 'ApiStack/ExportWorker:lambda.Function', 'ApiStack/Exports:sqs.Queue',
    'ApiStack/Handler:lambda.Function', 'DataStack/AccessLogs:s3.Bucket', 'DataStack/DataStack:Stack', 'DataStack/Trips:dynamodb.Table',
    'DataStack/Uploads:s3.Bucket']);
  assert.deepEqual(edges, [
    'Api ..> Handler', 'Api -> Exports', 'ApiStack ..> Trips', 'ApiStack ..> Uploads', 'ApiStack -> DataStack',
    'ExportWorker ..> Uploads [grantPut]', 'ExportWorker -> Exports [grantConsumeMessages]',
    'Handler ..> Trips [grantReadWriteData]', 'Handler -> Exports [grantSendMessages]', 'Uploads ..> AccessLogs'].sort());
});

test('terraform and cdk nodes get their cloud service; groups of one cloud get its provider', async () => {
  const { out: tf } = await run('terraform');
  const view = (name: string) => ({ rules: parseRuleFileYaml(BUILTIN_SETS[name].yaml, null, name, `builtin/${name}`).rules });
  const t = withInfraServices(view('terraform'), tf.nodes, tf.groups);
  const tfService = (id: string) => t.nodes.find(n => n.id === id)?.service?.id ?? null;
  assert.equal(tfService('aws_lambda_function.api'), 'aws/lambda');
  assert.equal(tfService('aws_vpc.main'), 'aws/vpc');
  assert.equal(tfService('data.aws_iam_policy_document.assume_lambda'), 'aws/iam');
  assert.equal(tfService('module.network'), null);
  assert.equal(tfService('output.vpc_id'), null);
  assert.deepEqual(t.groups.map(g => `${g.id}:${g.provider ?? '-'}`), ['main.tf:aws', 'modules/network/main.tf:aws', 'modules/storage/main.tf:aws', 'outputs.tf:-']);

  const { out: cdk } = await run('cdk');
  const c = withInfraServices(view('cdk'), cdk.nodes, cdk.groups);
  assert.deepEqual(c.nodes.map(n => `${n.label}:${n.service?.id}`).sort(), [
    'AccessLogs:aws/s3', 'Api:aws/api-gateway', 'ApiStack:aws/cloudformation', 'DataStack:aws/cloudformation', 'ExportWorker:aws/lambda',
    'Exports:aws/sqs', 'Handler:aws/lambda', 'Trips:aws/dynamodb', 'Uploads:aws/s3']);
  assert.deepEqual(c.groups.map(g => g.provider), ['aws', 'aws']);
  // Other sets (and repo rules) are untouched.
  const { out: lg } = await run('langgraph');
  assert.equal(withInfraServices(view('langgraph'), lg.nodes, lg.groups).nodes, lg.nodes);
});

test('TypeScript extractor sets include SQL with a distinct description', () => {
  assert.deepEqual(TS_EXTRACTORS, ['sqlalchemy', 'sql']);
  assert.match(EXTRACTOR_DESCRIPTIONS.sql, /SQL DDL/);
});
