// Cloud services that Terraform resources and AWS CDK constructs map to, for drawing infra views like AWS/Azure
// architecture diagrams. Pure data shared by the main process (matching) and the renderer (icons, inspector).
// A service id is also its icon path: src/assets/infra-icons/<id>.svg (official AWS, Azure and Google Cloud icons).

export type InfraProvider = 'aws' | 'azure' | 'gcp';
export type InfraCategory = 'compute' | 'containers' | 'storage' | 'database' | 'networking' | 'security' | 'integration'
  | 'analytics' | 'management' | 'ml' | 'devtools' | 'general';

export interface InfraService {
  id: string;                  // "<provider>/<key>", e.g. "aws/s3"; also the icon file
  provider: InfraProvider;
  name: string;                // e.g. "Amazon S3"
  category: InfraCategory;
  description: string;         // what the service does, 1-2 plain sentences
  docUrl: string;              // official documentation (https)
}

interface CatalogEntry extends InfraService {
  terraform: string[];         // resource/data types: exact, or a prefix ending in "*" (longest match wins)
  cdk: string[];               // construct classes: "module.Class", "module.*" (any class of the module) or a bare "Class"
}

const entry = (provider: InfraProvider) => (key: string, name: string, category: InfraCategory, description: string, docUrl: string,
  terraform: string[] = [], cdk: string[] = []): CatalogEntry => ({ id: `${provider}/${key}`, provider, name, category, description, docUrl, terraform, cdk });
const aws = entry('aws'), azure = entry('azure'), gcp = entry('gcp');
const awsDocs = (path: string) => `https://docs.aws.amazon.com/${path}/`;

