# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
import json
import os
from botocore.config import Config

# general env variables
bucket_name = os.environ['sourceBucketName']
allow_origins = os.environ['allowOrigins']
region = os.environ['region']

# Cognito env variables
id_pool_id = os.environ['idPoolId']
user_pool_id = os.environ['userPoolId']
id_login_provider = f'cognito-idp.{region}.amazonaws.com/{user_pool_id}'

# create Cognito client
id_client = boto3.client('cognito-identity')

def lambda_handler(event, context):

    # get the preferred cognito group name and arn
    id_token_claims = event['requestContext']['authorizer']['claims']
    preferred_group_name = id_token_claims['department']
    preferred_role_arn = id_token_claims['cognito:preferred_role']

    # get the id token from the request header
    id_token = event['headers']['Authorization']

    # get Cognito id from the Identity Pool
    identity_response = id_client.get_id(
        IdentityPoolId=id_pool_id,
        Logins={id_login_provider: id_token}) 

    # get temporary AWS credentials from the Identity Pool based on Cognito id
    identity_cred = id_client.get_credentials_for_identity(
        CustomRoleArn=preferred_role_arn,
        IdentityId=identity_response['IdentityId'],
        Logins={id_login_provider: id_token})

    temp_aws_credentials = identity_cred["Credentials"]

    #  create the s3 client
    s3_client = boto3.client(
        's3',
        aws_access_key_id=temp_aws_credentials["AccessKeyId"],
        aws_secret_access_key=temp_aws_credentials["SecretKey"],
        aws_session_token=temp_aws_credentials["SessionToken"],
        region_name=region,
        config=Config(signature_version='s3v4'))

    #  return the list of keys in the S3 bucket that matches the preferred group name prefix
    keys = []
    s3_objects = s3_client.list_objects(
        Bucket=bucket_name, Prefix=preferred_group_name)
    # check for empty bucket/prefix
    if 'Contents' in s3_objects:
        for key in s3_objects['Contents']:
            keys.append(key['Key'])

    response = {
        "statusCode": 200,
        "headers": {
            'Access-Control-Allow-Origin': allow_origins,
            'Access-Control-Allow-Credentials': 'true',
        },
        "body": json.dumps({"objectLists": keys})
    }

    return response
