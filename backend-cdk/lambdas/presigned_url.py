# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
import os
import json
from botocore.exceptions import ClientError
from botocore.config import Config

# general env variables
bucket_name = os.environ['sourceBucketName']
allow_origins = os.environ['allowOrigins']
region = os.environ['region']
s3_region_endpoint = f'https://s3.{region}.amazonaws.com'

# Cognito env variables
id_pool_id = os.environ['idPoolId']
user_pool_id = os.environ['userPoolId']
id_login_provider = f'cognito-idp.{region}.amazonaws.com/{user_pool_id}'

# create Cognito client
id_client = boto3.client('cognito-identity')

def lambda_handler(event, context):

    body = json.loads(event['body'])
    fileName = body['fileName']
    fileType = body['fileType']

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

    # create the s3 client
    s3_client = boto3.client(
        's3',
        endpoint_url=s3_region_endpoint,
        aws_access_key_id=temp_aws_credentials['AccessKeyId'],
        aws_secret_access_key=temp_aws_credentials['SecretKey'],
        aws_session_token=temp_aws_credentials['SessionToken'],
        region_name=region,
        config=Config(signature_version='s3v4'))

    # create presigned s3 url to upload the object and tag it for downstream access control
    try:
        params = {'Bucket': bucket_name, 'Key': preferred_group_name+'/'+fileName,
                  'ContentType': fileType, 'Tagging': 'Group={0}'.format(preferred_group_name)}
        presignedurl = s3_client.generate_presigned_url(
            'put_object',
            params
        )
    except ClientError as error:
        print(error)
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': allow_origins,
                'Access-Control-Allow-Credentials': True
            }
        }

    # return the presigned url and the preferred group name for tagging the object
    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': allow_origins,
            'Access-Control-Allow-Credentials': True
        },
        'body': json.dumps({'preSignedUrl': presignedurl, 'group': preferred_group_name})
    }
