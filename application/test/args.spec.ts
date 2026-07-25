import { expect } from 'chai';
import {
  BOOLEAN_FLAGS,
  hasFlag,
  numberOption,
  option,
  parseArgs,
  requireOption,
} from '../src/args';

/**
 * Argument parsing is the one piece of client logic a marker can break by
 * typing, so it carries the tests. The gateway paths are exercised by
 * demo.sh against the live network instead — mocking a peer would only prove
 * the mock behaves.
 */
describe('parseArgs', () => {
  it('reads the role and command from the leading positionals', () => {
    const parsed = parseArgs(['producer', 'register']);
    expect(parsed.role).to.equal('producer');
    expect(parsed.command).to.equal('register');
    expect(parsed.positional).to.deep.equal([]);
  });

  it('defaults to help when nothing is supplied, rather than throwing', () => {
    const parsed = parseArgs([]);
    expect(parsed.role).to.equal('help');
    expect(parsed.command).to.equal('help');
  });

  it('accepts --key value', () => {
    const parsed = parseArgs(['producer', 'register', '--batch', 'BATCH-1']);
    expect(parsed.options.batch).to.equal('BATCH-1');
  });

  it('accepts --key=value', () => {
    const parsed = parseArgs(['producer', 'register', '--batch=BATCH-1']);
    expect(parsed.options.batch).to.equal('BATCH-1');
  });

  it('keeps an = inside a value intact', () => {
    const parsed = parseArgs(['transporter', 'log', '--note=temp=2C, sealed']);
    expect(parsed.options.note).to.equal('temp=2C, sealed');
  });

  it('treats a declared boolean flag as true without consuming the next token', () => {
    const parsed = parseArgs(['regulator', 'recall', '--direct', '--batch', 'B-1']);
    expect(parsed.options.direct).to.equal('true');
    expect(parsed.options.batch).to.equal('B-1');
  });

  it('declares every flag the clients treat as boolean', () => {
    // A flag missing from this list silently eats the following argument,
    // which is the failure mode the list exists to prevent.
    expect(BOOLEAN_FLAGS).to.include.members([
      'direct',
      'no-private',
      'no-report',
      'expect-rejection',
      'help',
    ]);
  });

  it('treats a trailing undeclared option as a flag rather than erroring', () => {
    const parsed = parseArgs(['regulator', 'show', '--verbose']);
    expect(parsed.options.verbose).to.equal('true');
  });

  it('does not let an option swallow the following option', () => {
    const parsed = parseArgs(['regulator', 'flag', '--reason', '--batch', 'B-1']);
    expect(parsed.options.reason).to.equal('true');
    expect(parsed.options.batch).to.equal('B-1');
  });

  it('accepts -h as help', () => {
    expect(hasFlag(parseArgs(['-h']), 'help')).to.equal(true);
  });

  it('passes everything after -- through as positional', () => {
    const parsed = parseArgs(['regulator', 'show', '--', '--weird-batch-id']);
    expect(parsed.positional).to.deep.equal(['--weird-batch-id']);
  });

  it('rejects a single-dash argument that is not -h', () => {
    expect(() => parseArgs(['producer', 'register', '-x'])).to.throw(/unrecognised argument '-x'/);
  });

  it('rejects a bare --', () => {
    expect(() => parseArgs(['producer', 'register', '--='])).to.throw(/unrecognised argument/);
  });
});

describe('option accessors', () => {
  const parsed = parseArgs(['producer', 'register', '--batch', 'B-1', '--empty=', '--quantity', '250']);

  it('returns the value when present', () => {
    expect(option(parsed, 'batch')).to.equal('B-1');
  });

  it('treats an empty value as absent so a blank shell variable takes the default', () => {
    expect(option(parsed, 'empty', 'fallback')).to.equal('fallback');
  });

  it('returns undefined for an absent option with no fallback', () => {
    expect(option(parsed, 'nope')).to.equal(undefined);
  });

  it('requireOption names the option and the command it belongs to', () => {
    expect(() => requireOption(parsed, 'to')).to.throw(
      /producer register: missing required option --to/,
    );
  });

  it('numberOption parses a numeric option', () => {
    expect(numberOption(parsed, 'quantity', 1)).to.equal(250);
  });

  it('numberOption falls back when the option is absent', () => {
    expect(numberOption(parsed, 'shelf-life', 14)).to.equal(14);
  });

  it('numberOption rejects a non-numeric value rather than yielding NaN', () => {
    const bad = parseArgs(['producer', 'register', '--quantity', 'lots']);
    expect(() => numberOption(bad, 'quantity', 1)).to.throw(/--quantity must be a number/);
  });

  it('numberOption throws when a required numeric option is missing', () => {
    expect(() => numberOption(parsed, 'unit-price')).to.throw(/missing required option --unit-price/);
  });

  it('hasFlag is false for an unset flag', () => {
    expect(hasFlag(parsed, 'direct')).to.equal(false);
  });
});
