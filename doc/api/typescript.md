# Modules: TypeScript

<!--lint disable prohibited-strings-->

<!-- YAML
added: REPLACEME
-->

> Stability: 1.0 - Early development

The flag [`--experimental-strip-types`][] enables Node.js to run TypeScript
files that contain only type annotations. Such files contain no TypeScript
features that require transformation, such as enums or namespaces. Node.js will
replace inline type annotations with whitespace, and no type checking is
performed. TypeScript features that depend on settings within `tsconfig.json`,
such as paths or converting newer JavaScript syntax to older standards, are
intentionally unsupported.

To get fuller TypeScript support, including support for enums and namespaces
and paths, see <https://nodejs.org/en/learn/getting-started/nodejs-with-typescript>.
The built-in TypeScript support is designed to be lightweight and as fast as
possible. By intentionally not supporting syntaxes that require JavaScript code
generation, and by replacing stripped types with whitespace, Node.js can run
TypeScript code without the need for source maps and with less overhead.

### Determining module system

Node.js supports both [CommonJS][] and [ES Modules][] syntax in TypeScript
files. Node.js will not convert from one module system to another; if you want
your code to run as an ES module, you must use `import` and `export` syntax,
and if you want your code to run as CommonJS you must use `require` and
`module.exports`.

* `.ts` files will have their module system determined
  [the same way as `.js` files.][] To use `import` and `export` syntax, add
  `"type": "module"` to the nearest parent `package.json`.
* `.mts` files will always be run as ES modules, similar to `.mjs` files.
* `.cts` files will always be run as CommonJS modules, similar to `.cjs` files.
* `.tsx` files are unsupported.

As in JavaScript files, [file extensions are mandatory][] in `import` statements
and `import()` expressions: `import './file.ts'`, not `import './file'`.
Because of backward compatibility, file extensions are also mandatory in
`require()` calls: `require('./file.ts')`, not `require('./file')`, similar to
how the `.cjs` extension is mandatory in `require` calls in CommonJS files.

The `tsconfig.json` option `allowImportingTsExtensions` will allow the
TypeScript compiler `tsc` to type-check files with `import` specifiers that
include the `.ts` extension.

### Unsupported TypeScript features

Since Node.js is only removing inline types, any TypeScript features that
involve _replacing_ TypeScript syntax with new JavaScript syntax will error.
This is by design. To run TypeScript with such features, see
<https://nodejs.org/en/learn/getting-started/nodejs-with-typescript#running-typescript-code-in-nodejs>

The most prominent unsupported features that require transformation are:

* `Enum`
* `experimentalDecorators`
* `namespaces`
* parameter properties

In addition, Node.js does not read `tsconfig.json` files and does not support
features that depend on settings within `tsconfig.json`, such as paths or
converting newer JavaScript syntax into older standards.

### Importing types without `type` keyword

Due to the nature of type stripping, the `type` keyword is necessary to
correctly strip type imports.
Without the `type` keyword, Node.js will treat the import as a value import,
which will result in a runtime error.
The tsconfig option [`verbatimModuleSyntax`][] can be used to match this behavior.

This example will work correctly:

```ts
import type { Type1, Type2 } from './module.ts';
import { fn, type FnParams } from './fn.ts';
```

This will result in a runtime error:

```ts
import { Type1, Type2 } from './module.ts';
import { fn, FnParams } from './fn.ts';
```

### Type stripping in `node_modules` directories

To avoid encouraging package authors to publish TypeScript only modules,
Node.js will by default refuse to handle TypeScript files inside `node_modules` directories.
When attempting to resolve a `.ts`, `.cts`, or `.mts` file that is a children of a
`node_modules` directory, `defaultResolve` will throw
a [`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`][] error.

### Non-file forms of input

Type stripping can be enabled for `--eval` and STDIN input. The module system
will be determined by `--input-type`, as it is for JavaScript.

TypeScript syntax is unsupported in the REPL, `--print`, `--check`, and
`inspect`.

### Source maps

Since inline types are replaced by whitespace, source maps are unnecessary for
correct line numbers in stack traces; and Node.js does not generate them. For
source maps support, see
<https://nodejs.org/en/learn/getting-started/nodejs-with-typescript#running-typescript-code-in-nodejs>

<!--lint enable prohibited-strings-->

[CommonJS]: modules.md
[ES Modules]: esm.md
[`--experimental-strip-types`]: cli.md#--experimental-strip-types
[`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`]: errors.md#err_unsupported_node_modules_type_stripping
[`verbatimModuleSyntax`]: https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax
[file extensions are mandatory]: esm.md#mandatory-file-extensions
[the same way as `.js` files.]: packages.md#determining-module-system
