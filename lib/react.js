const { S3Client } = require("@aws-sdk/client-s3");
const { STSClient } = require("@aws-sdk/client-sts");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const path = require("path");
const fs = require("fs");
const moment = require("moment");

const s3 = new S3Client({ region: process.env.AWS_REGION, credentials: fromIni({ profile: process.env.AWS_PROFILE }) });
const sts = new STSClient({ region: process.env.AWS_REGION, credentials: fromIni({ profile: process.env.AWS_PROFILE }) });

const configure = require("leo-sdk/leoConfigure.js");

const buildConfig = require("./build-config").build;
process.env.TZ = buildConfig(process.cwd(), { configOnly: true }).timezone;

const staticNumber = Date.now();

const { glob, globSync } = require("glob");
const webpack = require('webpack');
const webpackMiddleware = require('webpack-dev-middleware');
const webpackHotMiddleware = require('webpack-hot-middleware');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ProgressPlugin = require('progress-webpack-plugin');
const gulp = require("gulp");
const browserify = require('browserify');
const babelify = require('babelify');
const watchify = require('watchify');
const source = require('vinyl-source-stream');
const buffer = require('vinyl-buffer');
const gutil = require('gulp-util');
const rename = require('gulp-rename');
const sourcemaps = require('gulp-sourcemaps');
const ejs = require("gulp-ejs");
const watch = require("node-watch");
const { PassThrough } = require("stream");

process.on('uncaughtException', (err) => {
    console.error((new Date).toUTCString() + ' uncaughtException:', err.message);
    console.error(err.stack);
});
require('source-map-support').install({
    environment: 'node',
    handleUncaughtExceptions: false
});

