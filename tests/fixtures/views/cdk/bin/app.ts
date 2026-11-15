#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();
const data = new DataStack(app, 'TravelData', { env: { region: 'eu-central-1' } });
const api = new ApiStack(app, 'TravelApi', { table: data.table, uploads: data.uploads });
api.addDependency(data);
