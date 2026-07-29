COMP6452 26T2 Project 2 Task 3
Fresh food supply chain traceability on Hyperledger Fabric

TEAM
  Yan, Chaoliang  (z5643222)
  Huang, Neier    (z5400040)
  Hu, Zhaoheng    (z5357529)
  Lin, Chi-Hsien  (z5620437)

TODO before submission: fill in every section below and verify the
instructions by unpacking this archive into an empty directory and following
them from scratch.

1. DEPENDENCIES
   - Docker and Docker Compose
   - Node.js 18 or later
   - Hyperledger Fabric binaries and Docker images, version 2.5
   - <add anything else>

2. GENERATED FILES NOT INCLUDED IN THIS ARCHIVE
   Crypto material, channel artefacts, installed dependencies and compiled
   output are excluded. Regenerate them with the steps below.

3. STARTING THE NETWORK
   <commands>

4. DEPLOYING THE CHAINCODE
   <commands, one per chaincode>

5. RUNNING THE OFF-CHAIN SERVICES
   The off-chain layer is three npm packages under offchain/: oracle-service,
   storage and indexer. Install each with `npm install`.

   The oracle and indexer reach the peer through the Fabric Gateway and are
   configured from environment variables (ORACLE_* and INDEXER_*); see
   offchain/README.md ("Configuration") for the full list. Point them at the
   peer brought up in section 3.

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
   <commands>

7. RUNNING THE TESTS
   cd chaincode/batch-registry && npm install && npm test
   cd chaincode/coldchain-compliance && npm install && npm test
   cd offchain/oracle-service && npm install && npm test
   cd offchain/storage && npm install && npm test
   cd offchain/indexer && npm install && npm test
   <integration tests>
