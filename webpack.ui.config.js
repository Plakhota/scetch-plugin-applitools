// Bundles src/ui.ts + src/ui.html into a single self-contained resources/ui.html
// (Eyes SDK inlined, with the same Node-builtin browser polyfills the Figma
// plugin's webpack config needed — see reference-archive/webpack.config.babel.js).
// skpm-build then copies resources/**/* into the .sketchplugin's Contents/Resources/
// per the "skpm.assets" glob in package.json, and export-designs.js loads it
// via a plain file:// path built from __dirname at runtime.
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const InlineChunkHtmlPlugin = require('inline-chunk-html-plugin');
const webpack = require('webpack');

module.exports = (env, argv) => ({
  context: __dirname,
  mode: 'development',
  devtool: false,

  entry: {
    ui: './src/ui.ts',
  },
  output: {
    filename: '[name].js',
    path: path.join(__dirname, 'resources'),
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        loader: 'babel-loader',
        exclude: {
          and: [/node_modules/],
          not: [],
        },
      },
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules.*/,
      },
    ],
  },
  resolve: {
    modules: ['node_modules'],
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    fallback: {
      module: false,
      child_process: false,
      vm: require.resolve('vm-browserify'),
      fs: require.resolve('./src/builtins/fs.js'),
      url: require.resolve('./src/builtins/url.js'),
      assert: require.resolve('assert/'),
      util: require.resolve('util/'),
      crypto: require.resolve('crypto-browserify'),
      os: require.resolve('os-browserify/browser'),
      path: require.resolve('path-browserify'),
      stream: require.resolve('stream-browserify'),
      zlib: require.resolve('browserify-zlib'),
      http: require.resolve('stream-http'),
      https: require.resolve('https-browserify'),
      timers: require.resolve('timers-browserify'),
    },
  },

  plugins: [
    new HtmlWebpackPlugin({
      inject: 'body',
      template: './src/ui.html',
      filename: 'ui.html',
      chunks: ['ui'],
    }),
    new InlineChunkHtmlPlugin(HtmlWebpackPlugin, [/ui/]),
    // Eyes SDK's internal loggers read process.env.APPLITOOLS_SHOW_LOGS at
    // construction time (see eyes-sdk-core/lib/sdk/EyesCore.js) to decide
    // between a silent DebugLogHandler and a verbose ConsoleLogHandler. Since
    // this bundle's `process.env` is a build-time polyfill, not a real shell
    // environment, the flag has to be baked in here rather than set as an
    // actual env var when running Sketch.
    new webpack.DefinePlugin({
      'process.env.APPLITOOLS_SHOW_LOGS': JSON.stringify('true'),
    }),
    new webpack.ProvidePlugin({
      Buffer: [require.resolve('buffer'), 'Buffer'],
      process: [require.resolve('process/browser')],
      'process.hrtime': [require.resolve('./src/builtins/browser-process-hrtime.js')],
    }),
  ],
});
