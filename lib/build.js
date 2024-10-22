const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { S3Client } = require("@aws-sdk/client-s3");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const glob = require("glob");
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ProgressPlugin = require('progress-webpack-plugin');
const merge = require('lodash.merge');

const babelify = require("babelify");
const { spawn } = require('child_process');
const { promisify } = require('util');
const { execSync }= require('child_process');
const { exec } = require('child_process');
const execPromise = promisify(exec);

const through = require('through2');
const PassThrough = require("stream").PassThrough;
const { IgnorePlugin } = require('webpack');

const async = require("async");
const moment = require("moment");

let utils = {
	findParentFiles: function (dir, filename) {
		let paths = [];
		let lastDir;
		do {
			paths.push(dir);

			lastDir = dir;
			dir = path.resolve(dir, "../");
		} while (dir !== lastDir);

		let matches = [];
		paths.forEach(function (dir) {
			let file = path.resolve(dir, filename);
			if (fs.existsSync(file)) {
				matches.push(file);
			}
		});
		return matches;
	}
};
let configure;

// Build Stuff
const browserify = require('browserify');
const gulp = require("gulp");
const source = require('vinyl-source-stream');
const buffer = require('vinyl-buffer');
const gutil = require('gulp-util');
const rename = require('gulp-rename');
const ejs = require("gulp-ejs");
const buildConfig = require("./build-config").build;
var showPagesTemplate = fs.readFileSync(path.resolve(__dirname, "../templates/showpages.js"), 'utf-8');

