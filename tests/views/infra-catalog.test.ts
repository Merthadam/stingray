// Cloud service catalog for Terraform/CDK views: matching and vendored icons.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { INFRA_CATALOG, INFRA_ICON_IDS, cdkService, infraServiceById, terraformService } from '../../shared/views/infra/catalog';

const icons = path.join(import.meta.dirname, '../../src/features/views/assets/infra-icons');

test('every icon the catalog references is vendored, ids are unique and docs are https', () => {
  for (const id of INFRA_ICON_IDS) assert.ok(existsSync(path.join(icons, `${id}.svg`)), id);
  assert.equal(new Set(INFRA_CATALOG.map(e => e.id)).size, INFRA_CATALOG.length);
  for (const e of INFRA_CATALOG) {
    assert.match(e.docUrl, /^https:\/\//, e.id);
    assert.ok(e.id.startsWith(`${e.provider}/`) && e.description.length > 20, e.id);
  }
  const count = (p: string) => INFRA_CATALOG.filter(e => e.provider === p).length;
  assert.ok(count('aws') >= 60 && count('azure') >= 30 && count('gcp') >= 20);
});

test('terraform types: exact, longest prefix, wildcard, provider fallback, non-cloud null', () => {
  const id = (t: string) => terraformService(t)?.id ?? null;
  assert.equal(id('aws_s3_bucket'), 'aws/s3');
  assert.equal(id('aws_s3_bucket_policy'), 'aws/s3');
  assert.equal(id('aws_lambda_function'), 'aws/lambda');
  assert.equal(id('aws_instance'), 'aws/ec2');
  assert.equal(id('aws_vpc'), 'aws/vpc');
  assert.equal(id('aws_vpc_endpoint'), 'aws/privatelink');       // longer prefix than aws_vpc*
  assert.equal(id('aws_cloudwatch_event_rule'), 'aws/eventbridge'); // longer than aws_cloudwatch_*
  assert.equal(id('aws_cloudwatch_log_group'), 'aws/cloudwatch');
  assert.equal(id('aws_kinesis_firehose_delivery_stream'), 'aws/firehose');
  assert.equal(id('aws_rds_cluster'), 'aws/aurora');
  assert.equal(id('aws_iam_policy_document'), 'aws/iam');         // data source type
  assert.equal(id('aws_lb_listener'), 'aws/elb');
  assert.equal(id('azurerm_storage_account'), 'azure/storage-account');
  assert.equal(id('azurerm_cognitive_deployment'), 'azure/openai'); // exact beats azurerm_cognitive_*
  assert.equal(id('azurerm_linux_function_app'), 'azure/functions');
  assert.equal(id('google_storage_bucket'), 'gcp/cloud-storage');
  assert.equal(id('google_storage_bucket_iam_member'), 'gcp/iam'); // google_*_iam_member wildcard beats google_storage_*
  assert.equal(id('google_cloud_run_v2_service'), 'gcp/cloud-run');
  assert.equal(id('aws_made_up_thing'), 'aws/generic');
  assert.equal(id('azurerm_made_up'), 'azure/generic');
  assert.equal(id('google_made_up'), 'gcp/generic');
  for (const t of ['azurerm_managed_disk', 'azurerm_cdn_profile', 'azurerm_role_assignment', 'azuread_application'])
    assert.equal(id(t), 'azure/generic', `${t}: no icon of another product`);
  assert.equal(id('random_password'), null);
  assert.equal(id('null_resource'), null);
});

test('cdk constructors: module-qualified, aliased, bare, L1 Cfn, unknown', () => {
  const id = (c: string) => cdkService(c)?.id ?? null;
  assert.equal(id('s3.Bucket'), 'aws/s3');
  assert.equal(id('Bucket'), 'aws/s3');
  assert.equal(id('cdk.aws_s3.Bucket'), 'aws/s3');
  assert.equal(id('lambda.Function'), 'aws/lambda');
  assert.equal(id('Function'), 'aws/lambda');
  assert.equal(id('cloudfront.Function'), 'aws/cloudfront');      // module beats the bare class
  assert.equal(id('NodejsFunction'), 'aws/lambda');
  assert.equal(id('lambda_nodejs.NodejsFunction'), 'aws/lambda');
  assert.equal(id('apigw.LambdaRestApi'), 'aws/api-gateway');     // import alias
  assert.equal(id('ec2.Vpc'), 'aws/vpc');
  assert.equal(id('ec2.Instance'), 'aws/ec2');                     // module default
  assert.equal(id('ecs.FargateService'), 'aws/fargate');
  assert.equal(id('ecs_patterns.ApplicationLoadBalancedFargateService'), 'aws/fargate');
  assert.equal(id('ecs.Cluster'), 'aws/ecs');
  assert.equal(id('rds.DatabaseInstance'), 'aws/rds');
  assert.equal(id('rds.DatabaseCluster'), 'aws/aurora');
  assert.equal(id('logs.LogGroup'), 'aws/cloudwatch');
  assert.equal(id('sfn.StateMachine'), 'aws/step-functions');
  assert.equal(id('CfnBucket'), 'aws/s3');
  assert.equal(id('s3.CfnBucket'), 'aws/s3');
  assert.equal(id('Stack'), 'aws/cloudformation');
  assert.equal(id('MyCustomConstruct'), null);
  assert.equal(id('acme.Widget'), null);
  assert.equal(id('acme.Table'), null, 'an unknown module does not fall back to the bare class');
  assert.equal(id('ec2.CfnSecurityGroup'), 'aws/vpc', 'module-qualified L1 classes use their L2 name before module.*');
  assert.equal(id('s3deploy.BucketDeployment'), 'aws/s3');
});

test('infraServiceById finds catalog entries and fallbacks only', () => {
  assert.equal(infraServiceById('aws/s3')?.name, 'Amazon S3');
  assert.equal(infraServiceById('aws/cdk')?.name, 'CDK construct');
  assert.equal(infraServiceById('https://evil.example'), null);
  assert.equal('terraform' in infraServiceById('aws/s3')!, false);
});
