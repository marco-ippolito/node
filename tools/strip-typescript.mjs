#!/usr/bin/env node


import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { transformSync } from '../deps/amaro/dist/index.js';

/**
 * Recursively find all TypeScript files in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} fileList - Accumulated file list
 * @returns {string[]} List of TypeScript file paths
 */
function findTypescriptFiles(dir, fileList = []) {
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);

    if (statSync(filePath).isDirectory()) {
      // Skip node_modules and hidden directories
      if (file === 'node_modules' || file.startsWith('.')) {
        continue;
      }
      findTypescriptFiles(filePath, fileList);
    } else if (extname(file) === '.ts') {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Strip TypeScript types from a file and write the JavaScript equivalent
 * @param {string} tsFilePath - Path to TypeScript file
 * @returns {string} Path to generated JavaScript file
 */
function stripTypescriptFile(tsFilePath) {
  try {
    const content = readFileSync(tsFilePath, 'utf8');

    const { code: stripped } = transformSync(content, {
      mode: 'strip-only',
    });

    let jsFilePath = tsFilePath;
    if (tsFilePath.endsWith('.ts')) {
      jsFilePath = tsFilePath.replace(/\.ts$/, '.js');
    }

    writeFileSync(jsFilePath, stripped, 'utf8');

    return jsFilePath;
  } catch (error) {
    console.error(`Error stripping ${tsFilePath}:`, error.message);
    throw error;
  }
}

/**
 * Main function to strip all TypeScript files in specified directories
 * @param {string[]} dirs - Directories to process
 */
function main(dirs) {
  if (dirs.length === 0) {
    console.error('Usage: strip-typescript.mjs <directory> [<directory> ...]');
    process.exit(1);
  }

  for (const dir of dirs) {
    const tsFiles = findTypescriptFiles(dir);

    for (const tsFile of tsFiles) {
      stripTypescriptFile(tsFile);
    }
  }
}

const args = process.argv.slice(2);
main(args);
