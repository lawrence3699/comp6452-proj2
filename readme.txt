COMP6452 26T2 Project 2 Task 3
Fresh food supply chain traceability on Hyperledger Fabric

TEAM
  Person 1  Yan, Chaoliang  (z5643222)  batch-registry chaincode - state
                                        machine, ABAC roles, private data
  Person 2  Hu, Zhaoheng    (z5357529)  coldchain-compliance chaincode -
                                        breach counter, FlagBatch, BFS recall
  Person 3  Lin, Chi-Hsien  (z5620437)  off-chain layer - oracle aggregation,
                                        storage integrity, event indexer
  Person 4  Huang, Neier    (z5400040)  Fabric network, client applications,
                                        identities, integration tests

1. DEPENDENCIES
   - Docker Engine 24 or later (Docker Desktop 4.30+). The Fabric 2.5.16 peer
     image needs a recent Docker API to build chaincode; Docker 20.10 /
     Desktop 4.17 is too old and chaincode install fails with
     "client version ... is too new. Maximum supported API version is 1.41".
   - Node.js 18 or later
   - Hyperledger Fabric 2.5 binaries, Docker images and fabric-samples,
     installed with the official script:
       curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
       chmod +x install-fabric.sh && ./install-fabric.sh docker samples binary
   - A POSIX shell (macOS/Linux). Set FABRIC_SAMPLES_PATH in every shell that
     runs a network script:
       export FABRIC_SAMPLES_PATH=~/fabric-samples

2. GENERATED FILES NOT INCLUDED IN THIS ARCHIVE
   Crypto material, channel artefacts, installed dependencies and compiled
   output are excluded. Regenerate them with the steps below.

3. STARTING THE NETWORK
   Bring up the CA-based test-network and create channel 'mychannel'. It is
   CA-based (not cryptogen) because the role/oracle ABAC attributes the
   chaincode checks must be issued by a Fabric CA at enrolment.
     cd network/scripts
     ./up.sh

4. DEPLOYING THE CHAINCODE
   Build and deploy both chaincodes (package / install / approve / commit on
   both organisations; batch-registry also attaches the private data
   collection from network/collections_config.json):
     cd network/scripts
     ./deployAll.sh

   Register the demo identities — producer1, transporter1, regulator1 on Org1,
   and oracle1 on Org2 enrolled with oracle=true. This writes one env file per
   identity under network/identities/:
     ./setupDemoIdentities.sh

5. RUNNING THE OFF-CHAIN SERVICES
   The off-chain layer is three npm packages under offchain/: oracle-service,
   storage and indexer. Install each with `npm install`.

   The oracle and indexer reach the peer through the Fabric Gateway, configured
   from the per-identity env files that setupDemoIdentities.sh writes under
   network/identities/ (MSP_ID, CERT_DIRECTORY_PATH, PEER_ENDPOINT, ...); see
   offchain/README.md ("Configuration"). The runnable demo is in section 6.

   IMPORTANT: the oracle client identity must be enrolled with the 'oracle'
   attribute, otherwise coldchain-compliance rejects its temperature readings.

   Entry points:
     - oracle-service: runOracleCycle() aggregates a window of readings, stores
       the raw series, and submits the summary; submit() is the gateway-backed
       shortcut used by the demo runner.
     - indexer: listen() subscribes to batch-registry and coldchain-compliance
       events; historyFor(batchId) returns a batch's ordered history.

   The demo runner that wires these to the live gateway and a reading feed is
   invoked in section 6.

6. RUNNING THE DEMO
   Each actor runs as its own identity by exporting its env file. Run from the
   repo root, one step per terminal.

   1. Producer registers a chilled batch B1 (allowed range 0-4C):
        export $(cat network/identities/producer1.env | xargs)
        cd application && npm install
        npm run producer -- B1 chilled 14 "Farm A" 500 12 "ok"

   2. Second terminal — start the indexer (any member identity; read only). It
      replays B1's history and prints new events live:
        export $(cat network/identities/regulator1.env | xargs)
        cd offchain/demo && npm install
        DEMO_BATCH_ID=B1 npm run indexer

   3. Third terminal — run the oracle (must be oracle1). It aggregates three
      temperature windows, stores each raw series off chain, and submits the
      summaries; three consecutive breaches flag B1:
        export $(cat network/identities/oracle1.env | xargs)
        cd offchain/demo && npm run oracle

   Result: the indexer prints BatchRegistered then BatchFlagged for B1, and the
   batch reads back as FLAGGED on chain. The flag's evidenceHash is the SHA-256
   of the raw temperature series held off chain by the storage adapter — the
   off-chain computation, off-chain storage and oracle in one flow.

   Tear the network down when finished:
     cd network/scripts && ./down.sh

7. RUNNING THE TESTS
   cd chaincode/batch-registry && npm install && npm test
   cd chaincode/coldchain-compliance && npm install && npm test
   cd offchain/oracle-service && npm install && npm test
   cd offchain/storage && npm install && npm test
   cd offchain/indexer && npm install && npm test

   End-to-end integration tests need the network up, both chaincodes deployed
   and the demo identities registered (sections 3-4):
   cd test/integration && npm install && npm test
