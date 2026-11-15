import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ApiStackProps extends StackProps {
  table: dynamodb.Table;
  uploads: s3.Bucket;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const queue = new sqs.Queue(this, 'Exports', { visibilityTimeout: Duration.minutes(5) });
    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { TABLE: props.table.tableName, QUEUE_URL: queue.queueUrl },
    });
    const worker = new lambda.Function(this, 'ExportWorker', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'worker.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: { BUCKET: props.uploads.bucketName },
    });
    props.table.grantReadWriteData(handler);
    queue.grantSendMessages(handler);
    queue.grantConsumeMessages(worker);
    props.uploads.grantPut(worker);
    const restApi = new apigw.LambdaRestApi(this, 'Api', { handler });
    restApi.node.addDependency(queue);
  }
}
