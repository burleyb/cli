const { glob, globSync } = require('glob');
const path = require("path");
const fs = require("fs");
const merge = require('lodash.merge');
const utils = require("./utils");
const async = require("async");

const cmds = require("./build.js");
const buildConfig = require("./build-config").build;

module.exports = {
  createCloudFormation: async function (dir, opts) {
    opts = Object.assign({
      linkedStacks: [],
      config: undefined,
      force: false,
      targets: [],
      filter: "*",
      publish: true,
      tag: undefined,
      cloudFormationOnly: false
    }, opts || {});
    opts.filter = opts.filter || "*";
    opts.tag = (opts.tag ? (opts.tag.match(/^[/\\]/) ? opts.tag : `/${opts.tag}`) : "").replace(/\\/g, "/");

    opts.targets.forEach(target => {
      target.leoaws = require("leo-aws")(target.leoaws);
    });
    console.log("opts", JSON.stringify(opts.targets));

    try {
      const buckets = await this.getBuckets(opts.targets, {
        ignoreErrors: !opts.publish,
        name: opts.cliStack
      });

      const microservice = JSON.parse(fs.readFileSync(path.resolve(dir, "package.json")));
      let cloudFormation;
      if (opts.cloudformation) {
        cloudFormation = merge({}, opts.cloudformation, JSON.parse(fs.readFileSync(path.resolve(__dirname, "./cloud-formation/template/base.json"))));
      } else {
        cloudFormation = JSON.parse(fs.readFileSync(path.resolve(__dirname, "./cloud-formation/template/base.json")));
      }

      cloudFormation.Resources = Object.assign(cloudFormation.Resources, microservice.config && microservice.config.leo && microservice.config.leo.Resources || {});

      let defaultParameters = (microservice.config && microservice.config.leo && microservice.config.leo.no_env_param === true) ? {} : {
        "Environment": {
          "Type": "String",
          "Default": "dev",
          "MinLength": 1,
          "Description": "Environment"
        }
      };
      cloudFormation.Parameters = Object.assign(defaultParameters, cloudFormation.Parameters, microservice.config && microservice.config.leo && microservice.config.leo.Parameters || {});
      cloudFormation.Conditions = Object.assign({}, cloudFormation.Conditions, microservice.config && microservice.config.leo && microservice.config.leo.Conditions || {});
      cloudFormation.Outputs = Object.assign({}, cloudFormation.Outputs, microservice.config && microservice.config.leo && microservice.config.leo.Outputs || {});

      let version = microservice.version;
      let buildDir = `/tmp/${microservice.name}-${version}`;
      let tmpDir = path.resolve(dir, "/tmp");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir);
      }

      for (const key in buckets) {
        const data = buckets[key];
        cloudFormation.Mappings.RegionMap = Object.assign({}, cloudFormation.Mappings.RegionMap, {
          [data.region]: {
            "S3Bucket": data.bucket
          }
        });
      }
      addStacks(microservice, cloudFormation, opts.linkedStacks);
      console.log(path.resolve(dir, "*(bots|api)/{,!(node_modules)/**/}" + `/${opts.filter}/package.json`));

      const seenLambdaResourceNames = {};
      const files = glob.sync(path.resolve(dir, "*(bots|api)/{,!(node_modules)/**/}" + `/${opts.filter}/package.json`), { nodir: true }) 
      console.log("[files]", files);
      
      const entries = [];
      const processFiles = files.filter(f => !f.match(/\/node_modules\//)).map(f => {
        const pkg = merge({
          config: {
            leo: {}
          }
        }, JSON.parse(fs.readFileSync(f)));
        const leo = pkg.config.leo;

        if (leo.variations) {
          leo.variations.forEach((v, i) => {
            if (!v.name) {
              // TODO: Add memory and time to name
              v.name = i + 1;
            }
            const name = pkg.name + "-var-" + v.name;
            delete v.name;
            const newPackage = merge({
              config: {
                leo: {
                  isVariation: true,
                  variationUsesTime: v.cron && !!v.cron.time,
                  variationUsesTriggers: v.cron && !!v.cron.triggers
                }
              }
            }, pkg, {
              name: name,
              config: {
                leo: v
              }
            });

            processFiles.push({
              file: f,
              package: newPackage
            });
          });
        }
        return f;
      });

      const prevSwagger = merge({}, cloudFormation.Resources.RestApi && cloudFormation.Resources.RestApi.Properties.Body);
      processFiles.map((file) => {
        var filePackage;
        if (file.package) {
          filePackage = file.package;
          file = file.file;
        } else {
          filePackage = JSON.parse(fs.readFileSync(file));
        }

        const packageName = filePackage.name.replace(/[^a-zA-Z0-9]/g, '');
        const ID = filePackage.logicalResource || utils.properCaseTransform(filePackage.name);
        
        if (!(ID in seenLambdaResourceNames)) {
          seenLambdaResourceNames[ID] = {
            count: 0,
            paths: []
          };
        }
        seenLambdaResourceNames[ID].count++;
        seenLambdaResourceNames[ID].paths.push(file);

        const existing = cloudFormation.Resources[ID];
        filePackage = merge({
          config: {
            leo: {
              stacks: []
            }
          }
        }, filePackage);

        if (microservice.config && microservice.config.leo && microservice.config.leo.stacks) {
          filePackage.config.leo.stacks = filePackage.config.leo.stacks.concat(microservice.config.leo.stacks);
        }

        if (filePackage.config.leo.skip === true) {
          return;
        }

        let mergedConfig = buildConfig(file, null, filePackage);

        if (mergedConfig && mergedConfig.isVariation && mergedConfig.cron) {
          if (!mergedConfig.variationUsesTime)
            delete mergedConfig.cron.time;
          if (!mergedConfig.variationUsesTriggers)
            delete mergedConfig.cron.triggers;
        }
        filePackage.config.leo = mergedConfig;

        let version = filePackage.version;
        let botDirName = file.replace(/^.*(?:bots|api)[/\\](.*)[\\/]package\.json$/, "$1").replace(/\//g, "\\");
        console.log(opts.force, file, botDirName);
        if (opts.force === "all" ||
          (opts.force && opts.force.replace && opts.force.replace(/[^a-zA-Z0-9]/g, '') === ID) ||
          (opts.force && opts.force.replace && opts.force.replace(/[^a-zA-Z0-9]/g, '') === packageName) ||
          (opts.force && opts.force.replace(/\//g, "\\") === botDirName)) {
          version += "." + Date.now();
        }
        const newPath = `${microservice.name}${opts.tag}/${microservice.version}/${ID}_${version}.zip`;
        const existingPath = existing && existing.Properties.Code.S3Key.replace && existing.Properties.Code.S3Key || '';

        const entryData = createLambdaEntry(existing, filePackage, newPath, file, cloudFormation.Parameters, ID);
        if (entryData) {
          const prev_version = existingPath.replace(new RegExp(`${microservice.name}/.*?/${ID}_`), '').replace('.zip', '');
          const prev_versionCmp = prev_version.split(".").map(a => `             ${a}`.slice(-13)).join(".");
          const versionCmp = version.split(".").map(a => `             ${a}`.slice(-13)).join(".");
          if (prev_versionCmp < versionCmp || existingPath.indexOf(`${microservice.name}${opts.tag}/${microservice.version}/`) === -1) {
            entries.push({
              basename: `${ID}_${version}.zip`,
              file: path.dirname(file),
              version: version,
              prev_version: prev_version
            });
            cloudFormation.Resources[ID] = entryData;
          }
        }

        if (mergedConfig.type == "resource") {
          const swagger = getSwagger(cloudFormation, microservice);
          createApiEntries(ID, swagger, filePackage);

          cloudFormation.Resources[ID + "GatewayPermission"] = {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "FunctionName": {
                "Ref": ID
              },
              "Action": "lambda:InvokeFunction",
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Sub": "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/*"
              }
            }
          };
        }

        addStacks(filePackage, cloudFormation, opts.linkedStacks);

        const leoStack = findLeoStack(cloudFormation.Parameters);
        console.log("Leo Stack", leoStack);
        if (mergedConfig.type !== "resource" && leoStack && filePackage.config && filePackage.config.leo && filePackage.config.leo.cron && typeof filePackage.config.leo.cron !== "string") {
          if (cloudFormation.Resources[ID]) {
            filePackage.config.leo.cron.lambdaName = filePackage.config.leo.cron.lambdaName || {
              "Ref": ID
            };
          }
          let registerResourceName = "LeoRegister";
          if (filePackage.config.leo.register === "individual") {
            registerResourceName = ID + registerResourceName;
          } else if (filePackage.config.leo.register) {
            registerResourceName = filePackage.config.leo.register + registerResourceName;
          }
          cloudFormation.Resources[registerResourceName] = merge({}, cloudFormation.Resources[registerResourceName], {
            "Type": "Custom::Install",
            "Properties": {
              "ServiceToken": {
                "Fn::ImportValue": {
                  "Fn::Sub": `\${${leoStack}}-Register`
                }
              }
            },
          });
          cloudFormation.Resources[registerResourceName].Properties[ID] = Object.assign({
            id: filePackage.config.leo.id || filePackage.name || {
              "Fn::Sub": `\${${ID}.Arn}`
            }
          }, filePackage.config.leo.cron);
          if (cloudFormation.Resources[registerResourceName].Properties[ID].lambdaName === null) {
            delete cloudFormation.Resources[registerResourceName].Properties[ID].lambdaName;
          }
        }

      });

      const dups = Object.entries(seenLambdaResourceNames).filter(([key, value]) => value.count > 1).map(([key, value]) => `${key}:\n\t${value.paths.join("\n\t")}\n`);
      if (dups.length) {
        console.log(`Duplicate Cloudformation Resource(s): \n${dups.join('\n')}`);
        process.exit();
      }

      const leoStack = findLeoStack(cloudFormation.Parameters);
      if (leoStack) {
        const p = cloudFormation.Resources.ApiRole.Properties.ManagedPolicyArns || [];
        let addLeoPolicy = true;
        const leoPolicy = {
          "Fn::ImportValue": {
            "Fn::Sub": `\${${leoStack}}-Policy`
          }
        };
        const stringVersion = JSON.stringify(leoPolicy);
        p.map(policy => {
          addLeoPolicy = addLeoPolicy && JSON.stringify(policy) != stringVersion;
        });

        if (addLeoPolicy) {
          p.push(leoPolicy);
        }
        cloudFormation.Resources.ApiRole.Properties.ManagedPolicyArns = p;
      }
      const leoAuthStack = findLeoAuthStack(cloudFormation.Parameters);
      if (leoAuthStack) {
        const p = cloudFormation.Resources.ApiRole.Properties.ManagedPolicyArns || [];
        let addLeoAuthPolicy = true;
        const leoAuthPolicy = {
          "Fn::ImportValue": {
            "Fn::Sub": `\${${leoAuthStack}}-Policy`
          }
        };
        const stringVersion = JSON.stringify(leoAuthPolicy);
        p.map(policy => {
          addLeoAuthPolicy = addLeoAuthPolicy && JSON.stringify(policy) != stringVersion;
        });
        if (addLeoAuthPolicy) {
          p.push(leoAuthPolicy);
        }
        cloudFormation.Resources.ApiRole.Properties.ManagedPolicyArns = p;
      }

      let hasNewDeployment = false;
      if (!((microservice.config && microservice.config.leo && microservice.config.leo.subtype) || (cloudFormation.Resources.RestApi && cloudFormation.Resources.RestApi.Properties.Body))) {
        delete cloudFormation.Resources.RestApi;
      } else {
        if (cloudFormation.Resources.RestApi.Properties.Body) {
          cloudFormation.Resources.RestApi.Properties.Body.info.version = microservice.version;
        }
        cloudFormation.Resources.RestApi.Properties.Name = {
          "Fn::Sub": "${AWS::StackName}-" + microservice.name
        };
        cloudFormation.Resources.RestApi.Properties.Description = microservice.description || microservice.name;
      }

      let hasApp = false;
      if (microservice.config && microservice.config.leo && microservice.config.leo.subtype) {
        const ID = "ShowPages";
        let version = microservice.version.replace(/.\[0-9]{13}$/) + "." + Date.now();
        if (opts.force === "all" ||
          opts.filter == "*" ||
          opts.filter == ID ||
          (opts.force && opts.force.replace && opts.force.replace(/[^a-zA-Z0-9]/g, '') === ID)) {
          const data = cmds.createMicroserviceApp(dir, opts.config, version, {
            dir: buildDir,
            LogicalResourceId: ID
          });
          hasApp = data;
          const swagger = getSwagger(cloudFormation, microservice);
          Object.assign(swagger.paths, data.swagger.paths);

          const newPath = `${microservice.name}${opts.tag}/${microservice.version}/${data.LogicalResourceId}_${version}.zip`;
          cloudFormation.Resources[data.LogicalResourceId] = createLambdaEntry(cloudFormation.Resources[data.LogicalResourceId], {
            main: "index.js",
            config: {
              leo: {
                memory: 128,
                timeout: 3,
                type: "raw",
                env: microservice.config.leo.showPagesEnv,
                runtime: microservice.config.leo.runtime
              }
            }
          }, newPath, "", cloudFormation.Parameters, data.LogicalResourceId);
          cloudFormation.Resources[data.LogicalResourceId + "GatewayPermission"] = {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "FunctionName": {
                "Ref": data.LogicalResourceId
              },
              "Action": "lambda:InvokeFunction",
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Sub": "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/*"
              }
            }
          };
        }
      }

      const swaggerString = JSON.stringify(cloudFormation.Resources.RestApi && cloudFormation.Resources.RestApi.Properties && cloudFormation.Resources.RestApi.Properties.Body || {});
      const prevSwaggerString = JSON.stringify(prevSwagger || {});
      if (swaggerString !== prevSwaggerString) {
        Object.keys(cloudFormation.Resources).map(k => {
          if (k.match(/^ApiDeployment[0-9]{13}/)) {
            delete cloudFormation.Resources[k];
          }
        });
        var dkey = "ApiDeployment" + Date.now();
        hasNewDeployment = dkey;
        cloudFormation.Resources[dkey] = {
          Type: "AWS::ApiGateway::Deployment",
          Properties: {
            RestApiId: {
              Ref: "RestApi"
            },
            StageName: "Release",
            Description: `Version: ${microservice.version}`
          }
        };

        Object.keys(cloudFormation.Resources).map(k => {
          if (k.match(/^GatewayResponses[0-9]xx[0-9]{13}/)) {
            delete cloudFormation.Resources[k];
          }
        });
        dkey = "GatewayResponses5xx" + Date.now();
        cloudFormation.Resources[dkey] = {
          "Type": "AWS::ApiGateway::GatewayResponse",
          "Properties": {
            "ResponseParameters": {
              "gatewayresponse.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
              "gatewayresponse.header.Access-Control-Allow-Methods": "'GET,POST,PUT,DELETE,OPTIONS'",
              "gatewayresponse.header.Access-Control-Allow-Origin": "'*'"
            },
            "ResponseType": "DEFAULT_5XX",
            "RestApiId": {
              "Ref": "RestApi"
            }
          }
        };
        dkey = "GatewayResponses4xx" + Date.now();
        cloudFormation.Resources[dkey] = {
          "Type": "AWS::ApiGateway::GatewayResponse",
          "Properties": {
            "ResponseParameters": {
              "gatewayresponse.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
              "gatewayresponse.header.Access-Control-Allow-Methods": "'GET,POST,PUT,DELETE,OPTIONS'",
              "gatewayresponse.header.Access-Control-Allow-Origin": "'*'"
            },
            "ResponseType": "DEFAULT_4XX",
            "RestApiId": {
              "Ref": "RestApi"
            }
          }
        };
      }

      await this.overrideCloudFormation(dir, cloudFormation);

      console.log("\n\n\n----------------------Files with newer versions-----------------\n");
      entries.map((e, i) => console.log(`${i + 1}. ${e.basename}  ${e.prev_version} -> ${e.version}`));
      if (hasNewDeployment) {
        console.log(`${entries.length + 1}. ${hasNewDeployment}`);
      }
      if (hasApp) {
        console.log(`${entries.length + 2}. ${hasApp.LogicalResourceId}_${hasApp.version}`);
      }
      console.log(`${entries.length + (hasNewDeployment ? 1 : 0) + (hasApp ? 1 : 0) + 1}. cloudformation.json`);
      console.log(`\n\n${entries.length + (hasNewDeployment ? 1 : 0) + (hasApp ? 1 : 0)} file(s) will be updated\n`);
      console.log("If you don't see the files you expected, please update their version number or");
      console.log("rerun with the --force all OR --force [LambdaDirName] command\n");

      const summary = await this.buildAndPublish(dir, buildDir, entries, cloudFormation, opts, microservice, buckets, hasApp, version);
      return summary;
    } catch (err) {
      console.error(err);
      throw err;
    }
  },

  getBuckets: async function (targets, opts) {
    opts = merge({
      name: 'LEO-CLI',
      ignoreErrors: false
    }, opts || {});

    const tasks = targets.map(target => {
      return async (done) => {
        const cloudformation = target.leoaws.cloudformation;

        const extractData = (data) => {
          return {
            stack: opts.name,
            region: target.leoaws.region,
            target: target,
            bucket: data.filter(r => r.LogicalResourceId == "PublishBucket")[0].PhysicalResourceId
          };
        };
        
		let nonCriticalError = (err = {}, target) => {
			console.warn(`\nNon-critical Error: Unable to get publish buckets for stack ${opts.name} in region ${target.leoaws.region}. ${err.code}: '${err.message}'.\nContinuing with the build but the cloudformation.json will be missing the publish location.\n`);
			return {
				stack: opts.name,
				region: target.leoaws.region,
				target: target,
				bucket: undefined
			};
		};        

        try {
          const data = await cloudformation.describeStackResources(opts.name);
          return extractData(data);
        } catch (err) {
          if (err.message === `Stack with id ${opts.name} does not exist`) {
            console.log(`We cannot find a CloudFormation stack with the name ${opts.name} in region ${target.leoaws.region}`);
            console.log(`Creating "${opts.name}" stack for region ${target.leoaws.region}`);
            try {
              await cloudformation.createStack(opts.name, require("../cloudformation.json"), [], true);
              const data = await cloudformation.describeStackResources(opts.name);
              return extractData(data);
            } catch (err) {
              if (opts.ignoreErrors) {
                return nonCriticalError(err, target, done);
              } else {
                console.log(`Error creating "${opts.name}" stack:`, err);
                console.log(`Talk with your administrator to create the ${opts.name} stack`);
                process.exit();
              }
            }
          } else if (opts.ignoreErrors) {
            return nonCriticalError(err, target, done);
          } else {
            console.log("Failure in cloudformation.describeStackResources", err);
            done(err);
          }
        }
      };
    });

    const results = await async.parallelLimit(tasks, 2);
    return results;
  },

  overrideCloudFormation: async function (dir, cloudFormation) {
    const files = glob.sync(path.resolve(dir, "*cloudformation/{,!(node_modules)/**/}" + `/*.js`), { nodir: true })

    files.forEach(file => {
      const contents = require(file);
      merge(cloudFormation, contents.export ? contents.export() : contents);
    });
  },

  buildAndPublish: async function (dir, buildDir, entries, cloudFormation, opts, microservice, buckets, hasApp, version) {
    return new Promise((resolve, reject) => {
      cmds.build(opts, dir, {
        buildDir: buildDir,
        lambdas: entries,
        cloudFormation: cloudFormation,
        alias: opts.alias,
        region: opts.region,
        cloudFormationOnly: opts.cloudFormationOnly,
        variations: opts.variations,
        s3Folder: `/${microservice.name}${opts.tag}/${version}`
      }, async (err, data) => {
        if (err) return reject(err);
        if (!data) return resolve();

        const tasks = [];
        const summary = [];

        const publishjs = path.resolve(path.resolve(dir, "publish.js"));
        if (fs.existsSync(publishjs)) {
          tasks.push(done => require(publishjs)(buildDir, cloudFormation, done));
        }

        const deployedStatic = {};
        if (true || opts.publish !== false) {
          buckets.forEach((bucket) => {
            if (!opts.cloudFormationOnly && hasApp && !deployedStatic[bucket.target.s3]) {
              deployedStatic[bucket.target.s3] = true;
              tasks.push(async done => {
                await cmds.buildMicroserviceApp(dir, opts.config, hasApp.version, {
                  dir: buildDir,
                  files: hasApp.files,
                  profile: profile,
                  static: `${bucket.target.staticAssets}/${hasApp.version}/`,
                  cloudFormationOnly: opts.cloudFormationOnly,
                  publish: opts.publish
                });
                done();
              });
            }

            const s3region = bucket.region === "us-east-1" ? "" : `-${bucket.region}`;
            summary.push({
              region: bucket.region,
              url: `https://s3${s3region}.amazonaws.com/${bucket.bucket}/${microservice.name}${opts.tag}/${version}/`,
              cloudFormation: cloudFormation,
              target: bucket.target,
              version: data
            });
            const profile = (bucket.target.leoaws && bucket.target.leoaws.config && bucket.target.leoaws.config.credentials && bucket.target.leoaws.config.credentials.profile);
            const isPublic = opts.public || bucket.target.public;
            if (isPublic !== undefined && typeof isPublic === "object") {
              isPublic = isPublic[opts.tag || "default"] || false;
            }

            if (opts.publish !== false) {
              if (!opts.cloudFormationOnly) {
                tasks.push(async done => {
                  if (isPublic) {
                    console.log('Adding file with public access');
                  }
                  let res = await cmds.publish(buildDir, `s3://${bucket.bucket}/${microservice.name}${opts.tag}/${version}/`, {
                    public: isPublic,
                    profile: profile,
                    aws: bucket.target.leoaws
                  });
                  console.log("--- back from publish 1---", res)
                  done();
                });
              } else {
                tasks.push(async done => {
                  let rest = await cmds.publish(path.resolve(buildDir, "cloudformation.json"), `s3://${bucket.bucket}/${microservice.name}${opts.tag}/${version}/cloudformation.json`, {
                    public: isPublic,
                    command: "cp",
                    label: "Publishing cloudformation.json",
                    profile: profile,
                    aws: bucket.target.leoaws
                  });
                  console.log("--- back from publish 2---", res)
                  done();
                });
              }
              tasks.push(async done => {
                if (isPublic) {
                  console.log('Adding file with public access');
                }
                await cmds.publish(path.resolve(buildDir, "cloudformation.json"), `s3://${bucket.bucket}/${microservice.name}${opts.tag}/cloudformation-latest.json`, {
                  public: isPublic,
                  command: "cp",
                  label: "Publishing Latest cloudformation.json",
                  profile: profile,
                  aws: bucket.target.leoaws
                });
                  console.log("--- back from publish 3---")
                done();
              });
            }
          });
        }

        await async.series(tasks, err => {
          if (err) return reject(err);

          if (opts.publish !== false) {
            fs.readdirSync(buildDir).forEach((file) => {
              fs.unlinkSync(path.resolve(buildDir, file));
            });

            fs.rmdirSync(buildDir);
          }
          resolve(summary);
        });
      });
    });
  }
};

function createLambdaEntry(existing, properties, newPath, file, parameters = {}, LogicalResourceId) {
  const lambdaTemplate = JSON.parse(fs.readFileSync(path.resolve(__dirname, "./cloud-formation/template/lambda.json")));

  const config = merge({
    build: {},
    stacks: []
  }, (properties && properties.config && properties.config.leo) || {});

  if (config.type == "cron-template") {
    // No lambda to create
    var visit = function (obj) {
      Object.keys(obj)
        .forEach(k => {
          var v = obj[k];
          if (typeof v == "string" && v.match(/.*\.js$/)) {
            var codefile = path.resolve(path.dirname(file), v);
            if (fs.existsSync(codefile)) {
              obj[k] = fs.readFileSync(codefile, {
                encoding: "utf-8"
              });
            }
          } else if (typeof v == "object" && !Array.isArray(v)) {
            visit(v);
          }
        });
    };

    let obj = properties.config.leo.cron;
    if (obj.settings.mappings == undefined && !obj.lambdaName) {
      obj.settings.mappings = "index.js";
    }
    visit(obj.settings);

    return undefined;
  }

  if (config.cron && config.cron.lambdaName === null) {
    return undefined;
  }
  var env = {};

  // Only add leo-sdk and leo-auth env variables if this is a third party
  if (config["3rdParty"]) {
    const hasLeoStack = findLeoStack(parameters);
    if (hasLeoStack && (!config.env || !("leosdk" in config.env))) {
      config.env = config.env || {};
      config.env["leosdk"] = {
        "Fn::LeoSdk": `\${${hasLeoStack}}`
      };
    }

    const hasLeoAuthStack = findLeoAuthStack(parameters);
    if (config.type == "resource" && hasLeoAuthStack && (!config.env || !("leoauthsdk" in config.env))) {
      config.env = config.env || {};
      config.env["leoauthsdk"] = {
        "Fn::LeoAuthSdk": `\${${hasLeoAuthStack}}`
      };
    }
  }

  if (config.env) {
    env = {};
    Object.keys(config.env).map(k => {
      let v = config.env[k];
      let wrap = true;
      if (typeof v !== "string") {
        const t = JSON.stringify(v);
        if (!t.match(/Fn::/)) {
          v = t;
        } else {
          if (t.match(/"Fn::(LeoResources)":"(\$\{.*?\})"/)) {
            const lookups = JSON.stringify({
              "LeoStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoStream"
                }
              },
              "LeoCron": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoCron"
                }
              },
              "LeoEvent": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoEvent"
                }
              },
              "LeoSettings": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoSettings"
                }
              },
              "LeoSystem": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoSystem"
                }
              },
              "LeoS3": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoS3"
                }
              },
              "LeoKinesisStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoKinesisStream"
                }
              },
              "LeoFirehoseStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoFirehoseStream"
                }
              },
              "Region": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-Region"
                }
              }
            });
            const sub = JSON.stringify({
              "LeoStream": "${LeoStream}",
              "LeoCron": "${LeoCron}",
              "LeoEvent": "${LeoEvent}",
              "LeoSettings": "${LeoSettings}",
              "LeoSystem": "${LeoSystem}",
              "LeoS3": "${LeoS3}",
              "LeoKinesisStream": "${LeoKinesisStream}",
              "LeoFirehoseStream": "${LeoFirehoseStream}",
              "Region": "${Region}"
            });
            v = JSON.parse(t.replace(/"Fn::(LeoResources)":"(\$\{.*?\})"/, `"Fn::Sub":[${JSON.stringify(sub)}, ${lookups}]`));
          }
          if (t.match(/"Fn::(LeoSdk)":"(\$\{.*?\})"/)) {
            const lookups = JSON.stringify({
              "LeoStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoStream"
                }
              },
              "LeoCron": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoCron"
                }
              },
              "LeoEvent": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoEvent"
                }
              },
              "LeoSettings": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoSettings"
                }
              },
              "LeoSystem": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoSystem"
                }
              },
              "LeoS3": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoS3"
                }
              },
              "LeoKinesisStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoKinesisStream"
                }
              },
              "LeoFirehoseStream": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoFirehoseStream"
                }
              },
              "Region": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-Region"
                }
              }
            });
            const sub = JSON.stringify({
              "region": "${Region}",
              "kinesis": "${LeoKinesisStream}",
              "s3": "${LeoS3}",
              "firehose": "${LeoFirehoseStream}",
              "resources": {
                "LeoStream": "${LeoStream}",
                "LeoCron": "${LeoCron}",
                "LeoEvent": "${LeoEvent}",
                "LeoSettings": "${LeoSettings}",
                "LeoSystem": "${LeoSystem}",
                "LeoS3": "${LeoS3}",
                "LeoKinesisStream": "${LeoKinesisStream}",
                "LeoFirehoseStream": "${LeoFirehoseStream}",
                "Region": "${Region}"
              }
            });
            v = JSON.parse(t.replace(/"Fn::(LeoSdk)":"(\$\{.*?\})"/, `"Fn::Sub":[${JSON.stringify(sub)}, ${lookups}]`));
          }
          if (t.match(/"Fn::(LeoAuthSdk)":"(\$\{.*?\})"/)) {
            const lookups = JSON.stringify({
              "LeoAuth": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoAuth"
                }
              },
              "LeoAuthUser": {
                "Fn::ImportValue": {
                  "Fn::Sub": "$2-LeoAuthUser"
                }
              }
            });
            const sub = JSON.stringify({
              "region": "${AWS::Region}",
              "resources": {
                "LeoAuth": "${LeoAuth}",
                "LeoAuthUser": "${LeoAuthUser}",
                "Region": "${AWS::Region}"
              }
            });
            v = JSON.parse(t.replace(/"Fn::(LeoAuthSdk)":"(\$\{.*?\})"/, `"Fn::Sub":[${JSON.stringify(sub)}, ${lookups}]`));
          }
          wrap = false;
        }
      }

      if (wrap) {
        env[k] = {
          "Fn::Sub": v
        };
      } else {
        env[k] = v;
      }
    });
  }

  if (parameters.Environment) {
    env["NODE_ENV"] = {
      "Fn::Sub": "${Environment}"
    };
  }

  const formation = merge({}, lambdaTemplate, existing, {
    Properties: {
      FunctionName: config.staticFunctionNames ? { "Fn::Sub": `\${AWS::StackName}-${LogicalResourceId}` } : undefined,
      Code: config.code || lambdaTemplate.Properties.Code,
      Description: properties.description,
      Handler: properties.main.replace(/.js/, '') + "." + (properties.config.leo.handler || 'handler'),
      MemorySize: config.memory || undefined,
      Layers: config.layers || undefined,
      ReservedConcurrentExecutions: config.reservedinstances || undefined,
      TracingConfig: config.trace && config.trace == true ? "Active" : undefined, 
      Timeout: config.timeout || undefined,
      Runtime: config.runtime || undefined,
      Environment: {
        Variables: env
      },
      VpcConfig: config.VpcConfig,
      Tags: [parameters.Environment ? {
        Key: 'environment',
        Value: {
          "Fn::Sub": "${Environment}"
        }
      } : null].concat(config.Tags || []).concat(config.tags || []).filter(t => t)
    },
    DependsOn: config.DependsOn
  });

  if (config.condition) formation.Condition = config.condition;

  let role = config.role || (config.aws && config.aws.role);
  if (role) {
    if (typeof role === "string" && !role.match(/^arn:aws:iam::/)) {
      role = {
        "Fn::Sub": `\${${role}.Arn}`
      };
    }
    formation.Properties.Role = role;
  }

  formation.Properties.Code.S3Key = newPath;
  return formation;
}

