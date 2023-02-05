// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import '../App.css';
import { useState } from 'react';
import axios from 'axios';

let apiEndpointConfig = require('./api_endpoint.json');

const Homepage = ({ user, signOut }) => {

  const [selectedFile, setSelectedFile] = useState(null)
  const [fileUploadedSuccessfully, setFileUploadedSuccessfully] = useState(false)
  const [bucketFiles, setBucketFiles] = useState(null)

  const presingedEndpointURL = new URL(apiEndpointConfig.presignedResource.substring(1), apiEndpointConfig.apiEndpoint).toString();
  const listDocsEndpointURL = new URL(apiEndpointConfig.listDocsResource.substring(1), apiEndpointConfig.apiEndpoint).toString();

  const onFileChange = event => {
    setSelectedFile(event.target.files[0]);
  }

  const onFileUpload = () => {

    const file = selectedFile;
    const fileName = selectedFile.name;
    let fileType = selectedFile.type;

    // set default MIME type if undefined
    if (!fileType) {
      fileType = "application/octet-stream";
    }

    let Token = user.signInUserSession.idToken.jwtToken;
    const config = {
      headers: { Authorization: Token }
    };

    const bodyParameters = {
      fileName: fileName,
      fileType: fileType
    };

    //call the API GW to generate the s3 presigned url to upload the file
    axios.post(presingedEndpointURL, bodyParameters, config).then((r) => {
      //upload the file to s3 with the returned presigned url and tag the object
      axios.put(r.data.preSignedUrl, file, { headers: { 'Content-Type': fileType, 'x-amz-tagging': `Group=${r.data.group}` } })
        .then(setSelectedFile(null))
        .then(setFileUploadedSuccessfully(true))
        .catch((err) => console.error(err));
    })
      .catch((err) => {
        console.error(err);
      })
  }

  const onFilesList = () => {

    let Token = user.signInUserSession.idToken.jwtToken;

    const config = { headers: { Authorization: Token } };

    axios.get(listDocsEndpointURL, config).then((r) => {
      setBucketFiles(JSON.parse(r.request.response).objectLists);
    })
      .catch((err) => {
        console.error(err);
      })
  }

  const fileData = () => {
    if (selectedFile) {
      return (
        <div>
          <h2>File Details </h2>
          <p> File Name: {selectedFile.name} </p>
          <p> File Type: {selectedFile.type} </p>
        </div>);
    }
    else if (fileUploadedSuccessfully) {
      return (
        <div>
          <br />
          <h4> file uploaded successfully </h4>
        </div>);
    }
  }

  const bucketData = () => {
    if (bucketFiles) {
      return (
        <div>
          <h3>Bucket Content </h3>
          <th>File Name</th>
          <tbody>
            {bucketFiles.map((file, index) => (
              <tr key={index}>{file}</tr>
            ))}
          </tbody>
        </div>
      )
    }
  }

  return (
    <div>
      <button id='logout' onClick={signOut}>
        Log Out
      </button>
      <h2>Content Repository - Demo UI</h2>
      <h3>upload and list documents</h3>
      <div>
        <input type="file" onChange={onFileChange} />
        <button className='button' onClick={onFileUpload}>
          UPLOAD
        </button>
      </div>

      {fileData()}
      <button className='button' id='list' onClick={onFilesList}>
        LIST
      </button>
      {bucketData()}
    </div>
  );
}

export default Homepage;
