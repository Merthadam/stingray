import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class DataStack extends Stack {
  public readonly table: dynamodb.Table;
  public readonly uploads: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.table = new dynamodb.Table(this, 'Trips', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logs = new s3.Bucket(this, 'AccessLogs');
    this.uploads = new s3.Bucket(this, 'Uploads', { serverAccessLogsBucket: logs, versioned: true });
  }
}