function createApiEntries(ID, swagger, properties) {
  const config = merge({}, (properties && properties.config && properties.config.leo) || {});

  if (!Array.isArray(config.uri)) {
    config.uri = [config.uri];
  }

  for (let i = 0; i < config.uri.length; i++) {
    const parts = config.uri[i].split(/:/);
    let method = parts.slice(0, 1)[0].toLowerCase();
    if (method == "any") {
      method = "x-amazon-apigateway-any-method";
    }
    const resource = parts.slice(1).join(":");
    if (!(resource in swagger.paths)) {
      swagger.paths[resource] = {};
    }
    const snippet = swagger.paths[resource];
    snippet[method] = {
      "produces": [
        "application/json"
      ],
      "security": [{
        "sigv4": []
      }],

      "responses": {
        "200": {
          "description": "200 response",
          "schema": {
            "$ref": "#/definitions/Empty"
          },
          "headers": {
            "Access-Control-Allow-Origin": {
              "type": "string"
            }
          }
        }
      },
      "x-amazon-apigateway-integration": {
        "responses": {
          "default": {
            "statusCode": "200",
          }
        },
        "uri": {
          "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${ID}.Arn}/invocations`
        },
        "passthroughBehavior": "when_no_match",
        "httpMethod": "POST",
        "contentHandling": "CONVERT_TO_TEXT",
        "type": "aws_proxy"
      }
    };
    if (config.secure === false) {
      delete snippet[method].security;
    }
    if (config.cors) {
      snippet[method]["x-amazon-apigateway-integration"].responses.default.responseParameters = {
        "method.response.header.Access-Control-Allow-Origin": "'" + config.cors + "'"
      };

      snippet.options = {
        "consumes": [
          "application/json"
        ],
        "produces": [
          "application/json"
        ],
        "responses": {
          "200": {
            "description": "200 response",
            "schema": {
              "$ref": "#/definitions/Empty"
            },
            "headers": {
              "Access-Control-Allow-Origin": {
                "type": "string"
              },
              "Access-Control-Allow-Methods": {
                "type": "string"
              },
              "Access-Control-Max-Age": {
                "type": "string"
              },
              "Access-Control-Allow-Headers": {
                "type": "string"
              }
            }
          }
        },
        "x-amazon-apigateway-integration": {
          "responses": {
            "default": {
              "statusCode": "200",
              "responseParameters": {
                "method.response.header.Access-Control-Max-Age": "'3000'",
                "method.response.header.Access-Control-Allow-Methods": "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'",
                "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                "method.response.header.Access-Control-Allow-Origin": "'" + config.cors + "'"
              }
            },
            "requestTemplates": {
              "application/json": "{\"statusCode\": 200}"
            },
            "passthroughBehavior": "when_no_match",
            "type": "mock"
          }
        }
      };
    }
  }
}

