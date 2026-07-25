import { expect } from 'chai';
import { parseArgs } from '../src/args';
import { HANDLERS, contextFor, handlerFor, run, wantsHelp } from '../src/run';
import { ROLE_IDENTITIES, configFor } from '../src/client';

/**
 * Dispatch and identity selection, tested without a network. `run` is only
 * driven down paths that fail before a connection is opened — the paths that
 * do connect are verified by demo.sh against the live peer, which is the
 * evidence that actually matters for them.
 */
describe('handlerFor', () => {
  it('has a handler for each of the three roles', () => {
    expect(Object.keys(HANDLERS).sort()).to.deep.equal(['producer', 'regulator', 'transporter']);
  });

  it('lists the alternatives when the role is unknown', () => {
    expect(() => handlerFor('warehouse')).to.throw(/unknown role 'warehouse'/);
    expect(() => handlerFor('warehouse')).to.throw(/producer/);
  });
});

describe('wantsHelp', () => {
  it('is true when no arguments were supplied at all', () => {
    expect(wantsHelp(parseArgs([]))).to.equal(true);
  });

  it('is true for --help on a real command', () => {
    expect(wantsHelp(parseArgs(['producer', 'register', '--help']))).to.equal(true);
  });

  it('is false for a real invocation', () => {
    expect(wantsHelp(parseArgs(['producer', 'register']))).to.equal(false);
  });
});

describe('contextFor', () => {
  it('phrases the attempt as a verb clause so the rejection reads as a sentence', () => {
    expect(contextFor(parseArgs(['transporter', 'register']))).to.equal('register a batch');
    expect(contextFor(parseArgs(['transporter', 'transfer']))).to.equal(
      'transfer custody of this batch',
    );
    expect(contextFor(parseArgs(['regulator', 'recall']))).to.equal('recall this batch');
  });

  it('falls back to the raw role and command for anything unmapped', () => {
    expect(contextFor(parseArgs(['regulator', 'show']))).to.equal('run regulator show');
  });
});

describe('configFor', () => {
  it('signs each role as its own enrolled identity', () => {
    expect(ROLE_IDENTITIES.producer).to.equal('producer1');
    expect(ROLE_IDENTITIES.transporter).to.equal('transporter1');
    expect(ROLE_IDENTITIES.regulator).to.equal('regulator1');
  });

  it('resolves the MSP directory of the role identity', () => {
    expect(configFor('producer').certDirectoryPath).to.contain('producer1@org1.example.com');
  });

  it('lets --as point a role client at a different certificate, which is how the demo shows access control', () => {
    expect(configFor('producer', 'transporter1').certDirectoryPath).to.contain(
      'transporter1@org1.example.com',
    );
  });

  it('refuses a role it has no identity for instead of silently signing as someone else', () => {
    expect(() => configFor('auditor')).to.throw(/no identity known for role 'auditor'/);
  });
});

describe('run', () => {
  const collect = (): { lines: string[]; print: (line: string) => void } => {
    const lines: string[] = [];
    return { lines, print: (line: string) => lines.push(line) };
  };

  it('prints usage and exits 0 when asked for help', async () => {
    const out = collect();
    const result = await run(['--help'], out.print, out.print);
    expect(result.code).to.equal(0);
    expect(out.lines.join('\n')).to.contain('COMP6452 Task 3');
  });

  it('exits 2 with usage on a malformed argument, distinguishing user error from a failed transaction', async () => {
    const out = collect();
    const err = collect();
    const result = await run(['producer', 'register', '-x'], out.print, err.print);
    expect(result.code).to.equal(2);
    expect(err.lines.join('\n')).to.contain("unrecognised argument '-x'");
  });

  it('exits 1 on an unknown role', async () => {
    const out = collect();
    const err = collect();
    const result = await run(['auditor', 'inspect'], out.print, err.print);
    expect(result.code).to.equal(1);
    expect(err.lines.join('\n')).to.contain("unknown role 'auditor'");
  });

  it('exits 1 on an unknown command for a known role', async () => {
    const out = collect();
    const err = collect();
    const result = await run(['producer', 'demolish'], out.print, err.print);
    expect(result.code).to.equal(1);
    expect(err.lines.join('\n')).to.contain("unknown producer command 'demolish'");
  });

  it('fails a --expect-rejection step whose error was NOT a policy rejection', async () => {
    // A demo step asserting "the network refuses this" must not pass because
    // the peer was unreachable, so a non-policy error stays a failure even
    // under --expect-rejection.
    const out = collect();
    const err = collect();
    const result = await run(['producer', 'demolish', '--expect-rejection'], out.print, err.print);
    expect(result.code).to.equal(1);
  });
});
