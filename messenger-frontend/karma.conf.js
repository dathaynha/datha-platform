const path = require("path");

const junitOutputDir =
  process.env.JUNIT_OUTPUT_DIR ||
  path.join(__dirname, "./coverage/messenger-frontend");
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
      dir: require("path").join(__dirname, "./coverage/messenger-frontend"),
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
    /*
     * A wide window, because layout is testable and some of it only exists
     * above a breakpoint. The call dock moves the people into a single column
     * beside a presentation at `min-width: 60rem`, and the bug that put the
     * third person's tile at half width lived only there — at the default
     * 800x600 the rule never applies and the test cannot fail (2026-09-16).
     *
     * CI must ask for this launcher by name. `platform-pipelines`' Angular
     * template defaults to `--browsers=ChromeHeadless`, so this repo overrides
     * its `testCommand` parameter — without that the flag is applied locally
     * and silently ignored in CI, which is how five layout specs passed here
     * and failed there on the same commit. The name cannot simply shadow
     * `ChromeHeadless`: a launcher whose base is itself recurses.
     */
    customLaunchers: {
      ChromeHeadlessWide: {
        base: "ChromeHeadless",
        flags: ["--window-size=1400,900"],
      },
    },
    browsers: ["ChromeHeadlessWide"],
    singleRun: false,
    restartOnFileChange: true,
  });
};
