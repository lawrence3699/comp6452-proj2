import { expect } from 'chai';
import { parseArgs } from '../src/args';
import { run } from '../src/run';
import { USAGE } from '../src/usage';
import { runWarehouse } from '../src/warehouse';

/**
 * Warehouse dispatch, tested without a network. Both failure paths below throw
 * before a gateway connection is opened — the option check runs ahead of
 * `asRole` — so these tests prove the CLI refuses bad invocations locally
 * rather than by burning a round trip to the peer. The path that does connect
 * (deliver against a live AT_WAREHOUSE batch) is verified by demo.sh, which is
 * the evidence that actually matters for it.
 */
describe('runWarehouse', () => {
  const swallow = (): void => undefined;

  it('rejects an unknown command and lists the real ones', async () => {
    let message = '';
    try {
      await runWarehouse(parseArgs(['warehouse', 'demolish']), swallow);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.match(/unknown warehouse command 'demolish'/);
    expect(message).to.contain('deliver');
    expect(message).to.contain('show');
  });

  it('deliver refuses to run without --batch, naming the option and the command', async () => {
    let message = '';
    try {
      await runWarehouse(parseArgs(['warehouse', 'deliver']), swallow);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.match(/warehouse deliver: missing required option --batch/);
  });

  it('show refuses to run without --batch', async () => {
    let message = '';
    try {
      await runWarehouse(parseArgs(['warehouse', 'show']), swallow);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.match(/warehouse show: missing required option --batch/);
  });
});

describe('warehouse through the shared front door', () => {
  const collect = (): { lines: string[]; print: (line: string) => void } => {
    const lines: string[] = [];
    return { lines, print: (line: string) => lines.push(line) };
  };

  it('run exits 1 when warehouse deliver is missing --batch', async () => {
    const out = collect();
    const err = collect();
    const result = await run(['warehouse', 'deliver'], out.print, err.print);
    expect(result.code).to.equal(1);
    expect(err.lines.join('\n')).to.contain('missing required option --batch');
  });

  it('run exits 1 on an unknown warehouse command', async () => {
    const out = collect();
    const err = collect();
    const result = await run(['warehouse', 'demolish'], out.print, err.print);
    expect(result.code).to.equal(1);
    expect(err.lines.join('\n')).to.contain("unknown warehouse command 'demolish'");
  });
});

describe('usage text', () => {
  // The brief requires the help output to stand in for the source, so the new
  // role has to be documented there, not just implemented.
  it('documents the warehouse role and both of its commands', () => {
    expect(USAGE).to.contain('WAREHOUSE');
    expect(USAGE).to.contain('warehouse1');
    expect(USAGE).to.contain('warehouse deliver --batch ID');
    expect(USAGE).to.contain('warehouse show --batch ID');
  });
});
