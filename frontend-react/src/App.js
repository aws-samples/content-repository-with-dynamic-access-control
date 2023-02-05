// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from 'react';
import './App.css';
import '@aws-amplify/ui-react/styles.css';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import Homepage from './components/homepage';

// import and set the Amplify Auth backend configuration
let cdkExport = require('./amplify_auth_config.json');
const CDKConfig = {
  aws_project_region: cdkExport.BlogContentRepositoryStack.region,
  aws_cognito_identity_pool_id: cdkExport.BlogContentRepositoryStack.identityPoolId,
  aws_cognito_region: cdkExport.BlogContentRepositoryStack.region,
  aws_user_pools_id: cdkExport.BlogContentRepositoryStack.userPoolId,
  aws_user_pools_web_client_id: cdkExport.BlogContentRepositoryStack.userPoolClientId
};
Amplify.configure(CDKConfig);

const App = () => {

  return (
    <div className="app">
      <Authenticator hideSignUp="true">
        {({ signOut, user }) => (
          <div className="container">
            <div id='homepage' ><Homepage signOut={signOut} user={user} /></div>
          </div>
        )}
      </Authenticator>
    </div>
  );
};

export default App;