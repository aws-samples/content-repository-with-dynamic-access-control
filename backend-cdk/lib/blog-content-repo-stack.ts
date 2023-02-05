// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as amplify_alpha from "@aws-cdk/aws-amplify-alpha";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as customResources from 'aws-cdk-lib/custom-resources';


export class BlogContentRepositoryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const path = require("path");

    // create pre token generation Lambda to add and modify custom claims for the id token
    const pre_token_lambda = new lambda.Function(this, "pre-token-lambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "pre_token.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_9,
    });

    // create the Cognito user pool
    const cognito_user_pool = new cognito.UserPool(this, "cognito-user-pool", {
      userPoolName: "content-repository-up",
      selfSignUpEnabled: false,
      signInAliases: {
        username: true,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      signInCaseSensitive: false,
      lambdaTriggers: {
        preTokenGeneration: pre_token_lambda
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const clientReadAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({emailVerified: true});

    // create the Cognito user pool client
    const cognito_user_pool_client = new cognito.UserPoolClient(
      this,
      "cognito-user-pool-client",
      {
        userPool: cognito_user_pool,
        authFlows: {
          adminUserPassword: true,
          custom: true,
          userSrp: true,
        },
        supportedIdentityProviders: [
          cognito.UserPoolClientIdentityProvider.COGNITO,
        ],
        readAttributes: clientReadAttributes,
      }
    );
    cognito_user_pool_client.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // create Cognito identity pool
    const cognito_identity_pool = new cognito.CfnIdentityPool(
      this,
      "cognito-identity-pool",
      {
        identityPoolName: "content-repository-ip",
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            clientId: cognito_user_pool_client.userPoolClientId,
            providerName: cognito_user_pool.userPoolProviderName,
          },
        ],
      }
    );
    cognito_identity_pool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // create Principal Tag mappings in the identity pool after it has been created
    // requires a custom resource (https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources-readme.html)
    // uses the SDK, rather than CDK code, as attaching Principal Tags through CDK is currently not supported yet
    const principalTagParameters = {
      "IdentityPoolId": cognito_identity_pool.ref,
      "IdentityProviderName": cognito_user_pool.userPoolProviderName,
      "PrincipalTags": {
        "department": "department",
        //"clearance": "clearance",
      },
      "UseDefaults": false
    }
    const setPrincipalTagAction = {
      action: "setPrincipalTagAttributeMap",
      service: "CognitoIdentity",
      parameters: principalTagParameters,
      physicalResourceId: customResources.PhysicalResourceId.of(cognito_identity_pool.ref)
    }
    new customResources.AwsCustomResource(this, 'custom-resource-principal-tags', {
      onCreate: setPrincipalTagAction,
      onUpdate: setPrincipalTagAction,
      policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:cognito-identity:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:identitypool/${cognito_identity_pool.ref}`],
      }),
    })

    // create required default role for unauthenticated users (validated by CDK)
    const cognito_unauthenticated_role = new iam.Role(
      this,
      "cognito-unauthenticated-role",
      {
        description: "Default role for anonymous users",
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": cognito_identity_pool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "unauthenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    // create required default role for authenticated users (validated by CDK)
    const cognito_authenticated_role = new iam.Role(this, "cognito-authenticated-role", {
      description: "Default role for authenticated users",
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": cognito_identity_pool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    // choose role for authenticated users from ID token (cognito:preferred_role)
    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "identity-pool-role-attachment",
      {
        identityPoolId: cognito_identity_pool.ref,
        roles: {
          authenticated: cognito_authenticated_role.roleArn,
          unauthenticated: cognito_unauthenticated_role.roleArn,
        },
        roleMappings: {
          mapping: {
            type: "Token",
            ambiguousRoleResolution: "Deny",
            identityProvider: `cognito-idp.${
              cdk.Stack.of(this).region
            }.amazonaws.com/${cognito_user_pool.userPoolId}:${
              cognito_user_pool_client.userPoolClientId
            }`,
          },
        },
      }
    );

    // create s3 bucket to upload, manage and analyze documents to the repository
    const s3_source_bucket = new s3.Bucket(this, "s3-source-bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      serverAccessLogsPrefix: "access_logs",
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.POST,
            s3.HttpMethods.PUT,
          ],
          // updated as part of the build and deploy pipeline of the Amplify hosted front-end application
          allowedOrigins: ["*"], 
          allowedHeaders: ["*"],
        },
      ],
    });

    // create source control repository for the react frontend app hosted on Amplify
    const code_commit_repository = new codecommit.Repository(this, "code-commit-repository", {
      repositoryName: "frontend-react-appliction",
      code: codecommit.Code.fromDirectory(
        path.join(__dirname, "/../../frontend-react/"),
        "main"
      ),
      description: "code repository for react frontend application",
    });
    code_commit_repository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Creation of SSM String parameter for Amplify authentication backend configuration
    const ampfliy_auth_ssm_param = new ssm.StringParameter(
      this,
      "ampfliy-auth-ssm-param",
      {
        allowedPattern: ".*",
        description: "Amplify auth backend configuration",
        parameterName: "ampfliyBackendAuthParam",
        stringValue: `{"BlogContentRepositoryStack":{"bucketName": "${
          s3_source_bucket.bucketName
        }","userPoolClientId": "${
          cognito_user_pool_client.userPoolClientId
        }","region": "${cdk.Stack.of(this).region}","userPoolId": "${
          cognito_user_pool.userPoolId
        }","identityPoolId": "${cognito_identity_pool.ref}"}}`,
        tier: ssm.ParameterTier.STANDARD,
      }
    );

    // create custom execution role for Amplify front-end application
    const amplify_exec_role = new iam.Role(this, "amplify-exec-role", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Custom execution role to host and build Amplify front-end application",
    });

    // Create Amplify front end application (react)
    const amplify_frontend_app = new amplify_alpha.App(this, "amplify-frontend-app", {
      sourceCodeProvider: new amplify_alpha.CodeCommitSourceCodeProvider({
        repository: code_commit_repository,
      }),
      role: amplify_exec_role,
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        // Prebuild step gets required Cognito user pool information to configure the Amplify Auth backend and writes it into a file which the react app loads dynamically at start
        // Postbuild step updates the CORS rule of the S3 bucket to allow communication with the Amplify hosted app only
        version: "1.0",
        frontend: {
          phases: {
            preBuild: {
              commands: [
                "npm install",
                "aws ssm get-parameter --name 'ampfliyBackendAuthParam' --query 'Parameter.Value' --output text > ./src/amplify_auth_config.json",
                "aws ssm get-parameter --name 'apiGatewayEndpointParam' --query 'Parameter.Value' --output text > ./src/components/api_endpoint.json",
              ],
            },
            build: {
              commands: ["npm run build"],
            },
            postBuild: {
              commands: [
                "CORS_RULE=$( aws ssm get-parameter --name 's3CorsRuleParam' --query 'Parameter.Value' --output text )",
                "BUCKET_NAME=$( aws ssm get-parameter --name 's3BucketNameParam' --query 'Parameter.Value' --output text )", 
                'aws s3api put-bucket-cors --bucket "$BUCKET_NAME" --cors-configuration "$CORS_RULE"',
              ],
            },
          },
          artifacts: {
            baseDirectory: "build",
            files: ["**/*"],
          },
          cache: {
            commands: ["node_modules/**/*"],
          },
        },
      }),
    });
    amplify_frontend_app.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // connect Amplify app with the main branch of the code repolistory with the frontend code
    const main_branch = amplify_frontend_app.addBranch("main-branch", {
      autoBuild: true,
      branchName: "main",
    });
    // Amplify hosted app URL used for CORS origin configuration
    const allow_origin_url =
      "https://" + main_branch.branchName + "." + amplify_frontend_app.defaultDomain;

    // create Lambda function to list content of the s3 bucket
    const list_file_lambda = new lambda.Function(this, "list-file-lambda", {
      environment: {
        sourceBucketName: s3_source_bucket.bucketName,
        allowOrigins: allow_origin_url,
        region: cdk.Stack.of(this).region,
        idPoolId: cognito_identity_pool.ref,
        userPoolId: cognito_user_pool.userPoolId,
      },
      code: lambda.Code.fromAsset("lambdas"),
      handler: "list_file.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_9,
    });

    // create Lambda function to create a presigned S3 url to upload a document from the frontend app to the content repository
    const presigned_url_lambda = new lambda.Function(this, "presigned-url-lambda", {
      environment: {
        sourceBucketName: s3_source_bucket.bucketName,
        allowOrigins: allow_origin_url,
        region: cdk.Stack.of(this).region,
        idPoolId: cognito_identity_pool.ref,
        userPoolId: cognito_user_pool.userPoolId,
      },
      code: lambda.Code.fromAsset("lambdas"),
      handler: "presigned_url.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_9,
    });

    // permission policy for the pre-token generation trigger to list the assigned groups from CUP users
    pre_token_lambda.role?.attachInlinePolicy(
      new iam.Policy(this, "pre-token-lambda-policy", {
        statements: [new iam.PolicyStatement({
          actions: ["cognito-idp:ListGroups"],
          resources: [cognito_user_pool.userPoolArn],
        })],
      })
    );

    // create REST API Gateway with a Cognito User Pool Authorizer
    const rest_api_gateway = new apigateway.RestApi(this, "rest-apigateway", {
      defaultCorsPreflightOptions: {
        allowOrigins: [allow_origin_url],
        allowMethods: ["OPTIONS,GET,POST"],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
      },
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(new logs.LogGroup(this, "apigw-prd-logs")),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields()
      },
      endpointConfiguration: {
        types: [ apigateway.EndpointType.EDGE ]
      },
    });
    rest_api_gateway.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const list_documents = rest_api_gateway.root.addResource("list-documents");
    const create_presigned_url = rest_api_gateway.root.addResource("create-presigned-url");

    const apigw_user_pool_authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "apigw-user-pool-authorizer",
      {
        cognitoUserPools: [cognito_user_pool],
      }
    );
    
    list_documents.addMethod(
      "GET",
      new apigateway.LambdaIntegration(list_file_lambda),
      {
        authorizer: apigw_user_pool_authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

    create_presigned_url.addMethod(
      "POST",
      new apigateway.LambdaIntegration(presigned_url_lambda),
      {
        authorizer: apigw_user_pool_authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

    // add API Gateway endpoint to SSM parameter store to use it from the react frontend app during the build process
    // update execution role of the Amplify app accordingly
    const apigw_endpoint_ssm_param = new ssm.StringParameter(this, "apigw-endpoint-ssm-param", {
      allowedPattern: ".*",
      description: "Endpoint for API Gateway",
      parameterName: "apiGatewayEndpointParam",
      stringValue: `{"apiEndpoint": "${rest_api_gateway.url}","presignedResource": "${create_presigned_url.path}","listDocsResource": "${list_documents.path}"}`,
      tier: ssm.ParameterTier.STANDARD,
    });
    
    // add S3 cors rule and s3 bucket name to SSM parameter store to use it from the react frontend app during the build process
    // update execution role of the Amplify app accordingly
    const s3_cors_rule_param = new ssm.StringParameter(this, "s3-cors-rule-param", {
      allowedPattern: ".*",
      description: "S3 bucket CORS rule",
      parameterName: "s3CorsRuleParam",
      stringValue: `{"CORSRules" : [{"AllowedHeaders":["*"],"AllowedMethods":["GET","POST", "PUT"],"AllowedOrigins":["${allow_origin_url}"]}]}`,
      tier: ssm.ParameterTier.STANDARD,
    });
    const s3_source_bucket_name_param = new ssm.StringParameter(this, "s3-source-bucket-name-param", {
      allowedPattern: ".*",
      description: "S3 bucket name",
      parameterName: "s3BucketNameParam",
      stringValue: s3_source_bucket.bucketName,
      tier: ssm.ParameterTier.STANDARD,
    });

    // permission policy for Amplify execution role to host and build the frontend app
    const amplify_exec_policy = new iam.ManagedPolicy(this, 'amplify-exec-policy', {
      description: 'Read SSM parameter store to build the backend and update S3 CORS policy',
      statements: [
        new iam.PolicyStatement({
          resources: [
            apigw_endpoint_ssm_param.parameterArn,
            ampfliy_auth_ssm_param.parameterArn,
            s3_cors_rule_param.parameterArn,
            s3_source_bucket_name_param.parameterArn],
          actions: [
            "ssm:GetParameter",
          ],
        }),
        new iam.PolicyStatement({
          resources: [s3_source_bucket.bucketArn],
          actions: ["s3:PutBucketCORS"],
        }),
      ],
      roles: [amplify_exec_role],
    });

    // trigger initial deployment of Amplify hosted react application - requires a custom resource 
    const amplifyJobParameters = {
      "appId": amplify_frontend_app.appId,
      "branchName": main_branch.branchName,
      "jobType": "RELEASE",
      "jobReason": "initial deployment triggered by CDK"
    }
    const amplifyStartJobAction = {
      action: "startJob",
      service: "Amplify",
      parameters: amplifyJobParameters,
      physicalResourceId: customResources.PhysicalResourceId.of(amplify_frontend_app.appId)
    }
    new customResources.AwsCustomResource(this, 'custom-resource-amplify-start-job', {
      onCreate: amplifyStartJobAction,
        policy: customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            resources: [main_branch.arn + "/jobs/*"],
            actions: ["amplify:StartJob"],
        }),
      ])
    });

    // relevant stack outputs
    new cdk.CfnOutput(this, "amplifyHostedAppUrl", {
      value: allow_origin_url,
    });
    new cdk.CfnOutput(this, "awsRegion", {
      value: cdk.Stack.of(this).region,
    });

    // exports to create demo data via separate cdk stack
    new cdk.CfnOutput(this, "cognitoUserPoolId", {
      value: cognito_user_pool.userPoolId,
      exportName: 'cognito-user-pool-id',
    });
    new cdk.CfnOutput(this, "cognitoUserPoolArn", {
      value: cognito_user_pool.userPoolArn,
      exportName: 'cognito-user-pool-arn',
    });
    new cdk.CfnOutput(this, "cognitoIdentityPoolRef", {
      value: cognito_identity_pool.ref,
      exportName: 'cognito-identity-pool-ref',
    });
    new cdk.CfnOutput(this, "s3SourceBucketArn", {
      value: s3_source_bucket.bucketArn,
      exportName: 's3-source-bucket-arn',
    });
    new cdk.CfnOutput(this, "s3SourceBucketName", {
      value: s3_source_bucket.bucketName,
      exportName: 's3-souce-bucket-name',
    });
    
  }
}