// Webpack
const webpack = require('webpack');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
	build: async function (program, rootDir, opts = {} ) {
		opts = Object.assign({
			alias: program.env || 'dev',
			region: program.region || 'us-east-1',
			lambdas: [],
			public: false,
			buildDir: '/tmp/leo',
			cloudFormationOnly: false
		}, opts || {});

		process.env.LEO_ENV = opts.alias;
		process.env.LEO_REGION = opts.region;

		configure = buildConfig(rootDir);
		configure.aws = configure.aws || {};
		let region = configure._meta.region;

		if (program.profile) {
			console.log("Using cli profile", program.profile);
			configure.aws.profile = program.profile;
		}

		if (configure.aws.profile) {
			console.log("Setting aws profile to", configure.aws.profile);
			const credentials = fromIni({ profile: configure.aws.profile });
			const sts = new STSClient({ region, credentials });

			const data = await sts.send(new AssumeRoleCommand({
				RoleArn: 'arn:aws:iam::123456789012:role/RoleName', // Adjust the RoleArn as needed
				RoleSessionName: 'session1'
			}));

			process.env.AWS_DEFAULT_PROFILE = configure.aws.profile;
		}

		let pkg = require(path.resolve(rootDir, "package.json"));

		if (!fs.existsSync(opts.buildDir)) {
			fs.mkdirSync(opts.buildDir);
		}

		let config = configure;
		if (["bot", "cron", "resource", "apigateway"].includes(config.type)) {
			await buildLambdaDirectory(rootDir, {
				dir: opts.buildDir,
				basename: rootDir,
				main: pkg.main
			});
		} else if (["package", "microservice"].includes(config.type)) {
			if (fs.existsSync(path.resolve(rootDir, "cloudformation.json"))) {
				fs.readFileSync(path.resolve(rootDir, "cloudformation.json"), {
					encoding: "utf-8"
				});
			}

			if (!opts.cloudFormationOnly) {
				console.time("Lambda zip files completed");
				console.log("\n\n---------------Building Lambda-------------------\n\n");
				return await new Promise((resolve, reject) => {
				
					let resdata = async.mapLimit(opts.lambdas, config.parallelCompile || 5, async (lambdaDir) => {
						try {
							let pkg = require(path.resolve(lambdaDir.file, "package.json"));
							 let data = await buildLambdaDirectory(lambdaDir.file, {
								dir: opts.buildDir,
								basename: lambdaDir.basename,
								main: pkg.main,
								microserviceDir: rootDir
							})
							return data;
						} catch (err) {
							console.error("Error in lambda build:", err);
							throw err; 
						}							
						
					}, (err, data) => {
						if (err) {
			                console.error("[err]", err);
			                return reject(err); 
			            }						
						
						console.log("\n\n---------------Done Building Lambda-------------------\n");
						console.timeEnd("Lambda zip files completed");
						writeCloudFormation(rootDir, opts, program, config)
						.then(res => { 
							resolve(res) 
						})
		                .catch(writeErr => {
		                    console.error("Error in writeCloudFormation:", writeErr);
		                    reject(writeErr); 
		                });
					})
					return resdata
				})
				
			} else {
				await writeCloudFormation(rootDir, opts, program, config);
				return true
			}
		} else {
			console.log("Unknown config.leo.type, not in (bot, cron, resource, microservice) ", rootDir);
			return true;
		}
	},
	publish: async function (rootDir, remoteDir, opts) {
		opts = Object.assign({
			public: false,
			profile: null
		}, opts || {});
		if (opts.cloudFormationOnly) {
			return true;
		}

		console.log(`\n\n---------------${opts.label || "Publishing files"}-------------------`);
		console.log(`From ${rootDir} to ${remoteDir}`);
		console.time("Published Files");

		let args = ['s3', opts.command || 'sync', rootDir, `${remoteDir}`];
		if (opts.public) {
			args.push("--grants", "read=uri=http://acs.amazonaws.com/groups/global/AllUsers");
		}

		if (opts.profile) {
			var data = null
			if(typeof opts.profile == "function") {
				data = await opts.profile()
			} else {
				data = await fromIni({ profile: opts.profile })();
			}
			
			let env = {
				AWS_ACCESS_KEY_ID: data.AccessKeyId,
				AWS_SECRET_ACCESS_KEY: data.SecretAccessKey,
				AWS_SESSION_TOKEN: data.SessionToken
			};
			await upload(args, env);
		} else {
			await upload(args, {});
		}
	},
	buildStaticAssets: async function (rootDir, configure, newVersion, opts ) {
		const { stdout, stderr } = await execPromise("npm install --loglevel=error", {
			cwd: rootDir
		});
		
		// console.log('stdout:', stdout);
		// console.error('stderr:', stderr);
		    
		if (configure.subtype == "static") {
			let jsStaticDir = path.normalize(path.resolve(rootDir, "static/**"));
			let distStaticDir = path.normalize(path.join(rootDir, `/dist/`));

			if (!fs.existsSync(distStaticDir)) {
				fs.mkdirSync(distStaticDir);
			}

			let name = configure.name.toLowerCase();
			let publicPath = "/" + name + "/" + newVersion + "/";

			console.log("Dist Directory:", distStaticDir);
			console.log("JS Directory:", jsStaticDir);
			console.log("Public Path:", publicPath);

			let files = glob.sync(jsStaticDir + "**/**", {
				nodir: true
			})
			// console.log("[files]", files);
			let entries = {};
			files.map((file) => {
				// console.log("[file]", file);
				if (file.indexOf(".html") < 0) {
					entries[path.basename(file, ".js")] = [file];
				}
			});
			// console.log("[entries]", entries);
			
			const nodeExternals = require('webpack-node-externals');
			
			class LogFilesPlugin {
				apply(compiler) {
				compiler.hooks.compilation.tap('LogFilesPlugin', (compilation) => {
					compilation.hooks.buildModule.tap('LogFilesPlugin', (module) => {
						if(module.resource) {
							console.log('------ Processing: --------' );
							console.log("Context: ", module.context);
							console.log("Resource: ", module.resource);
							console.log("Included From: ", module.resourceResolveData?.context?.issuer);
							console.log('------ END: --------');
						}
					});
				});
				}
			}				

			let config = [{
				devtool: 'eval-source-map',
				entry: entries,
				externals: [nodeExternals(), { 
					fs: 'commonjs fs',
					path: 'commonjs path',
					worker_threads: 'commonjs worker_threads',
					process: 'commonjs process',
					url: 'commonjs url'}
				],					
				output: {
					path: path.join(rootDir, `/dist/`),
					publicPath: publicPath
				},
				mode: "production",
				node: {
					fs: "empty"
				},
				resolve: {
					modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
				},
				resolveLoader: {
					modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
				},
				optimization: {
					minimize: true,
					splitChunks: {
						cacheGroups: {
							common: {
								test: /node_modules/,
								name: "common",
								chunks: "initial",
								enforce: true
							}
						}
					}
				},
				plugins: [
					new CopyWebpackPlugin({
						patterns: [
							{ from: path.join(rootDir, `/static/`) },
						]
					}),
					new webpack.DefinePlugin({
						'process.env': {
							'NODE_ENV': JSON.stringify('production')
						}
					}),
					new LogFilesPlugin(),
					new MiniCssExtractPlugin("css/[name].css")
				],
				module: {
					rules: [{
						test: /\.js?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'babel-loader',
							options: {
								babelrc: true,
								cacheDirectory: true
							}
						}
					}, {
						test: /\.html$/i,
						loader: 'html-loader',
					}, {
						test: /\.(less|css)$/,
						exclude: /(node_modules|bower_components)/,
						use: MiniCssExtractPlugin.extract({
							fallback: "style-loader",
							use: "css-loader!less-loader"
						})
					}, {
						test: /\.scss$/,
						exclude: /(node_modules|bower_components)/,
						use: MiniCssExtractPlugin.extract({
							fallback: "style-loader",
							use: "css-loader!sass-loader"
						})
					}, {
						test: /\.(jpg|jpeg|gif|png)$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'url-loader?limit=2000&name=images/[name].[ext]'
						}
					}, {
						test: /\.json?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'json-loader'
						}
					}, {
						test: /\.woff(2)?(\?.*)?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: "url-loader?limit=10000&mimetype=application/font-woff&name=images/[name].[ext]"
						}
					}, {
						test: /\.(ttf|eot|svg)(\?.*)?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: "file-loader"
						}
					}]
				}
			}];
			// @ts-ignore
			await webpack(config, function (err, stats) {
				if (err) {
					console.log("============== ERROR ==============");
					console.log(err);
				} else {
					console.log(stats.toString({
						assets: true,
						colors: true,
						version: false,
						hash: false,
						timings: false,
						chunks: false,
						chunkModules: false
					}));
				}
			});

			return path.normalize(path.resolve(rootDir, "dist"));
		
		} else if (configure.subtype == "react") {
			let jsDir = path.normalize(path.resolve(rootDir, "ui/js/"));
			let viewDir = path.normalize(path.resolve(rootDir, "views"));
			let viewEJSDir = path.normalize(path.resolve(rootDir, "views_ejs"));
			let distDir = path.normalize(path.join(rootDir, `/dist/`));

			if (!fs.existsSync(distDir)) {
				fs.mkdirSync(distDir);
			}

			let name = configure.name.toLowerCase();
			let publicPath = "/" + name + "/" + newVersion + "/";

			console.log("Dist Directory:", distDir);
			console.log("View Directory:", viewDir);
			console.log("View EJS Directory:", viewEJSDir);
			console.log("JS Directory:", jsDir);
			console.log("Public Path:", publicPath);

			let files = glob.sync(jsDir + "/*.{js,jsx}", {
				nodir: true
			}) 
			
			let entries = {};
			files.map((file) => {
				entries[path.basename(file, ".js")] = [file];
			});

			const staticDir = path.join(rootDir, `/ui/static/`);
			let staticDirCopyPlugin = undefined;
			if (fs.existsSync(staticDir)) {
				staticDirCopyPlugin = new CopyWebpackPlugin({
					patterns: [{ from: staticDir }]
				});
			}
			const CircularDependencyPlugin = require('circular-dependency-plugin');
			const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

			// console.log("[entries]", entries)

			let config = [{
				devtool: 'eval-source-map',
				entry: entries,
				output: {
					path: path.join(rootDir, `/dist/`),
					filename: 'js/[name].js',
					chunkFilename: 'js/[name].js',
					publicPath: publicPath
				},
				mode: "production",
				node: {},
				resolve: {
					extensions: ['.js', '.jsx'],                
					modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
				},
				resolveLoader: {
					modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
				},
				optimization: {
					minimize: true,
					splitChunks: {
						cacheGroups: {
							common: {
								test: /node_modules/,
								name: "common",
								chunks: "initial",
								enforce: true
							}
						}
					}
				},
				plugins: [
					staticDirCopyPlugin,
					new webpack.DefinePlugin({
						'process.env': {
							'NODE_ENV': JSON.stringify('production')
						}
					}),
					new MiniCssExtractPlugin({ filename: "css/[name].css" }),
					new ProgressPlugin({
						profile: true,
						handler: (percentage, message, ...args) => {
							console.info(`${Math.round(percentage * 100)}%`, message, ...args);
						},
						modulesCount: 5000,
						dependenciesCount: 10000,
						showEntries: true,
						showModules: true,
						showDependencies: true,
						showActiveModules: true,
						percentBy: undefined
					}),						
				],
				module: {
					rules: [{
						test: /\.jsx?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'babel-loader',
							options: {
								babelrc: true,
								cacheDirectory: true
							}
						}
					}, {
						test: /\.(less|css)$/,
						exclude: /(node_modules|bower_components)/,
						use: [MiniCssExtractPlugin.loader, "css-loader", "less-loader" ]
					}, {
						test: /\.scss$/,
						exclude: /(node_modules|bower_components)/,
						use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"]
					}, {
						test: /\.(jpg|jpeg|gif|png)$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'url-loader?limit=2000&name=images/[name].[ext]'
						}
					}, {
						test: /\.json?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: 'json-loader'
						}
					}, {
						test: /\.woff(2)?(\?.*)?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: "url-loader?limit=10000&mimetype=application/font-woff&name=images/[name].[ext]"
						}
					}, {
						test: /\.(ttf|eot|svg)(\?.*)?$/,
						exclude: /(node_modules|bower_components)/,
						use: {
							loader: "file-loader"
						}
					}]
				}
			}];

			const webpackPromise = (config) => {
				return new Promise((resolve, reject) => {
				  webpack(config, (err, stats) => {
					if (err) {
					  console.log(err);
					  reject(err);
					} else {
					  // @ts-ignore
					  console.log(stats.toString({
						assets: true,           // Show list of assets generated
						colors: true,           // Use colors in the console output
						errors: true,           // Show errors
						errorDetails: true,     // Show details about errors
						warnings: true,         // Show warnings
						timings: true,          // Show timing information
						builtAt: true,          // Show the build timestamp
						hash: true,            // Hide the build hash
						version: true,         // Hide Webpack version info
						modules: true,         // Hide information about built modules
						reasons: true,         // Hide information about module dependencies
						publicPath: true,      // Hide the public path info
						performance: true,     // Hide performance hints
					  }));
					  resolve(stats);
					}
				  });
				});
			  };

			  async function build() {
				try {
				  await webpackPromise(config);
				  console.log("--- Webpack finished -----");
			  
				  // Compile the views now
				//   await new Promise((resolve, reject) => {
				// 	if (!fs.existsSync(viewEJSDir)) {
				// 		resolve(path.normalize(path.resolve(rootDir, "dist")))
				// 	}
				// 	gulp.src([viewEJSDir + '/**/*', "!" + viewEJSDir + '/partials/**'])
				// 	  .pipe(ejs({}).on('error', gutil.log))
				// 	  .pipe(rename({
				// 		extname: ''
				// 	  }))
				// 	  .pipe(gulp.dest(viewDir))
				// 	  .on('end', function () {
				// 		console.log("--- Views compiled -----");
				// 		resolve(path.normalize(path.resolve(rootDir, "dist")));
				// 	  })
				// 	  .on('error', reject);
				//   });
			  
				  console.log("--- All done -----");
					return path.normalize(path.resolve(rootDir, "dist"))
				} catch (error) {
				  console.error("An error occurred:", error);
				}
			  }


			return await build()
			
		} else {
			return path.normalize(path.resolve(rootDir, "static"));
		}
	},
	createMicroserviceApp: function (rootDir, configure, version, opts) {
		// Let's look for all views that need to be added
		let viewDir = path.normalize(path.resolve(rootDir, "views"));
		let logicalResourceId = opts.LogicalResourceId || "ShowPages";
		let showPagesFiles = [];
		let files = glob.sync(path.resolve(rootDir, "views") + "/**/*", {
			nodir: true
		});
		// console.log("Views", files);
		files.forEach(function (file) {
			let f = path.basename(file);
			let p = path.relative(viewDir, path.dirname(file)).replace(/\\/g, '/');
			if (p) {
				p = p + "/";
			} else {
				p = "";
			}
			showPagesFiles.push(p + f);
			if (f.match(/^index/)) {
				showPagesFiles.push(p + "_base");
			}
		});
		let swagger = {
			paths: {}
		};
		showPagesFiles.forEach(function (file) {
			let snippet = {
				"x-amazon-apigateway-any-method": {
					"consumes": ["application/json"],
					"produces": ["text/html"],
					"responses": {
						"200": {
							"description": "200 response",
							"headers": {
								"Content-Type": { "type": "string" }
							}
						}
					},
					"x-amazon-apigateway-integration": {
						"responses": {
							"default": { "statusCode": "200" }
						},
						"uri": {
							"Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${ShowPages.Arn}/invocations`
						},
						"passthroughBehavior": "when_no_match",
						"httpMethod": "POST",
						"contentHandling": "CONVERT_TO_TEXT",
						"type": "aws_proxy"
					}
				}
			};
			if (file.match(/_base$/)) {
				let dir = path.dirname(file);
				if (dir === ".") {
					dir = "";
				}
				swagger.paths['/' + dir] = snippet;
			} else {
				swagger.paths['/' + file] = snippet;
			}
		});
		return {
			LogicalResourceId: logicalResourceId,
			swagger: swagger,
			files: files,
			version: version
		};
	},
	buildMicroserviceApp: async function (rootDir, configure, version, opts) {
	    return new Promise(async (resolve, reject) => {
			let self = this;
			if (opts.cloudFormationOnly) {
				return true
			}
			let staticDir = await this.buildStaticAssets(rootDir, configure, version, {
				cloudfront: opts.cloudfront
			})
			
			// Let's look for all views that need to be added
			let viewDir = path.normalize(path.resolve(rootDir, "views"));
	
			let archive = new archiver('zip', {});
			let logicalResourceId = "ShowPages";
			let basename = `${logicalResourceId}_${version}.zip`;
			let zipFilename = `${opts.dir}/${basename}`;
			let zip = fs.createWriteStream(zipFilename);
			archive.pipe(zip);
			let showPagesFiles = [];
			let files = opts.files;
			files.forEach(function (file) {
				let f = path.basename(file);
				let p = path.relative(viewDir, path.dirname(file)).replace(/\\/g, '/');
				if (p) {
					p = p + "/";
				} else {
					p = "";
				}
				showPagesFiles.push(p + f);
				archive.file(file, {
					name: "pages/" + p + f
				});
				if (f.match(/^index/)) {
					showPagesFiles.push(p + "_base");
					archive.file(file, {
						name: "pages/" + p + "_base"
					});
				}
			});
			console.log("Show Pages Template", showPagesFiles);
			// Are they using leo-config?
			if (fs.existsSync(path.resolve(rootDir, "leo_config.js"))) {
				let builder = require(require.resolve("leo-config", {
					paths: [rootDir]
				}));
				let c = builder.bootstrap(path.resolve(rootDir, "leo_config.js"))._leo_prebuilt_ui;
	
				if (!Object.keys(c).length) {
					c = require(path.resolve(rootDir, "leo_config.js"))._global;
					c = {
						_global: c.ui || {}
					};
				}
	
				for (let env in c) {
					c[env].version = version;
					c[env].staticAssets = c[env].staticAssets.replace(/\/$/, '') + "/" + version + "/";
				}
				showPagesTemplate = showPagesTemplate.replace(/__CONFIG__/, JSON.stringify(c));
			} else {
				showPagesTemplate = showPagesTemplate.replace(/__CONFIG__/, JSON.stringify({}));
			}
			showPagesTemplate = showPagesTemplate.replace(/__PAGES__/, JSON.stringify(showPagesFiles));
	
			archive.append(showPagesTemplate, {
				name: "index.js"
			});
	
			let loadedRequires = {};
			let templateDirPath = path.resolve(__dirname, "../templates/");
			getRegexGroups(showPagesTemplate, /require\(["'`](\.[\/].*?)["'`]\)/g).map(f => {
				f = f[1];
				if (!(f in loadedRequires)) {
					loadedRequires[f] = true;
					archive.file(path.resolve(templateDirPath, f), {
						name: path.normalize(f)
					});
				}
			});
	
			zip.on("close", async function () {
				console.log("done with show pages", opts, staticDir);
				if (opts.publish !== false) {
					await self.publish(staticDir, "s3://" + opts.static.replace(/^s3:\/\//, ""), {
						public: opts.public,
						profile: opts.profile
					});
					resolve(null)
				} else {
					resolve({
						LogicalResourceId: logicalResourceId
					});
				}
			});
			archive.finalize();
		})
	}
};

