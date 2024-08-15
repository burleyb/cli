let { Lambda, S3, STS } = require("@aws-sdk/client-lambda");
let { fromIni } = require("@aws-sdk/credential-provider-ini");
let { createRequire } = require('module');
let require = createRequire(import.meta.url);
let fs = require("fs");
let path = require("path");

let http = require("http");
let https = require("https");
let zlib = require("zlib");
const glob = require("glob");
let botRunner = require("./leo-bot-run.js");
let spawnSync = require('child_process').spawnSync;
let spawn = require('child_process').spawn;
let execSync = require('child_process').execSync;
let moment = require("moment");

let lambda = new Lambda({
	region: leo.configuration.region,
	credentials: fromIni({ profile: leo.configuration.credentials })
});
let s3 = new S3({
	region: leo.configuration.region,
	credentials: fromIni({ profile: leo.configuration.credentials })
});

let cache;
let processcwd = process.cwd();

exports.handler = async function (event, context, callback) {
	console.log("Bot:", event.__cron.id);
	let setup = async (c) => {
		c(null, cache);
	};

	let importModule = async function (url, data, callback) {
		data = Object.assign({
			main: "index.js",
			index: "handler"
		}, data);
		let zipPath = path.resolve("", `/tmp/run_${event.__cron.id}.zip`);
		let indexPath = path.resolve("", `/tmp/run_${event.__cron.id}/${data.main}`);
		let folder = path.resolve("", `/tmp/run_${event.__cron.id}`)
		let stats;
		if (fs.existsSync(zipPath) && fs.existsSync(indexPath)) {
			stats = fs.statSync(zipPath);
		}
		if (stats && data.lastModified && moment(stats.mtime) >= moment(data.lastModified)) {
			data.module = require(indexPath);
			return callback(null, data);
		}

		console.log("Downloading", url, zipPath);
		https.get(url, (res) => {
			res.pipe(fs.createWriteStream(zipPath)).on("finish", () => {
				console.log("Done Downloading");
				let o = spawnSync("unzip", ["-o", zipPath, "-d", folder]);
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
	};

	if (fs.existsSync(path.resolve(processcwd, "package.json"))) {
		setup = async (callback) => {
			getPackageJson(processcwd, (err, lookup) => {
				let data = {};
				if (event.__cron.id in lookup) {
					data = lookup[event.__cron.id];
				} else {
					data = {
						file: path.resolve(processcwd, "package.json"),
						package: require(path.resolve(processcwd, "package.json"))
					};
				}

				let pkgStats = fs.statSync(data.file);
				let handlerStats = fs.statSync(path.resolve(path.dirname(data.file), data.package.main));
				let latest = Math.max(pkgStats && pkgStats.mtime || 0, handlerStats && handlerStats.mtime || 0);
				if (cache && latest && cache.LastModified && moment(latest) <= moment(cache.LastModified)) {
					return callback(null, cache);
				}

				let cmd = (data.package.scripts && data.package.scripts.run) || (data.package.scripts && data.package.scripts.test) || "leo-cli run .";
				let args = parseArgsStringToArgv(cmd);

				process.chdir(path.dirname(data.file));
				botRunner(args, (err, module) => {
					callback(err, {
						LastModified: latest,
						Configuration: {
							Timeout: module.config && module.config.timeout
						},
						module: {
							handler: function (event, context, callback) {
								event = Object.assign({}, module.event, event);
								return module.handler(module.runner.event(event), context, callback);
							}
						}
					});
				});
			});
		};
	} else if (fs.existsSync(path.resolve("", "index.js"))) {
		setup = async (callback) => {
			callback(null, {
				handler: "handler",
				module: require(path.resolve("", "index.js"))
			});
		};
	} else if (event.__cron.lambdaName && event.__cron.lambdaName != "Leo_core_custom_lambda_bot") {
		setup = async (callback) => {
			console.log("Getting Lambda Settings");
			try {
				let data = await lambda.getFunction({
					FunctionName: event.__cron.lambdaName
				}).promise();
				await importModule(data.Code.Location, {
					main: `${data.Configuration.Handler.split(".")[0]}.js`,
					handler: data.Configuration.Handler.split(".")[1],
					lastModified: data.Configuration.LastModified
				}, callback);
			} catch (err) {
				callback(err);
			}
		};
	} else if (event.__cron.code) {
		let code = event.__cron.code;
		if (typeof event.__cron.code == "string") {
			code = {
				url: event.__cron.code,
				main: "index.js",
				handler: "handler"
			};
		}
		let parts = code.url;
		if (code.url) {
			parts = code.url.match(/^(?:https?:\/\/s3(?:-(.*?))?\.amazonaws.com\/)(.*?)\/(.*)/);
			if (parts) {
				code.Region = parts[1] || "us-east-1";
				code.Bucket = parts[2];
				code.Key = parts[3];
			}
		}
		if (code.Bucket) {
			let s3 = new S3({
				region: code.Region,
				credentials: fromIni({ profile: leo.configuration.credentials })
			});
			code.url = s3.getSignedUrl("getObject", {
				Bucket: code.Bucket,
				Key: code.Key,
				Expires: 900
			});
			setup = async (callback) => {
				console.log("Getting S3 file Settings");
				try {
					let head = await s3.headObject({
						Bucket: code.Bucket,
						Key: code.Key,
					}).promise();
					await importModule(code.url, {
						main: code.main || "index.js",
						handler: code.handler || "handler",
						lastModified: head.LastModified
					}, callback);
				} catch (err) {
					callback(err);
				}
			};
		} else if (code.url) {
			setup = async (callback) => {
				await importModule(code.url, {
					main: code.main || "index.js",
					handler: code.handler || "handler",
					lastModified: code.lastModified
				}, callback);
			};
		} else if (code.file) {
			setup = async (callback) => {
				callback(null, {
					handler: code.handler || "handler",
					module: require(path.resolve("", code.file))
				});
			};
		} else {
			setup = (c) => { c("Unknown code location"); };
		}
	} else {
		setup = (c) => { c("Unknown code location"); };
	}

	setup(async (err, data) => {
		if (err) {
			console.log(err);
			return callback(err);
		}
		cache = data;
		console.log(data);
		let context = createContext(data.Configuration || {});
		cache.module[data.handler || "handler"](event, context, callback);
	});
};

if (process.send) {
	var settings;
	process.on("message", (msg) => {
		if (msg.action === "start") {
			settings = msg.cron;
			exports.handler(settings, {}, function (err, data) {
				process.send({ action: "complete", err: err, data: data });
			});
		} else if (msg.action == "update") {
		}
	});
}

function createContext(config) {
	var start = new Date();
	var maxTime = config.Timeout ? config.Timeout * 1000 : moment.duration({ years: 10 }).asMilliseconds();
	return {
		awsRequestId: "requestid-local" + moment.now().toString(),
		getRemainingTimeInMillis: function () {
			var timeSpent = new Date() - start;
			if (timeSpent < maxTime) {
				return maxTime - timeSpent;
			} else {
				return 0;
			}
		}
	};
}

let packagelookups;
function getPackageJson(dir, callback) {
	if (packagelookups) {
		return callback(null, packagelookups);
	}
	let p = path.resolve(path.resolve(dir, "*(bots|api)/{,!(node_modules)/**/}/*/package.json"));
	glob(p, {
		nodir: true
	}, function (err, files) {
		let lookup = {};
		files = files.filter(f => !f.match(/\/node_modules\//)).map(f => {
			let pkg = require(f);
			let id = (pkg.config && pkg.config.leo && (pkg.config.leo.cron && pkg.config.leo.cron.id || pkg.config.leo.id)) || pkg.name;
			lookup[id] = { file: f, package: pkg };
		});
		callback(null, lookup);
	});
}

function parseArgsStringToArgv(value, env, file) {
	var myRegexp = /([^\s'"]+(['"])([^\2]*?)\2)|[^\s'"]+|(['"])([^\4]*?)\4/gi;
	var myString = value;
	var myArray = [];
	if (env) {
		myArray.push(env);
	}
	if (file) {
		myArray.push(file);
	}
	var match;
	do {
		match = myRegexp.exec(myString);
		if (match !== null) {
			myArray.push(match[1] || match[5] || match[0]);
		}
	} while (match !== null);

	return myArray;
}