export const INFRA_CATALOG: CatalogEntry[] = [
  // ---- AWS ----
  aws('s3', 'Amazon S3', 'storage', 'Object storage for files of any size, organised in buckets. Used for uploads, static assets, backups and data lakes.',
    awsDocs('s3'), ['aws_s3_*'], ['s3.*', 'Bucket', 'BucketPolicy', 's3_deployment.*', 's3_notifications.*']),
  aws('glacier', 'Amazon S3 Glacier', 'storage', 'Low-cost archive storage for data that is rarely read, with retrieval times from minutes to hours.',
    'https://docs.aws.amazon.com/amazonglacier/latest/dev/introduction.html', ['aws_glacier_*'], ['glacier.*']),
  aws('lambda', 'AWS Lambda', 'compute', 'Runs your code in response to events without servers to manage; you pay only for the compute time used.',
    awsDocs('lambda'), ['aws_lambda_*'], ['lambda.*', 'lambda_nodejs.*', 'lambda_python.*', 'lambda_go.*', 'lambda_event_sources.*', 'NodejsFunction', 'PythonFunction', 'GoFunction', 'DockerImageFunction', 'SingletonFunction', 'Function', 'Alias', 'LayerVersion', 'EventSourceMapping']),
  aws('ec2', 'Amazon EC2', 'compute', 'Virtual servers in the cloud with configurable CPU, memory, storage and networking.',
    awsDocs('ec2'), ['aws_instance', 'aws_ec2_*', 'aws_ami*', 'aws_key_pair', 'aws_launch_template', 'aws_launch_configuration', 'aws_eip*', 'aws_placement_group', 'aws_spot_*', 'aws_availability_zones'],
    ['ec2.*', 'Instance', 'LaunchTemplate', 'BastionHostLinux', 'MachineImage']),
  aws('ebs', 'Amazon EBS', 'storage', 'Block storage volumes that attach to EC2 instances like virtual hard disks.',
    awsDocs('ebs'), ['aws_ebs_*', 'aws_volume_attachment'], ['ec2.Volume', 'Volume']),
  aws('autoscaling', 'Amazon EC2 Auto Scaling', 'compute', 'Keeps a group of EC2 instances at the right size, adding or removing instances as demand changes.',
    awsDocs('autoscaling'), ['aws_autoscaling_*'], ['autoscaling.*', 'AutoScalingGroup']),
  aws('vpc', 'Amazon VPC', 'networking', 'A logically isolated private network for your AWS resources, with subnets, route tables, gateways and security groups.',
    awsDocs('vpc'), ['aws_vpc*', 'aws_subnet', 'aws_route_table*', 'aws_route', 'aws_internet_gateway*', 'aws_nat_gateway', 'aws_security_group*', 'aws_network_acl*', 'aws_network_interface*', 'aws_egress_only_internet_gateway', 'aws_default_*', 'aws_flow_log', 'aws_subnets'],
    ['ec2.Vpc', 'ec2.Subnet', 'ec2.PublicSubnet', 'ec2.PrivateSubnet', 'ec2.SecurityGroup', 'ec2.InterfaceVpcEndpoint', 'ec2.GatewayVpcEndpoint', 'ec2.FlowLog', 'Vpc', 'SecurityGroup', 'Subnet']),
  aws('transit-gateway', 'AWS Transit Gateway', 'networking', 'A central hub that connects VPCs and on-premises networks through a single gateway.',
    awsDocs('vpc/latest/tgw'), ['aws_ec2_transit_gateway*']),
  aws('vpn', 'AWS Site-to-Site VPN', 'networking', 'Encrypted IPsec tunnels between your on-premises network and your VPCs.',
    awsDocs('vpn'), ['aws_vpn_*', 'aws_customer_gateway'], ['ec2.VpnConnection', 'ec2.VpnGateway']),
  aws('direct-connect', 'AWS Direct Connect', 'networking', 'A dedicated private network connection from your premises to AWS.',
    awsDocs('directconnect'), ['aws_dx_*']),
  aws('elb', 'Elastic Load Balancing', 'networking', 'Distributes incoming traffic across targets such as EC2 instances, containers and Lambda functions (Application, Network and Gateway Load Balancers).',
    awsDocs('elasticloadbalancing'), ['aws_lb*', 'aws_alb*', 'aws_elb*'], ['elasticloadbalancingv2.*', 'elasticloadbalancing.*', 'ApplicationLoadBalancer', 'NetworkLoadBalancer', 'ApplicationTargetGroup', 'NetworkTargetGroup', 'ApplicationListener']),
  aws('route53', 'Amazon Route 53', 'networking', 'Scalable DNS: registers domains and routes users to your applications by name, with health checks.',
    awsDocs('route53'), ['aws_route53_*'], ['route53.*', 'route53_targets.*', 'HostedZone', 'PublicHostedZone', 'PrivateHostedZone', 'ARecord', 'CnameRecord']),
  aws('cloudfront', 'Amazon CloudFront', 'networking', 'Content delivery network that caches and serves your content from edge locations close to users.',
    awsDocs('cloudfront'), ['aws_cloudfront_*'], ['cloudfront.*', 'cloudfront_origins.*', 'Distribution', 'CloudFrontWebDistribution', 'OriginAccessIdentity']),
  aws('global-accelerator', 'AWS Global Accelerator', 'networking', 'Routes users over the AWS global network to the nearest healthy application endpoint through static anycast IPs.',
    awsDocs('global-accelerator'), ['aws_globalaccelerator_*'], ['globalaccelerator.*']),
  aws('api-gateway', 'Amazon API Gateway', 'networking', 'Creates, publishes and secures REST, HTTP and WebSocket APIs in front of your backends.',
    awsDocs('apigateway'), ['aws_api_gateway_*', 'aws_apigatewayv2_*'], ['apigateway.*', 'apigatewayv2.*', 'apigatewayv2_integrations.*', 'RestApi', 'LambdaRestApi', 'SpecRestApi', 'HttpApi', 'WebSocketApi']),
  aws('appsync', 'AWS AppSync', 'integration', 'Managed GraphQL and real-time APIs that connect clients to data sources such as DynamoDB and Lambda.',
    awsDocs('appsync'), ['aws_appsync_*'], ['appsync.*', 'GraphqlApi']),
  aws('dynamodb', 'Amazon DynamoDB', 'database', 'Serverless NoSQL key-value and document database with single-digit millisecond latency at any scale.',
    awsDocs('dynamodb'), ['aws_dynamodb_*'], ['dynamodb.*', 'Table', 'TableV2']),
  aws('rds', 'Amazon RDS', 'database', 'Managed relational databases (PostgreSQL, MySQL, MariaDB, Oracle, SQL Server) with backups, patching and failover.',
    awsDocs('rds'), ['aws_db_*', 'aws_rds_*'], ['rds.*', 'DatabaseInstance', 'DatabaseInstanceFromSnapshot', 'DatabaseProxy', 'ServerlessCluster']),
  aws('aurora', 'Amazon Aurora', 'database', 'MySQL- and PostgreSQL-compatible relational database built for the cloud, with storage that grows automatically.',
    awsDocs('AmazonRDS/latest/AuroraUserGuide'), ['aws_rds_cluster*'], ['rds.DatabaseCluster', 'DatabaseCluster']),
  aws('elasticache', 'Amazon ElastiCache', 'database', 'Managed in-memory cache (Redis OSS, Valkey, Memcached) for sub-millisecond reads.',
    awsDocs('elasticache'), ['aws_elasticache_*'], ['elasticache.*']),
  aws('memorydb', 'Amazon MemoryDB', 'database', 'Durable in-memory database compatible with Redis OSS and Valkey.',
    awsDocs('memorydb'), ['aws_memorydb_*'], ['memorydb.*']),
  aws('documentdb', 'Amazon DocumentDB', 'database', 'Managed document database compatible with MongoDB workloads.',
    awsDocs('documentdb'), ['aws_docdb_*'], ['docdb.*']),
  aws('neptune', 'Amazon Neptune', 'database', 'Managed graph database for highly connected data.',
    awsDocs('neptune'), ['aws_neptune_*'], ['neptune.*']),
  aws('redshift', 'Amazon Redshift', 'analytics', 'Data warehouse for running SQL analytics over large structured and semi-structured datasets.',
    awsDocs('redshift'), ['aws_redshift*'], ['redshift.*']),
  aws('opensearch', 'Amazon OpenSearch Service', 'analytics', 'Managed OpenSearch clusters for search, log analytics and observability.',
    awsDocs('opensearch-service'), ['aws_opensearch_*', 'aws_elasticsearch_*'], ['opensearchservice.*', 'elasticsearch.*']),
  aws('efs', 'Amazon EFS', 'storage', 'Managed NFS file system that many EC2 instances, containers and Lambda functions can share.',
    awsDocs('efs'), ['aws_efs_*'], ['efs.*', 'FileSystem', 'AccessPoint']),
  aws('fsx', 'Amazon FSx', 'storage', 'Managed file systems such as Windows File Server, Lustre, NetApp ONTAP and OpenZFS.',
    awsDocs('fsx'), ['aws_fsx_*'], ['fsx.*']),
  aws('backup', 'AWS Backup', 'storage', 'Centrally schedules, stores and restores backups across AWS services.',
    awsDocs('aws-backup'), ['aws_backup_*'], ['backup.*', 'BackupPlan', 'BackupVault']),
  aws('sqs', 'Amazon SQS', 'integration', 'Fully managed message queue that decouples producers from consumers.',
    awsDocs('sqs'), ['aws_sqs_*'], ['sqs.*', 'Queue']),
  aws('sns', 'Amazon SNS', 'integration', 'Pub/sub messaging that fans out notifications to queues, functions, HTTP endpoints, email and SMS.',
    awsDocs('sns'), ['aws_sns_*'], ['sns.*', 'sns_subscriptions.*', 'Topic', 'Subscription']),
  aws('eventbridge', 'Amazon EventBridge', 'integration', 'Serverless event bus that routes events between AWS services, your apps and SaaS; also runs schedules.',
    awsDocs('eventbridge'), ['aws_cloudwatch_event_*', 'aws_scheduler_*', 'aws_pipes_*'], ['events.*', 'events_targets.*', 'scheduler.*', 'pipes.*', 'Rule', 'EventBus', 'Schedule']),
  aws('step-functions', 'AWS Step Functions', 'integration', 'Visual workflows that coordinate Lambda functions and AWS services into state machines.',
    awsDocs('step-functions'), ['aws_sfn_*'], ['stepfunctions.*', 'stepfunctions_tasks.*', 'StateMachine']),
  aws('mq', 'Amazon MQ', 'integration', 'Managed message brokers for Apache ActiveMQ and RabbitMQ.',
    awsDocs('amazon-mq'), ['aws_mq_*'], ['amazonmq.*']),
  aws('kinesis', 'Amazon Kinesis Data Streams', 'analytics', 'Captures and stores streaming data in real time for consumers to process.',
    awsDocs('streams/latest/dev'), ['aws_kinesis_stream*', 'aws_kinesis_*'], ['kinesis.*', 'Stream']),
  aws('firehose', 'Amazon Data Firehose', 'analytics', 'Loads streaming data into destinations such as S3, Redshift and OpenSearch.',
    awsDocs('firehose'), ['aws_kinesis_firehose_*'], ['kinesisfirehose.*', 'DeliveryStream']),
  aws('msk', 'Amazon MSK', 'analytics', 'Managed Apache Kafka clusters for event streaming.',
    awsDocs('msk'), ['aws_msk_*'], ['msk.*']),
  aws('glue', 'AWS Glue', 'analytics', 'Serverless data integration: crawlers, a data catalog and ETL jobs that prepare data for analytics.',
    awsDocs('glue'), ['aws_glue_*'], ['glue.*']),
  aws('athena', 'Amazon Athena', 'analytics', 'Runs SQL queries directly on data in S3 without servers to manage.',
    awsDocs('athena'), ['aws_athena_*'], ['athena.*']),
  aws('emr', 'Amazon EMR', 'analytics', 'Managed big-data clusters for Spark, Hive and other open-source frameworks.',
    awsDocs('emr'), ['aws_emr*'], ['emr.*', 'emrserverless.*']),
  aws('ecs', 'Amazon ECS', 'containers', 'Runs and scales Docker containers as services and tasks on EC2 or Fargate.',
    awsDocs('ecs'), ['aws_ecs_*'], ['ecs.*', 'ecs_patterns.*', 'Cluster', 'TaskDefinition', 'Ec2Service', 'ContainerDefinition']),
  aws('fargate', 'AWS Fargate', 'containers', 'Serverless compute for containers: runs ECS and EKS tasks without managing servers.',
    'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html', [],
    ['ecs.FargateService', 'ecs.FargateTaskDefinition', 'FargateService', 'FargateTaskDefinition', 'ecs_patterns.ApplicationLoadBalancedFargateService', 'ecs_patterns.NetworkLoadBalancedFargateService', 'ecs_patterns.QueueProcessingFargateService', 'ecs_patterns.ScheduledFargateTask', 'ApplicationLoadBalancedFargateService', 'NetworkLoadBalancedFargateService', 'QueueProcessingFargateService', 'ScheduledFargateTask']),
  aws('eks', 'Amazon EKS', 'containers', 'Managed Kubernetes control plane and worker nodes on AWS.',
    awsDocs('eks'), ['aws_eks_*'], ['eks.*']),
  aws('ecr', 'Amazon ECR', 'containers', 'Private container image registry for Docker and OCI images.',
    awsDocs('ecr'), ['aws_ecr_*', 'aws_ecrpublic_*'], ['ecr.*', 'ecr_assets.*', 'DockerImageAsset']),
  aws('app-runner', 'AWS App Runner', 'containers', 'Deploys web apps and APIs from source or a container image with automatic scaling and TLS.',
    awsDocs('apprunner'), ['aws_apprunner_*'], ['apprunner.*']),
  aws('batch', 'AWS Batch', 'compute', 'Runs batch computing jobs at any scale on managed compute environments.',
    awsDocs('batch'), ['aws_batch_*'], ['batch.*']),
  aws('elastic-beanstalk', 'AWS Elastic Beanstalk', 'compute', 'Deploys and scales web applications on managed EC2 environments.',
    awsDocs('elastic-beanstalk'), ['aws_elastic_beanstalk_*'], ['elasticbeanstalk.*']),
  aws('lightsail', 'Amazon Lightsail', 'compute', 'Simple virtual servers, databases and containers with predictable monthly pricing.',
    awsDocs('lightsail'), ['aws_lightsail_*'], ['lightsail.*']),
  aws('iam', 'AWS IAM', 'security', 'Controls who can access which AWS resources through users, roles and policies.',
    awsDocs('iam'), ['aws_iam_*', 'aws_caller_identity'], ['iam.*', 'Role', 'Policy', 'ManagedPolicy', 'PolicyStatement', 'User', 'Group', 'OpenIdConnectProvider']),
  aws('identity-center', 'AWS IAM Identity Center', 'security', 'Single sign-on access for workforce users across AWS accounts and applications.',
    awsDocs('singlesignon'), ['aws_ssoadmin_*', 'aws_identitystore_*']),
  aws('cognito', 'Amazon Cognito', 'security', 'User sign-up, sign-in and access control for web and mobile apps.',
    awsDocs('cognito'), ['aws_cognito_*'], ['cognito.*', 'UserPool', 'UserPoolClient', 'UserPoolDomain']),
  aws('kms', 'AWS KMS', 'security', 'Creates and controls the encryption keys that protect your data.',
    awsDocs('kms'), ['aws_kms_*'], ['kms.*', 'Key']),
  aws('secrets-manager', 'AWS Secrets Manager', 'security', 'Stores, rotates and retrieves secrets such as database credentials and API keys.',
    awsDocs('secretsmanager'), ['aws_secretsmanager_*'], ['secretsmanager.*', 'Secret', 'RotationSchedule']),
  aws('acm', 'AWS Certificate Manager', 'security', 'Provisions and renews TLS certificates for your domains.',
    awsDocs('acm'), ['aws_acm_*', 'aws_acmpca_*'], ['certificatemanager.*', 'Certificate', 'DnsValidatedCertificate']),
  aws('waf', 'AWS WAF', 'security', 'Web application firewall that filters malicious HTTP requests to CloudFront, API Gateway and load balancers.',
    awsDocs('waf'), ['aws_waf*', 'aws_wafv2_*'], ['wafv2.*', 'waf.*']),
  aws('shield', 'AWS Shield', 'security', 'Protection against distributed denial-of-service (DDoS) attacks.',
    'https://docs.aws.amazon.com/waf/latest/developerguide/shield-chapter.html', ['aws_shield_*'], ['shield.*']),
  aws('guardduty', 'Amazon GuardDuty', 'security', 'Threat detection that continuously monitors accounts and workloads for malicious activity.',
    awsDocs('guardduty'), ['aws_guardduty_*'], ['guardduty.*']),
  aws('security-hub', 'AWS Security Hub', 'security', 'Aggregates security findings and checks your accounts against best practices.',
    awsDocs('securityhub'), ['aws_securityhub_*'], ['securityhub.*']),
  aws('network-firewall', 'AWS Network Firewall', 'security', 'Managed stateful firewall and intrusion prevention for your VPCs.',
    awsDocs('network-firewall'), ['aws_networkfirewall_*'], ['networkfirewall.*']),
  aws('cloudwatch', 'Amazon CloudWatch', 'management', 'Collects metrics and logs, raises alarms and draws dashboards for your resources and applications.',
    awsDocs('cloudwatch'), ['aws_cloudwatch_*'], ['cloudwatch.*', 'cloudwatch_actions.*', 'logs.*', 'logs_destinations.*', 'Alarm', 'Dashboard', 'LogGroup', 'MetricFilter']),
  aws('cloudtrail', 'AWS CloudTrail', 'management', 'Records API calls and account activity for auditing and governance.',
    awsDocs('cloudtrail'), ['aws_cloudtrail*'], ['cloudtrail.*', 'Trail']),
  aws('config', 'AWS Config', 'management', 'Tracks resource configuration over time and evaluates it against rules.',
    awsDocs('config'), ['aws_config_*'], ['config.*']),
  aws('ssm', 'AWS Systems Manager', 'management', 'Operations hub for your resources: Parameter Store, patching, Session Manager and automation.',
    awsDocs('systems-manager'), ['aws_ssm_*'], ['ssm.*', 'StringParameter', 'StringListParameter']),
  aws('cloudformation', 'AWS CloudFormation', 'management', 'Provisions AWS resources from templates as stacks; the CDK synthesises its stacks into CloudFormation.',
    awsDocs('cloudformation'), ['aws_cloudformation_*'], ['cloudformation.*', 'Stack', 'NestedStack']),
  aws('organizations', 'AWS Organizations', 'management', 'Centrally manages and governs multiple AWS accounts with policies.',
    awsDocs('organizations'), ['aws_organizations_*']),
  aws('xray', 'AWS X-Ray', 'management', 'Traces requests through distributed applications to find latency and errors.',
    awsDocs('xray'), ['aws_xray_*'], ['xray.*']),
  aws('ses', 'Amazon SES', 'integration', 'Sends and receives email at scale for transactional and marketing messages.',
    awsDocs('ses'), ['aws_ses_*', 'aws_sesv2_*'], ['ses.*', 'ses_actions.*']),
  aws('iot-core', 'AWS IoT Core', 'integration', 'Connects devices to the cloud with MQTT messaging, device registry and rules.',
    awsDocs('iot'), ['aws_iot_*'], ['iot.*']),
  aws('codebuild', 'AWS CodeBuild', 'devtools', 'Managed build service that compiles code, runs tests and produces artifacts.',
    awsDocs('codebuild'), ['aws_codebuild_*'], ['codebuild.*', 'Project', 'PipelineProject']),
  aws('codepipeline', 'AWS CodePipeline', 'devtools', 'Continuous delivery pipelines that build, test and deploy on every change.',
    awsDocs('codepipeline'), ['aws_codepipeline*'], ['codepipeline.*', 'codepipeline_actions.*', 'pipelines.*', 'Pipeline', 'CodePipeline']),
  aws('codecommit', 'AWS CodeCommit', 'devtools', 'Managed private Git repositories.',
    awsDocs('codecommit'), ['aws_codecommit_*'], ['codecommit.*']),
  aws('codedeploy', 'AWS CodeDeploy', 'devtools', 'Automates deployments to EC2, Lambda, ECS and on-premises servers.',
    awsDocs('codedeploy'), ['aws_codedeploy_*'], ['codedeploy.*']),
  aws('amplify', 'AWS Amplify', 'devtools', 'Builds, deploys and hosts full-stack web and mobile apps.',
    awsDocs('amplify'), ['aws_amplify_*'], ['amplify.*']),
  aws('sagemaker', 'Amazon SageMaker AI', 'ml', 'Builds, trains and deploys machine-learning models on managed infrastructure.',
    awsDocs('sagemaker'), ['aws_sagemaker_*'], ['sagemaker.*']),
  aws('bedrock', 'Amazon Bedrock', 'ml', 'Access to foundation models through one API, with agents, knowledge bases and guardrails.',
    awsDocs('bedrock'), ['aws_bedrock*'], ['bedrock.*']),
  aws('transfer-family', 'AWS Transfer Family', 'storage', 'Managed SFTP, FTPS and FTP servers backed by S3 or EFS.',
    awsDocs('transfer'), ['aws_transfer_*'], ['transfer.*']),
  aws('datasync', 'AWS DataSync', 'storage', 'Moves data between on-premises storage, other clouds and AWS storage services.',
    awsDocs('datasync'), ['aws_datasync_*'], ['datasync.*']),
  aws('cloud-map', 'AWS Cloud Map', 'networking', 'Service discovery: a registry of your application resources and their locations.',
    awsDocs('cloud-map'), ['aws_service_discovery_*'], ['servicediscovery.*']),
  aws('privatelink', 'AWS PrivateLink', 'networking', 'Private connectivity from your VPC to services without traversing the public internet.',
    awsDocs('vpc/latest/privatelink'), ['aws_vpc_endpoint*']),

  // ---- Azure ----
  azure('resource-group', 'Resource Group', 'management', 'A container that holds related Azure resources so they can be deployed, managed and deleted together.',
    'https://learn.microsoft.com/azure/azure-resource-manager/management/manage-resource-groups-portal', ['azurerm_resource_group*']),
  azure('virtual-machine', 'Azure Virtual Machines', 'compute', 'On-demand Windows and Linux virtual servers in Azure.',
    'https://learn.microsoft.com/azure/virtual-machines/', ['azurerm_virtual_machine*', 'azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine', 'azurerm_managed_disk', 'azurerm_availability_set']),
  azure('vm-scale-sets', 'Virtual Machine Scale Sets', 'compute', 'Groups of identical VMs that scale in and out automatically.',
    'https://learn.microsoft.com/azure/virtual-machine-scale-sets/', ['azurerm_linux_virtual_machine_scale_set', 'azurerm_windows_virtual_machine_scale_set', 'azurerm_orchestrated_virtual_machine_scale_set', 'azurerm_virtual_machine_scale_set*']),
  azure('app-service', 'Azure App Service', 'compute', 'Managed hosting for web apps and APIs with built-in scaling, deployment slots and TLS.',
    'https://learn.microsoft.com/azure/app-service/', ['azurerm_app_service*', 'azurerm_linux_web_app*', 'azurerm_windows_web_app*', 'azurerm_service_plan', 'azurerm_web_app_*']),
  azure('functions', 'Azure Functions', 'compute', 'Serverless functions that run your code in response to events and scale automatically.',
    'https://learn.microsoft.com/azure/azure-functions/', ['azurerm_function_app*', 'azurerm_linux_function_app*', 'azurerm_windows_function_app*']),
  azure('static-web-apps', 'Azure Static Web Apps', 'compute', 'Hosts static front ends with optional serverless APIs, built from your repository.',
    'https://learn.microsoft.com/azure/static-web-apps/', ['azurerm_static_web_app*', 'azurerm_static_site*']),
  azure('aks', 'Azure Kubernetes Service', 'containers', 'Managed Kubernetes clusters in Azure.',
    'https://learn.microsoft.com/azure/aks/', ['azurerm_kubernetes_*']),
  azure('container-apps', 'Azure Container Apps', 'containers', 'Serverless containers for microservices and jobs, built on Kubernetes without managing it.',
    'https://learn.microsoft.com/azure/container-apps/', ['azurerm_container_app*']),
  azure('container-instances', 'Azure Container Instances', 'containers', 'Runs individual containers on demand without servers or orchestrators.',
    'https://learn.microsoft.com/azure/container-instances/', ['azurerm_container_group']),
  azure('container-registry', 'Azure Container Registry', 'containers', 'Private registry for container images and OCI artifacts.',
    'https://learn.microsoft.com/azure/container-registry/', ['azurerm_container_registry*']),
  azure('storage-account', 'Azure Storage Account', 'storage', 'Durable cloud storage for blobs, files, queues and tables under one account.',
    'https://learn.microsoft.com/azure/storage/', ['azurerm_storage_*']),
  azure('sql-database', 'Azure SQL Database', 'database', 'Managed SQL Server database engine with automatic backups and high availability.',
    'https://learn.microsoft.com/azure/azure-sql/', ['azurerm_mssql_*', 'azurerm_sql_*']),
  azure('postgresql', 'Azure Database for PostgreSQL', 'database', 'Managed PostgreSQL servers.',
    'https://learn.microsoft.com/azure/postgresql/', ['azurerm_postgresql_*']),
  azure('mysql', 'Azure Database for MySQL', 'database', 'Managed MySQL servers.',
    'https://learn.microsoft.com/azure/mysql/', ['azurerm_mysql_*']),
  azure('cosmos-db', 'Azure Cosmos DB', 'database', 'Globally distributed NoSQL and relational database with multiple APIs and low latency.',
    'https://learn.microsoft.com/azure/cosmos-db/', ['azurerm_cosmosdb_*']),
  azure('redis', 'Azure Cache for Redis', 'database', 'Managed in-memory Redis cache.',
    'https://learn.microsoft.com/azure/azure-cache-for-redis/', ['azurerm_redis_*', 'azurerm_managed_redis*']),
  azure('virtual-network', 'Azure Virtual Network', 'networking', 'Private network for Azure resources, divided into subnets with routing and peering.',
    'https://learn.microsoft.com/azure/virtual-network/', ['azurerm_virtual_network*', 'azurerm_subnet*', 'azurerm_route_table', 'azurerm_route', 'azurerm_network_interface*', 'azurerm_nat_gateway*']),
  azure('network-security-group', 'Network Security Group', 'security', 'Allow and deny rules that filter network traffic to and from Azure resources.',
    'https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview', ['azurerm_network_security_*']),
  azure('public-ip', 'Public IP Address', 'networking', 'A public IP address for internet-facing resources such as load balancers and VMs.',
    'https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses', ['azurerm_public_ip*']),
  azure('load-balancer', 'Azure Load Balancer', 'networking', 'Layer-4 load balancing of TCP and UDP traffic across VMs.',
    'https://learn.microsoft.com/azure/load-balancer/', ['azurerm_lb*']),
  azure('application-gateway', 'Azure Application Gateway', 'networking', 'Layer-7 web traffic load balancer with TLS termination and an optional web application firewall.',
    'https://learn.microsoft.com/azure/application-gateway/', ['azurerm_application_gateway']),
  azure('front-door', 'Azure Front Door', 'networking', 'Global entry point and CDN that accelerates and protects web applications.',
    'https://learn.microsoft.com/azure/frontdoor/', ['azurerm_cdn_frontdoor_*', 'azurerm_frontdoor*', 'azurerm_cdn_*']),
  azure('dns', 'Azure DNS', 'networking', 'Hosts DNS zones and records on Azure infrastructure.',
    'https://learn.microsoft.com/azure/dns/', ['azurerm_dns_*', 'azurerm_private_dns_*']),
  azure('firewall', 'Azure Firewall', 'security', 'Managed, stateful network firewall for virtual networks.',
    'https://learn.microsoft.com/azure/firewall/', ['azurerm_firewall*']),
  azure('key-vault', 'Azure Key Vault', 'security', 'Stores secrets, keys and certificates and controls access to them.',
    'https://learn.microsoft.com/azure/key-vault/', ['azurerm_key_vault*']),
  azure('managed-identity', 'Managed Identities', 'security', 'Identities for Azure resources so they can reach other services without stored credentials.',
    'https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/', ['azurerm_user_assigned_identity', 'azurerm_role_assignment', 'azurerm_role_definition', 'azuread_*']),
  azure('service-bus', 'Azure Service Bus', 'integration', 'Enterprise message broker with queues and publish-subscribe topics.',
    'https://learn.microsoft.com/azure/service-bus-messaging/', ['azurerm_servicebus_*']),
  azure('event-hubs', 'Azure Event Hubs', 'analytics', 'Big-data streaming platform that ingests millions of events per second.',
    'https://learn.microsoft.com/azure/event-hubs/', ['azurerm_eventhub*']),
  azure('event-grid', 'Azure Event Grid', 'integration', 'Routes events from Azure services and your apps to handlers with publish-subscribe.',
    'https://learn.microsoft.com/azure/event-grid/', ['azurerm_eventgrid_*']),
  azure('logic-apps', 'Azure Logic Apps', 'integration', 'Low-code workflows that integrate apps, data and services.',
    'https://learn.microsoft.com/azure/logic-apps/', ['azurerm_logic_app_*']),
  azure('api-management', 'Azure API Management', 'integration', 'Publishes, secures and monitors APIs through a gateway and developer portal.',
    'https://learn.microsoft.com/azure/api-management/', ['azurerm_api_management*']),
  azure('monitor', 'Azure Monitor', 'management', 'Collects and analyses metrics and logs, and raises alerts for Azure resources.',
    'https://learn.microsoft.com/azure/azure-monitor/', ['azurerm_monitor_*']),
  azure('log-analytics', 'Log Analytics Workspace', 'management', 'Stores logs and runs Kusto queries over them for Azure Monitor.',
    'https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-workspace-overview', ['azurerm_log_analytics_*']),
  azure('application-insights', 'Application Insights', 'management', 'Application performance monitoring: requests, dependencies, exceptions and traces.',
    'https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview', ['azurerm_application_insights*']),
  azure('data-factory', 'Azure Data Factory', 'analytics', 'Cloud ETL service that builds data integration pipelines.',
    'https://learn.microsoft.com/azure/data-factory/', ['azurerm_data_factory*']),
  azure('databricks', 'Azure Databricks', 'analytics', 'Apache Spark-based analytics and machine-learning platform.',
    'https://learn.microsoft.com/azure/databricks/', ['azurerm_databricks_*']),
  azure('openai', 'Azure OpenAI', 'ml', 'OpenAI models such as GPT served from Azure with enterprise security.',
    'https://learn.microsoft.com/azure/ai-foundry/openai/', ['azurerm_cognitive_deployment']),
  azure('cognitive-services', 'Azure AI Services', 'ml', 'Pre-built AI APIs for vision, speech, language and decisions.',
    'https://learn.microsoft.com/azure/ai-services/', ['azurerm_cognitive_*']),
  azure('machine-learning', 'Azure Machine Learning', 'ml', 'Builds, trains and deploys machine-learning models.',
    'https://learn.microsoft.com/azure/machine-learning/', ['azurerm_machine_learning_*']),

  // ---- Google Cloud ----
  gcp('compute-engine', 'Compute Engine', 'compute', 'Virtual machines running in Google data centres.',
    'https://cloud.google.com/compute/docs', ['google_compute_instance*', 'google_compute_disk', 'google_compute_image', 'google_compute_instance_group*', 'google_compute_region_instance_group*']),
  gcp('cloud-run', 'Cloud Run', 'compute', 'Runs stateless containers that scale automatically, including to zero.',
    'https://cloud.google.com/run/docs', ['google_cloud_run_*']),
  gcp('cloud-functions', 'Cloud Functions', 'compute', 'Serverless functions triggered by HTTP requests and cloud events.',
    'https://cloud.google.com/functions/docs', ['google_cloudfunctions*']),
  gcp('app-engine', 'App Engine', 'compute', 'Fully managed platform for web applications and APIs.',
    'https://cloud.google.com/appengine/docs', ['google_app_engine_*']),
  gcp('gke', 'Google Kubernetes Engine', 'containers', 'Managed Kubernetes clusters on Google Cloud.',
    'https://cloud.google.com/kubernetes-engine/docs', ['google_container_*']),
  gcp('artifact-registry', 'Artifact Registry', 'containers', 'Stores container images and language packages.',
    'https://cloud.google.com/artifact-registry/docs', ['google_artifact_registry_*']),
  gcp('cloud-storage', 'Cloud Storage', 'storage', 'Object storage for any amount of data, organised in buckets.',
    'https://cloud.google.com/storage/docs', ['google_storage_*']),
  gcp('cloud-sql', 'Cloud SQL', 'database', 'Managed MySQL, PostgreSQL and SQL Server databases.',
    'https://cloud.google.com/sql/docs', ['google_sql_*']),
  gcp('spanner', 'Cloud Spanner', 'database', 'Globally distributed relational database with strong consistency.',
    'https://cloud.google.com/spanner/docs', ['google_spanner_*']),
  gcp('firestore', 'Firestore', 'database', 'Serverless NoSQL document database for web, mobile and server apps.',
    'https://cloud.google.com/firestore/docs', ['google_firestore_*']),
  gcp('bigtable', 'Bigtable', 'database', 'Wide-column NoSQL database for large analytical and operational workloads.',
    'https://cloud.google.com/bigtable/docs', ['google_bigtable_*']),
  gcp('memorystore', 'Memorystore', 'database', 'Managed in-memory Redis and Memcached.',
    'https://cloud.google.com/memorystore/docs', ['google_redis_*', 'google_memcache_*']),
  gcp('bigquery', 'BigQuery', 'analytics', 'Serverless data warehouse for SQL analytics on large datasets.',
    'https://cloud.google.com/bigquery/docs', ['google_bigquery_*']),
  gcp('pubsub', 'Pub/Sub', 'integration', 'Asynchronous messaging that decouples services which produce and consume events.',
    'https://cloud.google.com/pubsub/docs', ['google_pubsub_*']),
  gcp('cloud-tasks', 'Cloud Tasks', 'integration', 'Managed queues that dispatch asynchronous work to HTTP handlers.',
    'https://cloud.google.com/tasks/docs', ['google_cloud_tasks_*']),
  gcp('cloud-scheduler', 'Cloud Scheduler', 'integration', 'Managed cron jobs that call HTTP targets or Pub/Sub on a schedule.',
    'https://cloud.google.com/scheduler/docs', ['google_cloud_scheduler_*']),
  gcp('workflows', 'Workflows', 'integration', 'Orchestrates Google Cloud services and HTTP APIs as serverless workflows.',
    'https://cloud.google.com/workflows/docs', ['google_workflows_*']),
  gcp('vpc', 'Virtual Private Cloud', 'networking', 'Global private network for your Google Cloud resources, with subnets, routes and firewall rules.',
    'https://cloud.google.com/vpc/docs', ['google_compute_network*', 'google_compute_subnetwork*', 'google_compute_route', 'google_compute_firewall*', 'google_compute_address', 'google_compute_global_address', 'google_compute_router_nat']),
  gcp('load-balancing', 'Cloud Load Balancing', 'networking', 'Distributes traffic across backends worldwide behind a single IP.',
    'https://cloud.google.com/load-balancing/docs', ['google_compute_backend_*', 'google_compute_url_map', 'google_compute_target_*', 'google_compute_forwarding_rule', 'google_compute_global_forwarding_rule', 'google_compute_health_check', 'google_compute_region_backend_service']),
  gcp('cloud-dns', 'Cloud DNS', 'networking', 'Managed authoritative DNS.',
    'https://cloud.google.com/dns/docs', ['google_dns_*']),
  gcp('cloud-cdn', 'Cloud CDN', 'networking', 'Caches content at Google edge locations close to users.',
    'https://cloud.google.com/cdn/docs', ['google_compute_backend_bucket*']),
  gcp('iam', 'Identity and Access Management', 'security', 'Controls who can do what on which Google Cloud resources.',
    'https://cloud.google.com/iam/docs', ['google_service_account*', 'google_project_iam_*', 'google_*_iam_member', 'google_*_iam_binding', 'google_*_iam_policy']),
  gcp('secret-manager', 'Secret Manager', 'security', 'Stores API keys, passwords and certificates with versioning and access control.',
    'https://cloud.google.com/secret-manager/docs', ['google_secret_manager_*']),
  gcp('kms', 'Cloud Key Management Service', 'security', 'Creates and manages encryption keys.',
    'https://cloud.google.com/kms/docs', ['google_kms_*']),
  gcp('vertex-ai', 'Vertex AI', 'ml', 'Builds, deploys and serves machine-learning and generative AI models.',
    'https://cloud.google.com/vertex-ai/docs', ['google_vertex_ai_*']),
  gcp('cloud-build', 'Cloud Build', 'devtools', 'Runs builds and CI/CD pipelines on Google Cloud.',
    'https://cloud.google.com/build/docs', ['google_cloudbuild_*']),
  gcp('logging', 'Cloud Logging', 'management', 'Stores, searches and analyses logs from Google Cloud and your apps.',
    'https://cloud.google.com/logging/docs', ['google_logging_*']),
  gcp('monitoring', 'Cloud Monitoring', 'management', 'Metrics, dashboards, uptime checks and alerting.',
    'https://cloud.google.com/monitoring/docs', ['google_monitoring_*']),
  gcp('project', 'Project', 'management', 'The Google Cloud container for resources, APIs, billing and permissions.',
    'https://cloud.google.com/resource-manager/docs/creating-managing-projects', ['google_project', 'google_project_service', 'google_folder', 'google_organization*']),
];