function getRegexGroups(text, regex, flags) {
	let e = [],
		f = null,
		g = null,
		h = null;
	let a = new RegExp(regex, flags);
	let c = text;
	for (; !f && (g = a.exec(c));) {
		if (a.global && h === a.lastIndex) {
			f = "infinite";
			break;
		}
		if (g.end = (h = g.index + g[0].length) - 1, g.input = null, e.push(g), !a.global)
			break;
	}
	return e;
}

function upload(args, env) {
	return new Promise( (resolve, reject) => {
		let upload = spawn("aws", args, {
			env: Object.assign({}, process.env, env),
			shell: true
		});
		upload.stdout.on('data', (data) => {
			// console.log(data.toString());
		 });
		upload.stderr.on('data', (data) => {
			console.log(data.toString());
		});
		upload.on('close', (code) => {
			if (code === 0) {
				console.timeEnd("Published Files");
				resolve(code);
			} else {
				console.log("Error publishing files", code)
				reject("Error publishing files");
			}
		});
	});
}

async function buildLambdaDirectory(rootDir, opts) {
	let config = buildConfig(rootDir);

	console.log("Run build on", rootDir);
	try {
		execSync("npm install --loglevel=error", {
			cwd: rootDir
		});
		
	} catch (err) {
	  console.error('Command failed:', err.status);    // Error status code
	  console.error('Error message:', err.message);    // Error message
	  console.error('Output:', err.stdout.toString()); // Output before failure
	  console.error('Error output:', err.stderr.toString()); // Error output
	}			
	console.time(`Zipped Lambda Function ${opts.basename}`);
	let archive = archiver('zip');
	let zipFilename = `${opts.dir}/${opts.basename}`;
	let indexFilename = `${config.name}-index-${moment.now()}.js`;
	let zip = fs.createWriteStream(zipFilename);
	archive.pipe(zip);

	let pass;

	let type = config.type;
	if (config.useWrappers) {
		pass = new PassThrough();
		let wrapperFile = __dirname + "/wrappers/" + type + ".js";
		if (!fs.existsSync(wrapperFile)) {
			wrapperFile = __dirname + "/wrappers/base.js";
		}
		let contents = fs.readFileSync(wrapperFile, 'utf-8')
			.replace("____FILE____", path.normalize(path.resolve(rootDir, opts.main || "index.js")).replace(/\\/g, "\\\\"))
			.replace("____PACKAGEJSON____", path.normalize(path.resolve(rootDir, "package.json")).replace(/\\/g, "\\\\"))
			.replace("____HANDLER____", config.handler || "handler");
		pass.write(contents);
		pass.end();
	} else {
		pass = path.resolve(rootDir, opts.main || "index.js");
	}

	let b = browserify({
		standalone: 'lambda',
		bare: true,
		basedir: rootDir,
		entries: [pass],
		browserField: false,
		builtins: false,
		filter: (e) => e !== "async_hooks" && e !== "worker_threads" && e !== "process",
		paths: [path.resolve(__dirname, "../node_modules")],
		commondir: false,
		detectGlobals: true,
        bundleExternal: true,
		insertGlobalVars: {
			process: function () {
				return;
			}
		},
		debug: true
	});

	// b.ignore('fs'); 
	// b.exclude('fs'); 
	// b.ignore('lstat'); 

	const builtins = require('module').builtinModules;
	builtins.forEach((mod) => {
		b.external(mod);                   // Tell Browserify not to bundle Node.js built-ins
		b.external('node:' + mod);
	});

	let babelPresets = [
		["@babel/preset-env", {
			"targets": { "node": 20 },
			"modules": "auto",
			"useBuiltIns": "usage",
			"corejs": {
				"version": "3",
			},
			"debug": false
		}]
	];

	// Added to allow usage of upgraded @babel/preset-env transformers to support later versions of Node while
	// still preserving backwards compatibility of leo-cli's older babel-related packages (6x)
	try {
		babelify = require.resolve("babelify", { paths: [rootDir] });
		babelPresets = []; // Blow away set presets otherwise .babelrc presets will not be used
	} catch (e) {
		// Use the older babelify/transformer
	}

	b.transform(babelify, {
		presets: babelPresets,
		exclude: ["node_modules"],
		parserOpts: { allowReturnOutsideFunction: true },
		global: true,
		compact: false,
		sourceMaps: false,
		plugins: ["@babel/plugin-transform-modules-commonjs", "@babel/plugin-proposal-function-bind",
			["@babel/plugin-transform-runtime",
			{
			  "corejs": false,
			  "helpers": true,  // Enables runtime helper functions
			  "regenerator": true // Enables async/await transformations  
			}
		  ]
		]
	});

	// b.external("aws-sdk");

	let processModuleBuild = function (rootDir, build) {
		if (build && build.include) {
			for (let i = 0; i < build.include.length; i++) {
				let inc = build.include[i];
				let src = inc.src || inc;
				let dest = inc.dest || "node_modules/";

				if (inc.external) {
					b.external(inc.external);
				}

				let origSrc = src;
				let tempRootDir = rootDir;
				src = path.resolve(tempRootDir, src);
				if (!fs.existsSync(src)) {
					let paths = require('module')._nodeModulePaths(tempRootDir);
					let found = false;
					for (let key in paths) {
						src = path.resolve(paths[key], origSrc);
						if (fs.existsSync(src)) {
							tempRootDir = paths[key];
							found = true;
							break;
						}
					}
					if (!found) {
						throw new Error(`Unable to find source file '${origSrc}'`);
					}
				}

				b.external(path.basename(src));
				glob.sync(path.resolve(src, "**")).map(f => b.exclude(f));

				console.log("Adding External", src);
				if (fs.lstatSync(src).isDirectory()) {
					execSync("npm install --only=prod --loglevel=error", {
						cwd: src
					});
				}
				archive.directory(fs.realpathSync(path.normalize(src)), path.join(dest, path.basename(src)));
			}
		}
	};
	if (config.build) {
		processModuleBuild(rootDir, config.build);
	}
	let loadedModules = {};
	b.transform(function (file) {
		// Find any modules that have leo build commands
		let m = file.match(/.*?[/\\]node_modules[/\\](.*?)[/\\]/);
		if (m && !(m[1] in loadedModules)) {
			loadedModules[m[1]] = true;
			let pkgPath = path.resolve(path.dirname(file), "package.json");
			if (fs.existsSync(pkgPath)) {
				let pkgData = require(pkgPath);
				processModuleBuild(path.dirname(file), pkgData && pkgData.config && pkgData.config.leo && pkgData.config.leo.build);
			}
		}

		if (file.match("leoConfigure.js")) {
			return through(function (buf, enc, next) {
				next(null, "");
			}, function (cb) {
				this.push("exports = " + JSON.stringify(config));
				cb();
			});
		} else if (file.match("leo-sdk-config.js")) {
			return through(function (buf, enc, next) {
				next(null, "");
			}, function (cb) {
				let sdkConfigData = {};
				let matches = utils.findParentFiles(process.cwd(), "leo_config.json");
				let sdkConfigPath;
				if (matches.length) {
					sdkConfigPath = matches[0];
				} else {
					sdkConfigPath = path.resolve(`${require('os').homedir()}/.leo`, "config.json");
				}
				if (fs.existsSync(sdkConfigPath) && !config.excludeProfiles) {
					sdkConfigData = JSON.parse(fs.readFileSync(sdkConfigPath) || sdkConfigData);

					if (config.profiles) {
						let tmp = {};
						config.profiles.map((p => {
							tmp[p] = sdkConfigData[p];
							// Can't change AWS profile in lambda so remove the profile key
							if (tmp[p] && tmp[p].profile) {
								delete tmp[p].profile;
							}
						}));
						sdkConfigData = tmp;
						sdkConfigData.default = sdkConfigData.default || sdkConfigData[config.defaultProfile] || sdkConfigData[config.profiles[0]];
					} else {
						Object.keys(sdkConfigData).map(k => delete sdkConfigData[k].profile);
						sdkConfigData.default = sdkConfigData.default || sdkConfigData[Object.keys(sdkConfigData)[0]];
					}
				}
				this.push(`module.exports = ${JSON.stringify(sdkConfigData)};`);
				cb();
			});
		} else if (file.match(/leo-config[/\\]index\.js$/)) {
			return through(function (buf, enc, next) {
				next(null, "");
			}, function (cb) {
				let configPath = path.resolve(config._meta.microserviceDir, './leo_config.js').replace(/\\/g, "/");
				if (fs.existsSync(configPath)) {
					this.push(fs.readFileSync(file) + `
						module.exports.bootstrap(require("${configPath}"));
					`);
				} else {
					this.push(fs.readFileSync(file));
				}
				cb();
			});
		} else {
			// Match any SDKs
			let parts = path.basename(file).match(/(.*?)(?:-(.*?))?-config\.js$/);
			if (parts) {
				return through(function (buff, enc, next) {
					next(null, "");
				}, function (cb) {
					let dirs = [".leo"];
					let filenames = [];
					if (parts[2]) {
						if (parts[1] !== "leo") {
							dirs.unshift(`.${parts[1]}`);
						}
						filenames.push(`${parts[1]}-${parts[2]}.json`);
						filenames.push(`${parts[1]}-${parts[2]}-config.json`);
						filenames.push(`${parts[2]}.json`);
						filenames.push(`${parts[2]}-config.json`);
					} else {
						filenames.push(`${parts[1]}.json`);
						filenames.push(`${parts[1]}-config.json`);
					}

					let sdkConfigData;

					configloop:
						for (let i in dirs) {
							let dir = dirs[i];
							for (let j in filenames) {
								let filename = filenames[j];
								let matches = utils.findParentFiles(process.cwd(), filename);
								let sdkConfigPath;
								if (matches.length) {
									sdkConfigPath = matches[0];
								} else {
									sdkConfigPath = path.resolve(`${require('os').homedir()}/${dir}`, filename);
								}
								if (fs.existsSync(sdkConfigPath) && !config.excludeProfiles) {
									sdkConfigData = JSON.parse(fs.readFileSync(sdkConfigPath) || sdkConfigData);
									if (config.profiles) {
										let tmp = {};
										config.profiles.map((p => {
											tmp[p] = sdkConfigData[p];
											if (tmp[p] && tmp[p].profile) {
												delete tmp[p].profile;
											}
										}));
										sdkConfigData = tmp;
										sdkConfigData.default = sdkConfigData.default || sdkConfigData[config.defaultProfile] || sdkConfigData[config.profiles[0]];
									}
									sdkConfigData.default = sdkConfigData.default || sdkConfigData[Object.keys(sdkConfigData)[0]];
									break configloop;
								}
							}
						}

					if (sdkConfigData) {
						this.push(`export default ${JSON.stringify(sdkConfigData)};`);
					} else {
						// Didn't match a config so just pass through
						this.push(fs.readFileSync(file));
					}
					cb();
				});
			}

			return through();
		}
	}, {
		global: true
	});
	
	// try {	
		let res = await new Promise((resolve, reject) => {
		    // console.log("Starting bundling for:", indexFilename);
		
		    const bundleStream = b.bundle();
		
		    // Pipe the output from Browserify to Gulp and log all stream events
		    const gulpStream = bundleStream
		        .pipe(source(indexFilename))
		        .pipe(buffer())
		        .pipe(gulp.dest(`${opts.dir}/`));
		
		    // Gulp stream error handling
		    gulpStream.on('error', (err) => {
		        // console.error('Gulp piping error:', err);
		        reject(err);
		    });
		    
		    gulpStream.on('finish', () => {
		        // console.log("Gulp finished writing files.");
		        resolve(); // Resolve once Gulp finishes writing
		    });
		    
		    // // Log all stream events for Browserify's bundle process
		    bundleStream.on('error', (err) => {
		        // console.error('Browserify bundling error:', err);
		        reject(err);
		    });
			
		});
		
	    archive.file(`${opts.dir}/${indexFilename}`, { name: 'index.js' });
	
	    if (config.files) {
	      for (let file in config.files) {
	        archive.file(config.files[file], { name: file });
	      }
	    }
	
	    // Step 3: Finalize the archive and wait for zip close event
	    return await new Promise((resolve, reject) => {
	      zip.on('close', async () => {
	        try {
	          // Step 4: Clean up the index file
	          fs.promises.unlink(`${opts.dir}/${indexFilename}`);
	          console.timeEnd(`Zipped Lambda Function ${opts.basename}`);
	
		  	  console.time(`Done Lambda Function ${opts.basename}`);
	          // Resolve with config and zip file path
	          resolve({
	            config: config,
	            path: zipFilename,
	          });
	        } catch (err) {
	          reject(err);
	        }
	      });
	
	      archive.finalize(); // Finalize the archive (starts writing the zip)
		})
	
	// } catch (error) {
	// 	console.error('Error during bundling and archiving:', error);
	// 	throw error; // Re-throw to handle at a higher level if needed
	// } 
	
}

