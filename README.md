# commander

`@macle-community/commander` is a lightweight Node.js command-line option parser. It
supports short and long options, positional arguments, defaults, and custom
argument parsers.

## Installation

```sh
npm install @macle-community/commander
```

## Usage

```js
const { Command } = require('@macle-community/commander');

const program = new Command();

program
  .name('greet')
  .description('Print a greeting')
  .option('-u, --uppercase', 'uppercase the greeting')
  .requiredOption('-n, --name <name>', 'name to greet')
  .parse(process.argv);

const options = program.opts();
const greeting = `Hello, ${options.name}!`;

console.log(options.uppercase ? greeting.toUpperCase() : greeting);
```

Options are declared with `option()` or `requiredOption()`. Use angle brackets
for a required option value (`--name <name>`) and square brackets for an
optional value (`--color [color]`). Boolean options take no value. Short and
long flags can be declared together, for example `-n, --name <name>`.

After parsing, `opts()` returns the option values and `args` contains the
positional arguments. Options can also be configured directly with
`createOption()` and `addOption()`. `Option` supports defaults with
`default()`, custom value parsing with `argParser()`, and mandatory values
with `makeOptionMandatory()`.

## API

- The package's default export is a `Command` instance, also available as
  `program`.
- `Command` and `Option` are available as named properties on the package
  export.
- `CommanderError` is exported for compatibility with the command-line
  parsing API.
- `parse(argv, { from })` accepts Node.js arguments by default. Set `from` to
  `'user'` to parse an array containing only user arguments, or to `'electron'`
  for Electron argument handling.

## License

MIT. See [LICENSE](./LICENSE).