/** Shown for cloud resources that match no catalog entry, by provider. */
export const INFRA_FALLBACKS: Record<InfraProvider, InfraService> = {
  aws: { id: 'aws/generic', provider: 'aws', name: 'AWS resource', category: 'general', docUrl: 'https://docs.aws.amazon.com/',
    description: 'An AWS resource that Stingray does not have a specific icon for yet.' },
  azure: { id: 'azure/generic', provider: 'azure', name: 'Azure resource', category: 'general', docUrl: 'https://learn.microsoft.com/azure/',
    description: 'An Azure resource that Stingray does not have a specific icon for yet.' },
  gcp: { id: 'gcp/generic', provider: 'gcp', name: 'Google Cloud resource', category: 'general', docUrl: 'https://cloud.google.com/docs',
    description: 'A Google Cloud resource that Stingray does not have a specific icon for yet.' },
};
/** CDK constructs that match no catalog entry: usually your own higher-level constructs. */
export const CDK_CONSTRUCT: InfraService = { id: 'aws/cdk', provider: 'aws', name: 'CDK construct', category: 'general',
  docUrl: 'https://docs.aws.amazon.com/cdk/v2/guide/constructs.html',
  description: 'An AWS CDK construct: a reusable building block that defines one or more AWS resources. Custom constructs group resources behind one class.' };

