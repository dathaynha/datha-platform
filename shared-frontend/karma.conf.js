const path = require("path");

const junitOutputDir =
  process.env.JUNIT_OUTPUT_DIR ||
  path.join(__dirname, "./coverage/shared-frontend");
const useJUnit = Boolean(process.env.JUNIT_OUTPUT_DIR);

const plugins = [
  require("karma-jasmine"),
  require("karma-chrome-launcher"),
  require("karma-jasmine-html-reporter"),
  require("karma-coverage"),
  require("@angular-devkit/build-angular/plugins/karma"),
];
if (useJUnit) {
  plugins.push(require("karma-junit-reporter"));
}

module.exports = function (config) {
  config.set({
    basePath: "",
    frameworks: ["jasmine", "@angular-devkit/build-angular"],
    plugins,
    client: {
      jasmine: {},
      clearContext: false,
    },
    jasmineHtmlReporter: {
      suppressAll: true,
    },
    coverageReporter: {
      dir: require("path").join(__dirname, "./coverage/shared-frontend"),
      subdir: ".",
      reporters: [{ type: "html" }, { type: "text-summary" }],
    },
    reporters: useJUnit ? ["progress", "junit"] : ["progress", "kjhtml"],
    junitReporter: {
      outputDir: junitOutputDir,
      outputFile: "junit.xml",
      useBrowserName: false,
    },
    port: 9876,
    colors: true,
    logLevel: config.LOG_INFO,
    autoWatch: true,
    browsers: ["ChromeHeadless"],
    singleRun: false,
    restartOnFileChange: true,
  });
};

