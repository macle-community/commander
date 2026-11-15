const { EventEmitter } = require('events');
const path = require('path');

class Option {
  constructor(flags, description) {
    this.description = description || '';
    this.flags = flags;
    this.required = flags.includes('<');
    this.optional = flags.includes('[');
    this.mandatory = false;
    this.variadic = /\w\.\.\.[>\]]$/.test(flags);
    const optionFlags = parseOptionFlags(flags);
    this.long = optionFlags.longOptionFlag;
    this.short = optionFlags.shortOptionFlag;
    this.negate = false;
    this.parseArg = undefined;
    this.defaultValue = undefined;
    this.defaultValueDescription = undefined;
    if (this.long) {
      this.negate = this.long.startsWith('--no-');
    }
  }

  default(defaultValue, defaultValueDescription) {
    this.defaultValue = defaultValue;
    this.defaultValueDescription = defaultValueDescription;
    return this;
  }

  argParser(parser) {
    this.parseArg = parser;
    return this;
  }

  makeOptionMandatory(optionMandatory = true) {
    this.mandatory = !!optionMandatory;
    return this;
  }

  attributeName() {
    return camelcase(this.name().replace(/^no-/, ''));
  }

  name() {
    const { long } = this;
    if (long) {
      return long.replace(/^--/, '');
    }
    const { short } = this;
    return short.replace(/^-/, '');
  }

  is(argument) {
    const { long } = this;
    const { short } = this;
    return long === argument || short === argument;
  }
}

class CommanderError extends Error {
  constructor(exitCode, code, message) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.exitCode = exitCode;
    this.code = code;
    this.name = this.constructor.name;
  }
}

class Command extends EventEmitter {
  constructor(name) {
    super();
    this.options = [];
    this.commands = [];
    this._args = [];
    this.parent = null;
    this._scriptPath = null;
    this.rawArgs = null;
    this._optionValues = {};
    this._name = name || '';
    this._combineFlagAndOptionalValue = true;
    this._storeOptionsAsProperties = false;
    this._argsDescription = undefined;
    this._description = '';
    this._outputConfiguration = {
      writeErr: str => process.stderr.write(str),
      writeOut: str => process.stdout.write(str),
      getErrHelpWidth: () => (process.stderr.isTTY ? process.stderr.columns : undefined),
      getOutHelpWidth: () => (process.stdout.isTTY ? process.stdout.columns : undefined),
      outputError: (str, write) => write(str)
    };
    this._helpCommandName = 'help';
    this._addImplicitHelpCommand = undefined;
    this._hasHelpOption = true;
  }

  createOption(flags, description) {
    return new Option(flags, description);
  }

  addOption(newOption) {
    const name = newOption.attributeName();
    let { defaultValue } = newOption;
    if (newOption.negate) {
      const positiveLongFlag = newOption.long.replace(/^--no-/, '--');
      defaultValue = this._findOption(positiveLongFlag) ? this._getOptionValue(name) : true;
    }
    if (defaultValue) {
      this._setOptionValue(name, defaultValue);
    }
    this.options.push(newOption);
    this.on(`option:${newOption.name()}`, val => {
      const oldValue = this._getOptionValue(name);
      const newValue = val || (newOption.negate ? false : defaultValue || true);
      if (typeof oldValue === 'boolean' || typeof oldValue === 'undefined') {
        this._setOptionValue(name, newValue);
      }
    });
    return this;
  }

  _optionEx(optionConfig, optionFlags, optionDescription, optionValue, optionDefault) {
    const option = this.createOption(optionFlags, optionDescription);
    option.makeOptionMandatory(!!optionConfig.mandatory);
    if (typeof optionValue === 'function') {
      option.default(optionDefault).argParser(optionValue);
    } else if (optionValue instanceof RegExp) {
      const regex = optionValue;
      const parser = (arg, def) => {
        const match = regex.exec(arg);
        return match ? match[0] : def;
      };
      option.default(optionDefault).argParser(parser);
    } else {
      option.default(optionValue);
    }

    return this.addOption(option);
  }

  option(optionFlags, optionDescription, optionFn, optionDefaultValue) {
    return this._optionEx({}, optionFlags, optionDescription, optionFn, optionDefaultValue);
  }

  requiredOption(optionFlags, optionDescription, optionFn, optionDefaultValue) {
    return this._optionEx({ mandatory: true }, optionFlags, optionDescription, optionFn, optionDefaultValue);
  }

  _setOptionValue(k, v) {
    if (this._storeOptionsAsProperties) {
      this[k] = v;
    } else {
      this._optionValues[k] = v;
    }
  }

  _getOptionValue(k) {
    if (this._storeOptionsAsProperties) {
      return this[k];
    }
    return this._optionValues[k];
  }

  parse(args, options = {}) {
    if (!Array.isArray(args)) {
      throw new Error('first parameter to parse must be array or undefined');
    }
    this.rawArgs = args.slice();
    let userArgs;
    switch (options.from) {
      case 'node':
      case undefined:
        this._scriptPath = args[1];
        userArgs = args.slice(2);
        break;
      case 'electron':
        if (process.defaultApp) {
          this._scriptPath = args[1];
          userArgs = args.slice(2);
        } else {
          userArgs = args.slice(1);
        }
        break;
      case 'user':
        userArgs = args.slice(0);
        break;
      default:
        throw new Error(`unexpected parse option { from: '${options.from}' }`);
    }
    if (!this._name && this._scriptPath) {
      this._name = path.basename(this._scriptPath, path.extname(this._scriptPath));
    }
    this._parseCommand([], userArgs);
    return this;
  }