/** Group frame icons drawn in the top-left corner of cloud group boxes, by provider. */
export const INFRA_GROUP_ICONS: Record<InfraProvider, string> = { aws: 'aws/group-cloud', azure: 'azure/resource-group', gcp: 'gcp/generic' };

const service = ({ terraform: _t, cdk: _c, ...s }: CatalogEntry): InfraService => s;
const TF_PROVIDERS: [string, InfraProvider][] = [['aws_', 'aws'], ['azurerm_', 'azure'], ['azuread_', 'azure'], ['google_', 'gcp']];

/** The service of a Terraform resource or data source type (e.g. "aws_s3_bucket_policy"): exact match, else the longest
 * prefix pattern, else the provider's generic service; null for non-cloud providers (random_, null_, kubernetes_, ...). */
export function terraformService(type: string): InfraService | null {
  let best: { entry: CatalogEntry; length: number } | null = null;
  for (const e of INFRA_CATALOG) for (const p of e.terraform) {
    const length = p.endsWith('*') ? (type.startsWith(p.slice(0, -1)) ? p.length - 1 : -1)
      : p.includes('*') ? (wildcard(p).test(type) ? p.length - 1 : -1) : p === type ? Infinity : -1;
    if (length >= 0 && (!best || length > best.length)) best = { entry: e, length };
  }
  if (best) return service(best.entry);
  const provider = TF_PROVIDERS.find(([prefix]) => type.startsWith(prefix))?.[1];
  return provider ? INFRA_FALLBACKS[provider] : null;
}
const wildcard = (pattern: string) => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9_]*')}$`);

