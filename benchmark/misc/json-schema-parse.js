'use strict';

const common = require('../common');

// Large package.json-like object for realistic benchmarking
const largePackageJson = {
  name: 'example-package',
  version: '1.2.3',
  description: 'A comprehensive example package with many dependencies and complex configuration',
  main: 'index.js',
  type: 'module',
  scripts: {
    start: 'node index.js',
    test: 'jest --coverage',
    lint: 'eslint src/',
    build: 'webpack --mode production',
    dev: 'webpack-dev-server --mode development',
    'test:watch': 'jest --watch',
    'lint:fix': 'eslint src/ --fix',
    prepublishOnly: 'npm run test && npm run build',
    postinstall: 'node scripts/postinstall.js',
    clean: 'rimraf dist/',
    docs: 'jsdoc -d docs/ src/'
  },
  dependencies: {
    axios: '^1.4.0',
    lodash: '^4.17.21',
    moment: '^2.29.4',
    react: '^18.2.0',
    'react-dom': '^18.2.0',
    'react-router-dom': '^6.8.1',
    redux: '^4.2.1',
    'redux-thunk': '^2.4.2',
    express: '^4.18.2',
    cors: '^2.8.5',
    helmet: '^6.0.1',
    jsonwebtoken: '^9.0.0',
    bcryptjs: '^2.4.3',
    mongoose: '^7.0.3',
    dotenv: '^16.0.3',
    winston: '^3.8.2',
    'socket.io': '^4.6.1',
    multer: '^1.4.5',
    'node-cron': '^3.0.2',
    nodemailer: '^6.9.1'
  },
  devDependencies: {
    '@babel/core': '^7.21.0',
    '@babel/preset-env': '^7.20.2',
    '@babel/preset-react': '^7.18.6',
    '@testing-library/jest-dom': '^5.16.5',
    '@testing-library/react': '^14.0.0',
    '@testing-library/user-event': '^14.4.3',
    '@types/node': '^18.15.0',
    '@typescript-eslint/eslint-plugin': '^5.54.0',
    '@typescript-eslint/parser': '^5.54.0',
    'babel-loader': '^9.1.2',
    'css-loader': '^6.7.3',
    eslint: '^8.35.0',
    'eslint-plugin-react': '^7.32.2',
    'eslint-plugin-react-hooks': '^4.6.0',
    'html-webpack-plugin': '^5.5.0',
    jest: '^29.4.3',
    'mini-css-extract-plugin': '^2.7.2',
    nodemon: '^2.0.20',
    prettier: '^2.8.4',
    'sass-loader': '^13.2.0',
    'style-loader': '^3.3.2',
    typescript: '^4.9.5',
    webpack: '^5.75.0',
    'webpack-cli': '^5.0.1',
    'webpack-dev-server': '^4.8.1'
  },
  repository: {
    type: 'git',
    url: 'https://github.com/example/example-package.git'
  },
  keywords: ['javascript', 'nodejs', 'react', 'express', 'mongodb', 'api', 'frontend', 'backend'],
  author: {
    name: 'John Doe',
    email: 'john@example.com',
    url: 'https://johndoe.dev'
  },
  license: 'MIT',
  bugs: {
    url: 'https://github.com/example/example-package/issues'
  },
  homepage: 'https://github.com/example/example-package#readme'
};

// Simple benchmark: JSON.parse vs JSONSchemaParser for property extraction
const configs = {
  n: [5000, 10000],
  method: ['json-parse', 'json-schema-parse']
};

const bench = common.createBenchmark(main, configs);

function main(config) {
  const packageJsonString = JSON.stringify(largePackageJson);
  const n = config.n;
  
  // Schema that defines only the properties we want to extract
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      type: { type: 'string' }
    },
    required: ['name', 'version']
  };

  if (config.method === 'json-parse') {
    // Method 1: JSON.parse entire object + extract properties + assert
    bench.start();
    for (let i = 0; i < n; i++) {
      const parsed = JSON.parse(packageJsonString);
      const { name, version, type } = parsed;
      
      // Assert that we got the expected values
      if (name !== 'example-package' || version !== '1.2.3' || type !== 'module') {
        throw new Error('Property extraction failed');
      }
    }
    bench.end(n);
    
  } else if (config.method === 'json-schema-parse') {
    // Method 2: JSONSchemaParser + extract properties + assert
    const { JSONSchemaParser } = require('util');
    const parser = new JSONSchemaParser(schema);
    
    bench.start();
    for (let i = 0; i < n; i++) {
      const parsed = parser.parse(packageJsonString, { skipValidation: true });
      const { name, version, type } = parsed;
      
      // Assert that we got the expected values
      if (name !== 'example-package' || version !== '1.2.3' || type !== 'module') {
        throw new Error('Property extraction failed');
      }
    }
    bench.end(n);
  }
}