module.exports = async function (rootDir, config, configure) {
    const viewDir = path.normalize(path.resolve(rootDir, "views"));
    const viewEJSDir = path.normalize(path.resolve(rootDir, "views_ejs"));
    const apiDir = path.normalize(path.resolve(rootDir, "api"));
    const rootDirString = rootDir.replace(/\\/g, "\\\\");
    const cssDir = path.normalize(path.resolve(rootDir, "ui/css/"));
    const imageDir = path.normalize(path.resolve(rootDir, "ui/images/"));
    const fontDir = path.normalize(path.resolve(rootDir, "ui/fonts/"));
    const webpackPoll = config.webpackPoll || null;

    const distDir = path.normalize(path.join(rootDir, `/dist/`));
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir);
    }
    const testConfig = require("../leoCliConfigure.js")(process.env.NODE_ENV);
    configure.test = Object.assign({
        port: 80
    }, testConfig.test || {}, configure.test || {});
    const configFile = path.normalize(path.resolve(distDir, "leoConfigure.js"));
    configure.ui.type = "ui";

    const basePath = configure.test.basePath || "module";

    // Watch and Compile Views
    const compileViews = () => {
        console.log("compiling views");
        return gulp.src([`${viewEJSDir}/**/*`, `!${viewEJSDir}/partials/**`])
            .pipe(ejs({}).on('error', gutil.log))
            .pipe(rename({ extname: '' }))
            .pipe(gulp.dest('./views'));
    };

    gulp.watch([`${viewEJSDir}/**/*`], gulp.task('views', compileViews));
    if (fs.existsSync(viewEJSDir)) {
        compileViews();
    }

    const express = require('express');
    const bodyParser = require('body-parser');

    const app = express();
    app.use(bodyParser.urlencoded({
        extended: false,
        limit: '10mb'
    }));
    app.use(bodyParser.json({
        limit: '10mb'
    }));

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE');
        next();
    });

    app.get("/", (req, res) => {
        res.redirect(`/${basePath}/`);
    });

    const files = await glob(`${rootDir}/ui/js/*.js`, { nodir: true });

    if (files.length > 0) {
        const entries = {};
        files.forEach((file) => {
            entries[path.basename(file, ".js")] = [
                file,
                'webpack-hot-middleware/client?reload=false'
            ];
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

        console.log("[entries]", entries)
        
        const webpackConfig = [{
            devtool: 'eval-source-map',
            entry: entries,
            mode: "production",
            watch: false,
            output: {
                path: path.join(rootDir, `/dist/`),
                filename: 'js/[name].js',
                publicPath: `/${basePath}/static/${staticNumber}/`
            },
            node: {},
            stats: { preset: 'none', logging: 'error' },
            resolve: {
                modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
            },
            resolveLoader: {
                modules: ['node_modules', path.resolve(__dirname, "../node_modules")]
            },
            plugins: [
                new webpack.NormalModuleReplacementPlugin(/leoConfigure\.js/, configFile),
                staticDirCopyPlugin,
                new webpack.HotModuleReplacementPlugin(),
                new BundleAnalyzerPlugin(),
                new CircularDependencyPlugin({
                  exclude: /a\.js|node_modules/,
                  failOnError: true
                }),                
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
            ].filter(p => !!p),
            module: {
                rules: [{
                    test: /\.jsx?$/,
                    exclude: /(node_modules|bower_components)/,
                    use: {
                        loader: 'babel-loader',
                        options: {
                            babelrc: true,
                            cacheDirectory: false,
                        }
                    }
                }, {
                    test: /\.(less|css)$/,
                    exclude: /(node_modules|bower_components)/,
                    use: ["style-loader", "css-loader", "less-loader"]
                }, {
                    test: /\.(|scss)$/,
                    exclude: /(node_modules|bower_components)/,
                    use: ["style-loader", "css-loader", "sass-loader"]
                }, {
                    test: /\.(jpg|jpeg|gif|png)$/,
                    exclude: /(node_modules|bower_components)/,
                    use: {
                        loader: 'url-loader',
                        options: {
                            limit: 2000,
                            name: 'images/[name].[ext]'
                        }
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
                        loader: "url-loader",
                        options: {
                            limit: 10000,
                            mimetype: "application/font-woff",
                            name: 'images/[name].[ext]'
                        }
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

        const compiler = webpack(webpackConfig);
        const middleware = webpackMiddleware(compiler, {
            publicPath: webpackConfig[0].output.publicPath,
            stats: {
                colors: true,
                hash: true,
                timings: true,
                chunks: true,
                chunkModules: true,
                modules: true
            }
        });

        app.use(middleware);
        app.use(webpackHotMiddleware(compiler));
    }

    const wrap = require("./functionWrap")({
        path: `${rootDirString}/api`
    });

    let uiConfig = {}
    if (fs.existsSync(path.resolve(rootDir, "leo_config.js"))) {
        console.log("Got leo-config.js")
        const builder = require(require.resolve("leo-config", {
            paths: [rootDir]
        }));
        let c = builder.bootstrap(path.resolve(rootDir, "leo_config.js"))._leo_prebuilt_ui;
        if (!Object.keys(c).length) {
            c = require(path.resolve(rootDir, "leo_config.js"))._global;
            c = {
                _global: c.ui || {}
            };
        }
        uiConfig = c;
    } else {
        uiConfig = {};
    }
    const resources = process.env.Resources && JSON.parse(process.env.Resources) || {};
    if (resources.CustomFavicon == '') {
        delete resources.CustomFavicon;
    }
    configure.ui = (uiConfig[process.env.NODE_ENV] || uiConfig._global || {});
    configure.ui.version = staticNumber;
    configure.ui.staticAssets = "static/" + staticNumber + "/";
    configure.ui.uri = configure.ui.staticAssets;
    configure.ui.static = {
        uri: configure.ui.staticAssets
    };
    Object.assign(configure.ui, resources);
    configure.ui.basehref = "/" + basePath + "/";
    console.log("[configure.ui]", uiConfig, resources, configure.ui)
    fs.writeFileSync(configFile, "module.exports = " + JSON.stringify(configure.ui));

    const variables = {};
    flattenVariables(configure.ui, variables, '.', "leo.");

    const viewFiles = await glob(`${viewDir}/**`, { nodir: true });
    viewFiles.forEach((file) => {
        const original = file;
        let p = path.relative(viewDir, path.dirname(file)).replace(/\\/g, '/');
        if (p) {
            p = "/" + p;
        }
        const fileName = path.basename(file);

        if (fileName === "index.html" || fileName === "index") {
            console.log("get", `/${basePath}${p}`, `views${p}/${fileName}`);
            app.all(`/${basePath}${p}`, async (req, res) => {
                var login = require("../templates/login.js")(process.env.Logins);
                if (login.length()) {
                    configure.ui.logins = {
                        Region: resources.Region,
                        IdentityPoolId: resources.CognitoId,
                        Logins: login.get(req)
                    }
                }
                fs.readFile(`${original}`, 'utf8', (err, data) => {
                    console.log("----- here1 -----", err, data)
                    data = doReplacements(data, variables, configure.ui);
                    const replacements = {};
                    if (process.env.CustomFavicon) {
                        replacements[`<link rel="icon" href="//cdnleo.s3.amazonaws.com/logos/leo_icon.png" type="image/png" />`] = `<link rel="icon" href="${process.env.CustomFavicon}" type="image/png" />`;
                        replacements[`<link rel="shortcut icon" href="//cdnleo.s3.amazonaws.com/logos/leo_icon.png" type="image/png" />`] = `<link rel="shortcut icon" href="${process.env.CustomFavicon}" type="image/png" />`;
                    }

                    for (const key in replacements) {
                        const regex = new RegExp(key, "g");
                        data = data.replace(regex, replacements[key]);
                    }
                    res.send(data);
                });
            });
        }
        console.log("get", `/${basePath}${p}/${fileName}`, `views${p}/${fileName}`);
        app.all(`/${basePath}${p}/${fileName}`, async (req, res) => {
            var login = require("../templates/login.js")(process.env.Logins);
            if (login.length()) {
                configure.ui.logins = {
                    Region: resources.Region,
                    IdentityPoolId: resources.CognitoId,
                    Logins: login.get(req)
                }
            }
            fs.readFile(`${original}`, 'utf8', (err, data) => {

                data = doReplacements(data, variables, configure.ui);
                const replacements = {};
                if (process.env.CustomFavicon) {
                    replacements[`<link rel="icon" href="//cdnleo.s3.amazonaws.com/logos/leo_icon.png" type="image/png" />`] = `<link rel="icon" href="${process.env.CustomFavicon}" type="image/png" />`;
                    replacements[`<link rel="shortcut icon" href="//cdnleo.s3.amazonaws.com/logos/leo_icon.png" type="image/png" />`] = `<link rel="shortcut icon" href="${process.env.CustomFavicon}" type="image/png" />`;
                }

                for (const key in replacements) {
                    const regex = new RegExp(key, "g");
                    data = data.replace(regex, replacements[key]);
                }
                res.send(data);
            });
        });
    });

    const origRootDir = rootDir;
    const apiFiles = await glob(path.resolve(rootDir, "api") + "/**/package.json");
    apiFiles.forEach((file) => {
        const indexFile = path.dirname(file) + "/index.js";
        if (!fs.existsSync(indexFile) || indexFile.match(/api\/.*node_modules/)) return;
        const buildFile = path.normalize(path.dirname(file) + "/.leobuild.js");
        const opts = webpackPoll ? {
            poll: true,
            ignoreWatch: ['**/node_modules/**'],
            delay: 100
        } : {};
        const rootDir = path.dirname(file);
        const config = buildConfig(rootDir);
        let pass;
        const type = config.type;

        if (config.useWrappers) {
            pass = new PassThrough();
            let wrapperFile = __dirname + "/wrappers/" + type + ".js";
            if (!fs.existsSync(wrapperFile)) {
                wrapperFile = __dirname + "/wrappers/base.js";
            }
            const contents = fs.readFileSync(wrapperFile, 'utf-8')
                .replace("____FILE____", path.normalize(path.resolve(rootDir, opts.main || "index.js")).replace(/\\/g, "\\\\"))
                .replace("____PACKAGEJSON____", path.normalize(path.resolve(rootDir, "package.json")).replace(/\\/g, "\\\\"))
                .replace("____HANDLER____", config.handler || "handler");
            pass.write(contents);
            pass.end();
        } else {
            pass = path.resolve(rootDir, opts.main || "index.js");
        }

        const b = watchify(browserify({
            standalone: 'lambda',
            bare: true,
            basedir: path.dirname(indexFile),
            entries: [pass],
            browserField: false,
            builtins: false,
            paths: [path.resolve(__dirname, "../node_modules")],
            commondir: false,
            detectGlobals: true,
            bundleExternal: false,
            insertGlobalVars: {
                process: function () {
                    return;
                }
            },
            cache: {},
            packageCache: {},
            debug: true
        }), opts);

        const babelPresets = [
            [
              "@babel/preset-react",
              {
                "pragma": "dom", // default pragma is React.createElement (only in classic runtime)
                "pragmaFrag": "DomFrag", // default is React.Fragment (only in classic runtime)
                "throwIfNamespace": false, // defaults to true
                // "runtime": "automatic" // defaults to classic
                // "importSource": "custom-jsx-library" // defaults to react (only in automatic runtime)
              }
            ],             
            ["@babel/env", {
                "targets": "node 20",
                "modules": false,
                "useBuiltIns": "usage",
                "corejs": "3.6.5"
            }]
        ];

        b.transform(babelify, {
            presets: babelPresets,
            sourceMaps: true,
            plugins: [
        	  "@babel/plugin-proposal-export-namespace-from", 
        	  "@babel/plugin-transform-modules-commonjs", 
        	  "@babel/plugin-proposal-function-bind", 
        	  ["@babel/plugin-proposal-decorators", { "legacy": true }],
        	  "@babel/plugin-proposal-class-properties",
        	  "@babel/plugin-transform-runtime",
            ]
        });

        // b.external("aws-sdk");

        function bundle() {
            console.log("Bundling file", indexFile);
            console.time(`Done building file ${indexFile}`);

            b.bundle()
                .on('error', (err) => {
                    console.log(err);
                })
                .pipe(source('.leobuild.js')).pipe(buffer())
                .pipe(sourcemaps.init({
                    loadMaps: true
                }))
                .pipe(sourcemaps.write())
                .pipe(require("vinyl-fs").dest(path.dirname(indexFile)))
                .on("end", () => {
                    console.timeEnd(`Done building file ${indexFile}`);
                    if (buildFile in require.cache) {
                        delete require.cache[buildFile];
                    }
                    for (const n in require.cache) {
                        if (!n.match(/leo-cli/) || n.match(/leoCliConfigure/)) {
                            delete require.cache[n];
                        }
                    }
                });
        }
        b.on("update", bundle);
        watch([path.resolve(origRootDir, "leo_cli_config.js")], {
            recursive: true,
            filter: f => !/node_modules/.test(f)
        }, (eventType, filename) => {
            bundle();
        });
        bundle();

        const apiConfig = buildConfig(path.dirname(file));
        let p = path.relative(apiDir, path.dirname(file)).replace(/\\/g, '/');
        if (p) {
            p = "/" + p;
        }
        if ((apiConfig.type === "resource" || apiConfig.type === "apigateway")) {
            if (apiConfig.type === "apigateway") {
                console.log(`The config type apigateway is deprecated. Please replace with resource before you deploy`);
            }
            if (!Array.isArray(apiConfig.uri)) {
                apiConfig.uri = [apiConfig.uri];
            }
            for (let i = 0; i < apiConfig.uri.length; i++) {
                const parts = apiConfig.uri[i].split(/:/);
                let method = parts[0].toLowerCase();

                if (method == "any") {
                    method = "all";
                }
                let matches;
                let lastPath;
                if (matches = parts[1].match(/\{([^\{]+)\+\}/g)) {
                    lastPath = matches.pop().replace(/\{([^\{]+)\+\}/g, '$1');
                    parts[1] = parts[1].replace(/\{([^\{]+)\+\}/g, '*?');
                }
                const uri = parts[1].replace(/\{([^\{]+)\}/g, ':$1');
                console.log(method.toUpperCase(), uri, indexFile);
                app[method](`/${basePath}${uri}`, wrap.express(buildFile, {
                    role: apiConfig.role || (configure.aws && configure.aws.role),
                    lastPath: lastPath
                }));
            }
        }
    });

    const st = express.static(path.normalize(path.resolve(rootDir, "dist/")), {
        maxAge: 31557600000
    });
    app.get(`/${basePath}/static/:version/:file(*)`, (req, res, next) => {
        res.header('Cache-Control', "max-age=315360000");
        res.header('Expires', "Tue, 11 May 2021 03:31:51 GMT");
        req.url = req.url.replace(new RegExp(`/${basePath}/static/[^/]*/`, "g"), '/');
        st(req, res, next);
    });
    app.listen(configure.test.port, () => {
        console.log(`Running microservice(${configure.name}) on port ${configure.test.port} with version number ${staticNumber}`);
    });
};

function flattenVariables(obj, out, separator, prefix) {
    prefix = prefix || "";
    separator = separator || ":";
    Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (typeof v === "object" && !(Array.isArray(v)) && v !== null) {
            flattenVariables(v, out, separator, prefix + k.toLowerCase() + separator);
        } else {
            out[prefix + k.toLowerCase()] = v;
        }
    });
}

function doReplacements(data, variables, configure) {
    return data.replace(/\$\{(leo[^{}]*?)\}/g, (match, variable) => {
        variable = variable.toLowerCase();
        if (variable == "leo") {
            return JSON.stringify(configure);
        } else {
            return variables[variable];
        }
    });
}
