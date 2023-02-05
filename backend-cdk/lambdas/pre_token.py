# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3

idp_client = boto3.client('cognito-idp')

# this function handles adding and modyfying claims for the Cognito ID token

def lambda_handler(event, context):
    """ evaluate the name from the Cognito user pool preferred group to use it downstream for 
    exemplary dynamic resource access control in IAM permission policies as principal tag but also to tag S3 objects """
    preferred_role_arn = event['request']['groupConfiguration']['preferredRole']

    all_groups = idp_client.list_groups(
        UserPoolId=event['userPoolId']
    )

    # find the Cognito group name based on the preferred role arn
    for user_group in all_groups['Groups']:
        if (user_group['RoleArn'] == preferred_role_arn):
            preferred_group_name = user_group['GroupName']
            break

    """ add or overwrite claims for the ID token. custom attributes from the
    user pool can also be used as another dimension (scope) for access control """

    event["response"]["claimsOverrideDetails"] = {
        "claimsToAddOrOverride": {
            "department": preferred_group_name
            # "custom:clearance": "c2" # manipulate user pool attributes
        }
    }

    return event
