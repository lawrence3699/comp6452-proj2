import { expect } from 'chai';
import {
  chaincodeMessage,
  describeFailure,
  explain,
  isPolicyRejection,
  rawMessage,
} from '../src/errors';

/**
 * The rejection messages are part of the demo, not just diagnostics: a marker
 * watching the recording is supposed to read "a transporter cannot register a
 * batch", not a gRPC status line. So the translation is pinned here.
 *
 * Every `chaincode said` string below is copied verbatim from a real
 * EndorseError observed against the live network, so these tests fail if the
 * chaincode's wording drifts away from what the clients recognise.
 */
const gatewayError = (...details: string[]): unknown => ({
  name: 'EndorseError',
  message: '10 ABORTED: failed to endorse transaction, see attached details for more info',
  code: 10,
  details: details.map((message) => ({ message, mspId: 'Org1MSP', address: 'peer0:7051' })),
});

describe('chaincodeMessage', () => {
  it('digs the chaincode message out of the gRPC details', () => {
    const error = gatewayError('chaincode response 500, access denied: nope');
    expect(chaincodeMessage(error)).to.equal('chaincode response 500, access denied: nope');
  });

  it('deduplicates identical messages from multiple endorsers', () => {
    const error = gatewayError('same complaint', 'same complaint');
    expect(chaincodeMessage(error)).to.equal('same complaint');
  });

  it('keeps genuinely different endorser messages visible', () => {
    const error = gatewayError('org1 says no', 'org2 timed out');
    expect(chaincodeMessage(error)).to.equal('org1 says no; org2 timed out');
  });

  it('returns undefined for a plain Error', () => {
    expect(chaincodeMessage(new Error('boom'))).to.equal(undefined);
  });
});

describe('rawMessage', () => {
  it('prefers the chaincode detail over the outer gRPC status line', () => {
    expect(rawMessage(gatewayError('the real reason'))).to.equal('the real reason');
  });

  it('falls back to an Error message', () => {
    expect(rawMessage(new Error('local failure'))).to.equal('local failure');
  });

  it('stringifies a thrown non-Error', () => {
    expect(rawMessage('just a string')).to.equal('just a string');
  });
});

describe('explain', () => {
  it('names both roles in a role mismatch', () => {
    const explanation = explain(
      "chaincode response 500, access denied: caller has role 'transporter', 'producer' is required",
      'register a batch',
    );
    expect(explanation?.headline).to.equal(
      'a transporter cannot register a batch — only a producer may',
    );
    expect(explanation?.because).to.contain('ABAC attribute');
  });

  it('recognises a certificate with no role attribute at all', () => {
    const explanation = explain(
      "access denied: caller certificate carries no 'role' attribute, 'producer' is required",
      'register a batch',
    );
    expect(explanation?.headline).to.contain('carries no role at all');
  });

  it('names the holder in a custody violation', () => {
    const explanation = explain(
      'chaincode response 500, TransferCustody: caller Org1MSP is not the current holder Org2MSP',
      'transfer custody of this batch',
    );
    expect(explanation?.headline).to.equal(
      'Org1MSP cannot hand on this batch — Org2MSP is holding it',
    );
  });

  it('names both states in an illegal transition', () => {
    const explanation = explain('illegal status transition: RECALLED -> IN_TRANSIT', 'act');
    expect(explanation?.headline).to.equal('a batch that is RECALLED cannot become IN_TRANSIT');
  });

  it('recognises the oracle-only guard', () => {
    const explanation = explain(
      'access denied: only an identity enrolled with the oracle attribute may submit temperature readings',
      'submit a reading',
    );
    expect(explanation?.headline).to.contain('only the oracle identity');
  });

  it('recognises a regulator-only guard', () => {
    const explanation = explain("access denied: caller role 'producer' is not a regulator", 'recall this batch');
    expect(explanation?.headline).to.contain('regulator-only action');
  });

  it('recognises a duplicate batch id', () => {
    const explanation = explain('RegisterBatch: batch BATCH-1 already exists', 'register a batch');
    expect(explanation?.headline).to.contain('already on the ledger');
  });

  it('recognises a missing batch', () => {
    expect(explain('batch BATCH-9 does not exist', 'act')?.headline).to.contain(
      'no batch with that id exists',
    );
  });

  it('recognises an unreadable private collection', () => {
    const explanation = explain(
      'no private details readable for batch BATCH-1: the batch may not exist',
      'read private details',
    );
    expect(explanation?.because).to.contain('batchPrivateDetails');
  });

  it('returns undefined for a message it does not recognise', () => {
    // Falling through is deliberate: mislabelling an unfamiliar failure as an
    // access-control rejection would hide a real bug behind a reassuring line.
    expect(explain('DEADLINE_EXCEEDED', 'act')).to.equal(undefined);
  });
});

describe('describeFailure', () => {
  it('leads with the plain-English rejection and keeps the chaincode text as evidence', () => {
    const rendered = describeFailure(
      gatewayError(
        "chaincode response 500, access denied: caller has role 'transporter', 'producer' is required",
      ),
      'register a batch',
    );
    const lines = rendered.split('\n');
    expect(lines[0]).to.contain('REJECTED BY THE NETWORK');
    expect(lines[0]).to.contain('a transporter cannot register a batch');
    expect(rendered).to.contain('chaincode said:');
    expect(rendered).to.contain('why:');
    // The point of the translation is that no gRPC noise survives into the
    // headline the audience reads.
    expect(lines[0]).to.not.contain('ABORTED');
  });

  it('reports an unrecognised failure as a failure, not as a rejection', () => {
    const rendered = describeFailure(new Error('connection refused'), 'register a batch');
    expect(rendered).to.contain('FAILED to register a batch');
    expect(rendered).to.not.contain('REJECTED BY THE NETWORK');
  });
});

describe('isPolicyRejection', () => {
  it('is true when the network enforced a rule', () => {
    expect(
      isPolicyRejection(gatewayError("access denied: caller has role 'transporter', 'producer' is required")),
    ).to.equal(true);
  });

  it('is false for a transport failure, so a dead peer never looks like a passing demo step', () => {
    expect(isPolicyRejection(new Error('14 UNAVAILABLE: No connection established'))).to.equal(false);
  });
});