  _parseCommand(commandOperands, unknownOptions) {
    const parsed = this.parseOptions(unknownOptions);
    this.args = commandOperands.concat(parsed.commandOperands, parsed.unknown);
    this._checkForMissingMandatoryOptions();
  }

  _findOption(argv) {
    return this.options.find(option => option.is(argv));
  }

  _checkForMissingMandatoryOptions() {
    for (let command = this; command; command = command.parent) {
      command.options.forEach(option => {
        if (option.mandatory && command._getOptionValue(option.attributeName()) === undefined) {
          command.missingMandatoryOptionValue(option);
        }
      });
    }
  }

  parseOptions(args) {
    const operands = [];
    const unknown = [];
    let target = operands;
    const copy = args.slice();
    let variadicOption = null;
    while (copy.length) {
      const arg = copy.shift();
      if (arg === '--') {
        if (target === unknown) {
          target.push(arg);
        }
        target.push(...copy);
        break;
      }
      variadicOption = null;
      const option = this._findOption(arg);
      if (this.maybeOption(arg) && option) {
        this.optionEmit(option, copy);
        variadicOption = option.variadic ? option : null;
        continue;
      }
      if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') {
        const shortOption = this._findOption(`-${arg[1]}`);
        if (shortOption) {
          if (shortOption.required || (shortOption.optional && this._combineFlagAndOptionalValue)) {
            this.emit(`option:${shortOption.name()}`, arg.slice(2));
          } else {
            this.emit(`option:${shortOption.name()}`);
            copy.unshift(`-${arg.slice(2)}`);
          }
          continue;
        }
      }
      if (/^--[^=]+=/.test(arg)) {
        const index = arg.indexOf('=');
        const longOption = this._findOption(arg.slice(0, index));
        if (longOption && (longOption.required || longOption.optional)) {
          this.emit(`option:${longOption.name()}`, arg.slice(index + 1));
          continue;
        }
      }
      if (this.maybeOption(arg)) {
        target = unknown;
      }
      target.push(arg);
    }
    return { operands, unknown };
  }

  maybeOption(args) {
    return args.length > 1 && args[0] === '-';
  }

  optionEmit(emittedOption, argv) {
    const args = [...argv];
    if (emittedOption.required) {
      const value = args.shift();
      if (!value) {
        this.optionMissingArgument(emittedOption);
      }
      this.emit(`option:${emittedOption.name()}`, value);
    } else if (emittedOption.optional) {
      let value = null;
      if (args.length > 0 && !this.maybeOption(args[0])) {
        value = args.shift();
      }
      this.emit(`option:${emittedOption.name()}`, value);
    } else {
      this.emit(`option:${emittedOption.name()}`);
    }
  }

  opts() {
    if (this._storeOptionsAsProperties) {
      const res = {};
      const { length } = this.options;
      for (let i = 0; i < length; i++) {
        const k = this.options[i].attributeName();
        res[k] = k === this._versionOptionName ? this._version : this[k];
      }
      return res;
    }

    return this._optionValues;
  }

  version(vStr, vFlags, vDescription) {
    if (!vStr) {
      return this._version;
    }
    this._version = vStr;
    const vOptFlags = vFlags || '-V, --version';
    const vDesc = vDescription || 'output the version number';
    const vOption = this.createOption(vOptFlags, vDesc);
    this._versionOptionName = vOption.attributeName();
    this.options.push(vOption);
    return this;
  }

  description(dStr, dArgsDescription) {
    if (!dStr && !dArgsDescription) {
      return this._description;
    }
    this._description = dStr;
    this._argsDescription = dArgsDescription;
    return this;
  }

  usage(uStr) {
    if (!uStr) {
      const usage = this._usage;
      if (usage) {
        return usage;
      }
      const vArgs = this._args.map(argument => humanReadableArgName(argument));
      return []
        .concat(
          this.options.length || this._hasHelpOption ? '[options]' : [],
          this.commands.length ? '[command]' : [],
          this._args.length ? vArgs : []
        )
        .join(' ');
    }
    this._usage = uStr;
    return this;
  }

  name(nStr) {
    if (!nStr) {
      return this._name;
    }
    this._name = nStr;
    return this;
  }
}

module.exports = new Command();
exports = module.exports;
exports.program = exports;

exports.Command = Command;
exports.Option = Option;
exports.CommanderError = CommanderError;

function camelcase(vFlag) {
  return vFlag.split('-').reduce((str, word) => str + word[0].toUpperCase() + word.slice(1));
}

function humanReadableArgName(hArg) {
  const nameOutput = `${hArg.name}${hArg.variadic ? '...' : ''}`;
  return hArg.required ? `<${nameOutput}>` : `[${nameOutput}]`;
}

function parseOptionFlags(optionsFlags) {
  let shortOptionFlag;
  let longOptionFlag;
  const flagParts = optionsFlags.split(/[ |,]+/);
  if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1])) {
    shortOptionFlag = flagParts.shift();
  }
  longOptionFlag = flagParts.shift();
  if (!shortOptionFlag && /^-[^-]$/.test(longOptionFlag)) {
    shortOptionFlag = longOptionFlag;
    longOptionFlag = undefined;
  }
  return { shortOptionFlag, longOptionFlag };
}