/**
 * Write Cloud Formation file
 * @param rootDir
 * @param opts
 * @param program
 * @param config
 */
async function writeCloudFormation(rootDir, opts, program, config ) {
	console.time("\nCreated cloudformation");
	let cfPath = path.resolve(rootDir, "cloudformation.json");
	let cf = opts.cloudFormation;
	if (!cf && fs.existsSync(cfPath)) {
		cf = require(cfPath);
	}

	if (cf) {
		let now = Date.now();

		cf.Outputs.LeoTemplate = {
			Description: "Leo Template",
			Value: `${opts.s3Folder}/cloudformation-${now}.json`
		};

		// If -s or --save flag, write the cloudformation to our microservice directory
		if (program.saveCloudFormation && config._meta && config._meta.microserviceDir) {
			fs.writeFileSync(`${config._meta.microserviceDir}/cloudformation.json`, JSON.stringify(cf, null, 2));
		}

		fs.writeFileSync(`${opts.buildDir}/cloudformation-${now}.json`, JSON.stringify(cf, null, 2));
		if (opts.variations && Array.isArray(opts.variations) && opts.variations.length) {
			opts.variations.map(v => {
				console.log("----------------- v-----------------", v, `${opts.buildDir}/cloudformation-${now}-${v.name}.json`);
				fs.writeFileSync(`${opts.buildDir}/cloudformation-${now}-${v.name}.json`, JSON.stringify(merge(v.template, cf), null, 2));
			});
		} else {
			fs.writeFileSync(`${opts.buildDir}/cloudformation.json`, JSON.stringify(cf, null, 2));
		}

		console.timeEnd("\nCreated cloudformation");
		return now;
	} else {
		throw new Error ('Unable to create cloudformation.json');
	}
}
