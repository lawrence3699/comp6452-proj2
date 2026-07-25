import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cryptoPath, envOrDefault, loadConfig, orgDomain, userMspPath } from '../src/config';
import { newIdentity, newSigner } from '../src/gateway';

const ENV_KEYS = [
  'CHANNEL_NAME',
  'MSP_ID',
  'PEER_ENDPOINT',
  'PEER_HOST_ALIAS',
  'TLS_CERT_PATH',
  'CERT_DIRECTORY_PATH',
  'KEY_DIRECTORY_PATH',
  'COMPLIANCE_CHAINCODE',
  'REGISTRY_CHAINCODE',
  'FABRIC_TEST_NETWORK',
  'FABRIC_USER',
  'ORG_DOMAIN',
  'CRYPTO_PATH',
];

/**
 * Config resolution is pure string manipulation over the environment, so the
 * whole suite runs with no Fabric network and no crypto material.
 */
describe('fabric config', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('envOrDefault', () => {
    it('returns the environment value when set', () => {
      process.env.CHANNEL_NAME = 'otherchannel';
      expect(envOrDefault('CHANNEL_NAME', 'mychannel')).to.equal('otherchannel');
    });

    it('treats an empty string as unset, because shell scripts export empties', () => {
      process.env.CHANNEL_NAME = '';
      expect(envOrDefault('CHANNEL_NAME', 'mychannel')).to.equal('mychannel');
    });
  });

  describe('defaults', () => {
    it('targets mychannel on Org1MSP at the test network peer', () => {
      const config = loadConfig();

      expect(config.channelName).to.equal('mychannel');
      expect(config.mspId).to.equal('Org1MSP');
      expect(config.peerEndpoint).to.equal('localhost:7051');
      expect(config.peerHostAlias).to.equal('peer0.org1.example.com');
    });

    it('names both project chaincodes', () => {
      const config = loadConfig();

      expect(config.complianceChaincode).to.equal('coldchain-compliance');
      expect(config.registryChaincode).to.equal('batch-registry');
    });

    it('derives the TLS and MSP paths from the test network layout', () => {
      const config = loadConfig();

      expect(config.tlsCertPath).to.contain(
        path.join('peers', 'peer0.org1.example.com', 'tls', 'ca.crt'),
      );
      expect(config.certDirectoryPath).to.contain(path.join('msp', 'signcerts'));
      expect(config.keyDirectoryPath).to.contain(path.join('msp', 'keystore'));
    });
  });

  describe('overrides', () => {
    it('honours every env override', () => {
      process.env.CHANNEL_NAME = 'ch2';
      process.env.MSP_ID = 'Org2MSP';
      process.env.PEER_ENDPOINT = 'peer:9051';
      process.env.PEER_HOST_ALIAS = 'peer0.org2.example.com';
      process.env.COMPLIANCE_CHAINCODE = 'cc2';
      process.env.REGISTRY_CHAINCODE = 'reg2';

      const config = loadConfig();

      expect(config.channelName).to.equal('ch2');
      expect(config.mspId).to.equal('Org2MSP');
      expect(config.peerEndpoint).to.equal('peer:9051');
      expect(config.peerHostAlias).to.equal('peer0.org2.example.com');
      expect(config.complianceChaincode).to.equal('cc2');
      expect(config.registryChaincode).to.equal('reg2');
    });

    it('lets an explicit argument beat the environment', () => {
      process.env.CHANNEL_NAME = 'from-env';

      expect(loadConfig({ channelName: 'from-arg' }).channelName).to.equal('from-arg');
    });

    it('re-reads the environment on every call rather than memoising at import', () => {
      process.env.PEER_ENDPOINT = 'first:7051';
      expect(loadConfig().peerEndpoint).to.equal('first:7051');

      process.env.PEER_ENDPOINT = 'second:7051';
      expect(loadConfig().peerEndpoint).to.equal('second:7051');
    });

    it('roots the crypto path at FABRIC_TEST_NETWORK', () => {
      process.env.FABRIC_TEST_NETWORK = '/opt/fabric/test-network';

      expect(cryptoPath()).to.equal(
        path.join('/opt/fabric/test-network', 'organizations', 'peerOrganizations', 'org1.example.com'),
      );
    });

    it('follows ORG_DOMAIN into both the crypto path and the peer cert path', () => {
      process.env.ORG_DOMAIN = 'org2.example.com';

      expect(orgDomain()).to.equal('org2.example.com');
      expect(cryptoPath()).to.contain('org2.example.com');
      expect(loadConfig().tlsCertPath).to.contain('peer0.org2.example.com');
    });
  });

  describe('user resolution', () => {
    it('defaults to the test network User1 identity', () => {
      expect(userMspPath()).to.contain(path.join('users', 'User1@org1.example.com', 'msp'));
    });

    it('qualifies a bare enrolment name with the org domain', () => {
      process.env.FABRIC_USER = 'oracle1';

      expect(userMspPath()).to.contain(path.join('users', 'oracle1@org1.example.com', 'msp'));
    });

    it('leaves an already-qualified name alone', () => {
      process.env.FABRIC_USER = 'Admin@org1.example.com';

      expect(userMspPath()).to.contain(path.join('users', 'Admin@org1.example.com', 'msp'));
    });

    it('lets a service supply its own default identity', () => {
      const config = loadConfig({}, 'oracle1');

      expect(config.certDirectoryPath).to.contain(path.join('users', 'oracle1@org1.example.com'));
      expect(config.keyDirectoryPath).to.contain(path.join('users', 'oracle1@org1.example.com'));
    });

    it('lets FABRIC_USER beat the service default', () => {
      process.env.FABRIC_USER = 'regulator1';

      expect(loadConfig({}, 'oracle1').certDirectoryPath).to.contain('regulator1@org1.example.com');
    });

    it('does not mutate the environment, so one service cannot change another\'s identity', () => {
      loadConfig({}, 'oracle1');

      expect(process.env.FABRIC_USER).to.equal(undefined);
      // A later caller with a different default must be unaffected.
      expect(loadConfig({}, 'warehouse1').certDirectoryPath).to.contain('warehouse1@');
    });
  });
});