// Common import aliases of aws-cdk-lib modules (`import * as apigw from 'aws-cdk-lib/aws-apigateway'`).
const CDK_MODULE_ALIASES: Record<string, string> = {
  apigw: 'apigateway', agw: 'apigateway', apigwv2: 'apigatewayv2', ddb: 'dynamodb', sfn: 'stepfunctions', tasks: 'stepfunctions_tasks',
  elbv2: 'elasticloadbalancingv2', elb: 'elasticloadbalancing', cw: 'cloudwatch', acm: 'certificatemanager', sm: 'secretsmanager',
  firehose: 'kinesisfirehose', opensearch: 'opensearchservice', sns_subs: 'sns_subscriptions', subs: 'sns_subscriptions',
  origins: 'cloudfront_origins', targets: 'events_targets', nodejs: 'lambda_nodejs',
};
const normalizeModule = (m: string) => {
  const name = m.toLowerCase().replace(/-/g, '_').replace(/^aws_/, '').replace(/_alpha$/, '');
  return CDK_MODULE_ALIASES[name] ?? name;
};
const cdkIndex = (() => {
  const exact = new Map<string, CatalogEntry>();
  for (const e of INFRA_CATALOG) for (const p of e.cdk) {
    const dot = p.lastIndexOf('.'), key = dot < 0 ? p : `${normalizeModule(p.slice(0, dot))}.${p.slice(dot + 1)}`;
    if (!exact.has(key)) exact.set(key, e);
  }
  return exact;
})();

