#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BlogContentRepositoryStack } from '../lib/blog-content-repo-stack';
import { DemoDataStack } from '../lib/userpool-demo-data-stack';

const app = new cdk.App();

new BlogContentRepositoryStack(app, 'BlogContentRepositoryStack', {
  stackName: 'content-repo-stack',
  description: 'Creates all resources needed for the basic content repository',
});

new DemoDataStack(app, 'DemoDataStack', {
  stackName: 'demo-data-stack',
  description: 'Creates exemplary Cognito user pool users and groups and maps it to IAM roles with permission policies',
});