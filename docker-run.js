'use strict';

import { LambdaClient, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DynamoDBClient, DynamoDBDocumentClient, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import https from 'https';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

process.env.AWS_DEFAULT_REGION = process.env.AWS_REGION = process.env.AWS_REGION || "us-west-2";

handler();

async function handler() {
  const event = await buildEvent();
  process.env.AWS_LAMBDA_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || event.__cron.name;
  const FunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;

  const lambda = new LambdaClient({
    region: process.env.AWS_REGION
  });

  const sts = new STSClient({
    region: process.env.AWS_REGION
  });

  try {
    const functionData = await lambda.send(new GetFunctionCommand({ FunctionName }));

    functionData.Configuration.Timeout *= 10;

    const role = functionData.Configuration.Role;
    const assumeRoleCommand = new AssumeRoleCommand({
      RoleArn: role,
      RoleSessionName: "assumeRoleSession"
    });

    const roleCredentials = await sts.send(assumeRoleCommand);
    const { AccessKeyId, SecretAccessKey, SessionToken } = roleCredentials.Credentials;

    const awsCredentials = {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken,
      region: process.env.AWS_REGION
    };

    // Set all Environment for the lambda. Should this be done on container invoke?
    Object.keys(functionData.Configuration.Environment.Variables).forEach(key => {
      process.env[key] = functionData.Configuration.Environment.Variables[key];
    });

    importModule(FunctionName, functionData.Code.Location, {
      main: `${functionData.Configuration.Handler.split(".")[0]}.js`,
      handler: functionData.Configuration.Handler.split(".")[1],
      lastModified: functionData.Configuration.LastModified,
      Configuration: functionData.Configuration
    }, (err, data) => {
      if (err) {
        console.log(err);
        process.exit();
      }
      const context = createContext(data.Configuration || {});
      const handler = data.module[data.handler || "handler"];
      handler(event, context, (err, data) => {
        console.log("All Done", err, data);
        process.exit();
      });
    });
  } catch (err) {
    console.log(`Cannot find function: ${FunctionName}`, err);
    process.exit();
  }
}

async function importModule(FunctionName, url, data, callback) {
  data = Object.assign({
    main: "index.js",
    handler: "handler"
  }, data);
  const zipPath = path.resolve("", `/tmp/run_${FunctionName}.zip`);
  const indexPath = path.resolve("", `/tmp/run_${FunctionName}/${data.main}`);
  const folder = path.resolve("", `/tmp/run_${FunctionName}`);
  let stats;

  if (fs.existsSync(zipPath) && fs.existsSync(indexPath)) {
    stats = fs.statSync(zipPath);
  }

  console.log("Downloading", url);
  https.get(url, (res) => {
    res.pipe(fs.createWriteStream(zipPath)).on("finish", () => {
      console.log("Done Downloading");
      const o = spawnSync("unzip", ["-o", zipPath, "-d", folder]);
      console.log(o.stdout.toString());
      console.error(o.stderr.toString());
      console.log("Done Extracting");
      data.module = require(indexPath);
      callback(null, data);
    });
  }).on("error", (err) => {
    console.log("Error Downloading", err);
    callback(err);
  });
}

async function buildEvent() {
  if (!process.env.LEO_EVENT && (!process.env.AWS_LAMBDA_FUNCTION_NAME || !process.env.BOT) && (!process.env.LEO_CRON && !process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.BOT)) {
    console.log("(LEO_CRON and Bot) or (AWS_LAMBDA_FUNCTION_NAME and BOT) or LEO_EVENT are required as environment variables");
    process.exit();
  }

  const event = process.env.LEO_EVENT && JSON.parse(process.env.LEO_EVENT);
  if (event) {
    return event;
  }

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION,
    maxRetries: 2,
    convertEmptyValues: true,
    httpOptions: {
      connectTimeout: 2000,
      timeout: 5000,
      agent: new https.Agent({
        ciphers: 'ALL',
        secureProtocol: 'TLSv1_3_method'
      })
    }
  }));

  let id = process.env.BOT;
  let lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  let entry;

  if (!id) {
    entry = await docClient.send(new ScanCommand({
      TableName: process.env.LEO_CRON,
      FilterExpression: "lambdaName = :value",
      ExpressionAttributeValues: {
        ":value": lambdaName
      }
    })).then(data => data.Items[0]);
    id = entry.id;
  }

  if (!lambdaName) {
    entry = await docClient.send(new GetCommand({
      TableName: process.env.LEO_CRON,
      Key: {
        id: id
      }
    })).then(data => data.Item);
    lambdaName = entry.lambdaName;
  }

  const overrides = {};
  Object.keys(process.env).forEach(k => {
    const p = k.match(/^EVENT_(.*)/);
    if (p) {
      let v = process.env[k];
      if (v.match(/^[\d.]+$/)) {
        v = parseFloat(v);
      }
      console.log("Setting Event data", p[1], v);
      overrides[p[1]] = v;
    }
  });

  return Object.assign({}, entry.lambda && entry.lambda.settings && entry.lambda.settings[0] || {}, overrides, {
    __cron: {
      id: id,
      name: lambdaName,
      ts: Date.now(),
      iid: "0",
      force: true
    },
    botId: id
  });
}

function createContext(config) {
  const start = new Date();
  const maxTime = config.Timeout ? config.Timeout * 1000 : (10 * 365 * 24 * 60 * 60 * 1000); // Default is 10 years
  return {
    awsRequestId: "requestid-local" + Date.now().toString(),
    getRemainingTimeInMillis: function () {
      const timeSpent = new Date() - start;
      return timeSpent < maxTime ? maxTime - timeSpent : 0;
    }
  };
}