/** The service of a CDK construct class as written at `new X(...)`: "s3.Bucket", "cdk.aws_s3.Bucket", "Bucket", "CfnBucket".
 * Lookup: module.Class, module.*, then the bare class; L1 "Cfn" classes fall back to their L2 name. Null when unknown. */
export function cdkService(constructor: string): InfraService | null {
  const parts = constructor.replace(/<.*$/, '').trim().split('.');
  const cls = parts[parts.length - 1], module = parts.length > 1 ? normalizeModule(parts[parts.length - 2]) : null;
  for (const name of cls.startsWith('Cfn') && cls.length > 3 ? [cls, cls.slice(3)] : [cls]) {
    const e = (module && (cdkIndex.get(`${module}.${name}`) ?? cdkIndex.get(`${module}.*`))) || cdkIndex.get(name);
    if (e) return service(e);
  }
  return null;
}

/** Every icon id the renderer may draw: catalog services, fallbacks and group icons. */
export const INFRA_ICON_IDS = [...new Set([...INFRA_CATALOG.map(e => e.id), ...Object.values(INFRA_FALLBACKS).map(s => s.id), CDK_CONSTRUCT.id,
  ...Object.values(INFRA_GROUP_ICONS)])];

/** Catalog lookup by id (fallbacks included), e.g. to open its docs from the main process. */
export const infraServiceById = (id: string): InfraService | null =>
  [...INFRA_CATALOG.map(service), ...Object.values(INFRA_FALLBACKS), CDK_CONSTRUCT].find(s => s.id === id) ?? null;
