// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as triggers from "aws-cdk-lib/triggers";
import generator from 'generate-password-ts';

export class DemoDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // imported data from "BlogContentRepositoryStack" infrastructure stack
    const imported_user_pool_id = cdk.Fn.importValue('cognito-user-pool-id');
    const imported_user_pool_arn = cdk.Fn.importValue('cognito-user-pool-arn');
    const imported_identity_pool_ref = cdk.Fn.importValue('cognito-identity-pool-ref');
    const imported_s3_source_bucket_arn = cdk.Fn.importValue('s3-source-bucket-arn');

    // helper method to generate passords
    const generatePassword = () => generator.generate({
      length: 10,
      symbols: true,
      lowercase: true,
      uppercase: true,
      numbers: true,
      exclude: '/"^\\{}|()',
      strict: true
    });

    /** create demo data **/
    // create IAM roles to map to corresponding Cognito user pool groups
    const sales_group_iam_role = new iam.Role(this, "sales-group-iam-role", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com", {  
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": imported_identity_pool_ref
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated"
          },
        },
        "sts:AssumeRoleWithWebIdentity",
        ).withSessionTags(),
    });
    
    const marketing_group_iam_role = new iam.Role(this, "marketing-group-iam-role", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com", {  
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": imported_identity_pool_ref
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated"
          },
        },
        "sts:AssumeRoleWithWebIdentity",
        ).withSessionTags(),
    });

    // create Cognito user pool groups and assign the corresponding IAM role 
    const cfn_user_pool_group_sales = new cognito.CfnUserPoolGroup(this, "user-pool-group-sales", {
      userPoolId: imported_user_pool_id,
      description: "Sales group",
      groupName: "sales",
      precedence: 1,
      roleArn: sales_group_iam_role.roleArn,
    });
    const cfn_user_pool_group_marketing = new cognito.CfnUserPoolGroup(this, "user-pool-group-marketing", {
      userPoolId: imported_user_pool_id,
      description: "Marketing group",
      groupName: "marketing",
      precedence: 2,
      roleArn: marketing_group_iam_role.roleArn,
    });

    // create policy statements to manage the S3 content repository bucket permissions dynamically
    const s3_put_object_policy = new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:PutObjectTagging"],
      resources: [imported_s3_source_bucket_arn+"/"+"${aws:PrincipalTag/department}/*"],
    });

    const s3_allow_list_bucket_policy = new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      effect: iam.Effect.ALLOW,
      resources: [imported_s3_source_bucket_arn],
      conditions: {
        "StringEquals": {
          "s3:prefix": "${aws:PrincipalTag/department}",
        },
      },
    });
    
    const s3_deny_list_bucket_policy = new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      effect: iam.Effect.DENY,
      resources: [imported_s3_source_bucket_arn],
      conditions: {
        "StringNotEquals": {
          "s3:prefix": "${aws:PrincipalTag/department}",
        },
      },
    });
    
    const s3_access_control_policy = new iam.ManagedPolicy(this, 's3-access-control-policy', {
      description: 'manage s3 content repository permissions dynamically based on principal tags',
      statements: [
          s3_put_object_policy, s3_allow_list_bucket_policy, s3_deny_list_bucket_policy,
      ],
    });

    sales_group_iam_role.addManagedPolicy(s3_access_control_policy);
    marketing_group_iam_role.addManagedPolicy(s3_access_control_policy);
    
    // create Cognito user pool users
    const sales_user: Object = {
      username: 'sales-user',
      group: cfn_user_pool_group_sales.groupName,
      password: generatePassword(),
    };

    const marketing_user: Object = {
      username: 'marketing-user',
      group: cfn_user_pool_group_marketing.groupName,
      password: generatePassword(),
    };

    const user_data = JSON.stringify([sales_user,marketing_user]);

    // trigger creation of Cognito User Pool (CUP) users and add them to the respective group
    new triggers.TriggerFunction(cdk.Stack.of(this), "cdk-trigger-demo-data", {
      environment: {
        userPoolId: imported_user_pool_id,
        userData: user_data,
      },
      code: lambda.Code.fromAsset("lambdas/cdk"),
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: "trigger_demo_data_ingestion.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      executeOnHandlerChange: false,
      initialPolicy: [
        new iam.PolicyStatement({
          actions: ["cognito-idp:AdminCreateUser","cognito-idp:AdminAddUserToGroup"],
          resources: [`${imported_user_pool_arn}`],
        }),
      ],
    });

    new cdk.CfnOutput(this, "user1", {
      value: JSON.stringify([sales_user]),
    });

    new cdk.CfnOutput(this, "user2", {
      value: JSON.stringify([marketing_user]),
    });

  }
}