const leoStackAliases = {
  "leosdk": true,
  "leobus": true,
  "bus": true
};
const leoAuthStackAliases = {
  "leoauth": true,
  "auth": true
};

function findStack(parameters, aliases) {
  return Object.keys(parameters).filter(key => aliases[key.replace(/[^a-zA-z0-9]/g, "").toLowerCase()])[0];
}

function findLeoStack(parameters = {}) {
  return findStack(parameters, leoStackAliases);
}

function findLeoAuthStack(parameters = {}) {
  return findStack(parameters, leoAuthStackAliases);
}

function addStacks(filePackage, cloudFormation, additionalStacks) {
  let stacks = (filePackage.config && filePackage.config.leo && filePackage.config.leo.stacks) || [];
  stacks = stacks.concat(additionalStacks || []);
  if (stacks.length) {
    cloudFormation.Parameters = cloudFormation.Parameters || {};
  }

  stacks.map(stack => {
    const stackName = stack.replace(/[^a-zA-z0-9]/g, "");
    if (!(stackName in cloudFormation.Parameters)) {
      cloudFormation.Parameters[stackName] = {
        "Type": "String",
        "Description": `Reference to the "${stack}" stack`
      };
    }
  });
}

function getSwagger(cloudFormation, microservice) {
  return cloudFormation.Resources.RestApi.Properties.Body = cloudFormation.Resources.RestApi && cloudFormation.Resources.RestApi.Properties.Body || {
    "swagger": "2.0",
    "info": {
      "version": `${microservice.version}`,
      "title": microservice.name
    },
    "basePath": "/",
    "schemes": ["https"],
    "paths": {},
    "securityDefinitions": {
      "sigv4": {
        "type": "apiKey",
        "name": "Authorization",
        "in": "header",
        "x-amazon-apigateway-authtype": "awsSigv4"
      }
    },
    "definitions": {
      "Empty": {
        "type": "object"
      }
    }
  };
}