describe('gateway identity loading', () => {
  it('reads the signing certificate and tags it with the MSP id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msp-'));
    const certDir = path.join(dir, 'signcerts');
    await fs.mkdir(certDir);
    await fs.writeFile(path.join(certDir, 'cert.pem'), 'PEM BODY');

    try {
      const identity = await newIdentity(loadConfig({ certDirectoryPath: certDir, mspId: 'Org1MSP' }));

      expect(identity.mspId).to.equal('Org1MSP');
      expect(Buffer.from(identity.credentials).toString()).to.equal('PEM BODY');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('names the missing directory when identity material is absent', async () => {
    let thrown: Error | undefined;
    try {
      await newIdentity(loadConfig({ certDirectoryPath: '/nonexistent/signcerts' }));
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.contain('/nonexistent/signcerts');
    expect(thrown?.message).to.contain('FABRIC_USER');
  });

  it('reports an empty identity directory distinctly from a missing one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msp-empty-'));

    let thrown: Error | undefined;
    try {
      await newSigner(loadConfig({ keyDirectoryPath: dir }));
    } catch (error) {
      thrown = error as Error;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    expect(thrown?.message).to.contain('is empty');
  });

  it('ignores dotfiles when picking the key, so .DS_Store does not break enrolment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msp-key-'));
    await fs.writeFile(path.join(dir, '.DS_Store'), 'junk');

    let thrown: Error | undefined;
    try {
      await newSigner(loadConfig({ keyDirectoryPath: dir }));
    } catch (error) {
      thrown = error as Error;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    // The dotfile was skipped, so the directory reads as empty rather than
    // being handed to createPrivateKey as a bogus PEM.
    expect(thrown?.message).to.contain('is empty');
  });
});
