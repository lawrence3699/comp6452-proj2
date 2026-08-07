COMP6452 26T2 Project 2 Task 3
Fresh food supply chain traceability on Hyperledger Fabric

TEAM
  Yan, Chaoliang  (z5643222)   batch-registry chaincode, private data collection
  Hu, Zhaoheng    (z5357529)   coldchain-compliance, breach counter, BFS recall
  Lin, Chi-Hsien  (z5620437)   off-chain aggregation, storage, gateway split
  Huang, Neier    (z5400040)   Fabric Gateway, role clients, network, integration


1. DEPENDENCIES

   - Docker 20.10 or later, with the daemon running
       Verified on Docker 29.5.2 via colima on macOS arm64.
       See section 4 for why deployment uses Chaincode-as-a-Service.
   - Node.js 18 or later          (verified on v22.23.1)
   - Hyperledger Fabric 2.5 binaries, Docker images, and fabric-samples
   - Fabric CA 1.5 client         (ships with the Fabric binaries)
   - jq                           (brew install jq / apt install jq)
   - Python 3                     (only for pretty-printing in the test scripts)

   Install the Fabric binaries, images and samples with the official script:

       mkdir -p ~/fabric-bootstrap && cd ~/fabric-bootstrap
       curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh -o install-fabric.sh
       chmod +x install-fabric.sh
       ./install-fabric.sh --fabric-version 2.5.13 --ca-version 1.5.15 samples binary docker
       docker pull hyperledger/fabric-nodeenv:2.5

   The last line is needed separately: fabric-nodeenv is not in the image set
   the installer pulls, but the Node chaincode runtime depends on it.

   The scripts look for fabric-samples at ~/fabric-bootstrap/fabric-samples.
   If yours lives elsewhere, export the path first:

       export FABRIC_SAMPLES=/your/path/to/fabric-samples


2. GENERATED FILES NOT INCLUDED IN THIS ARCHIVE

   Crypto material, channel artefacts, installed dependencies and compiled
   output are excluded by .gitignore. Everything below regenerates them:
     - node_modules/ and dist/ in each package  (npm install; npx tsc)
     - organizations/, channel-artifacts/       (network/network.sh up)
     - enrolled user MSPs                       (network/network.sh identities)
     - .offchain-store/                         (created on the first oracle run)


3. STARTING THE NETWORK

       cd network
       ./network.sh up

   Brings up the fabric-samples test-network with Fabric CAs (Org1MSP and
   Org2MSP, one peer each, one orderer) and creates the channel "mychannel".

   Then register the demo identities:

       ./network.sh identities

   This enrols producer1, transporter1, warehouse1, regulator1 and oracle1.
   Roles are issued as ABAC certificate attributes (role=producer:ecert, and
   oracle=true:ecert for the oracle), so the chaincode reads the caller's role
   from its signed certificate. A role cannot be forged by passing it as a
   transaction argument.


4. DEPLOYING THE CHAINCODE

       cd network
       ./deployCC.sh

   Deploys both chaincodes and prints their package IDs for addresses.txt.
   The script is re-runnable: it detects each chaincode's committed sequence
   and deploys at the next one, so a second run redeploys cleanly.

   WHY CHAINCODE-AS-A-SERVICE
   The peer's built-in Docker builder calls a legacy image-build API that
   Docker 29 no longer serves. A conventional `--lang node` install fails with

       could not build chaincode: docker build failed: docker image build
       failed: write unix @->/run/docker.sock: write: broken pipe

   Under CCaaS the chaincode image is built by us and runs as its own container
   that the peer dials. This is a supported Fabric 2.5 deployment mode — the
   peer ships a ccaas_builder for exactly this — not a workaround, and it is
   unaffected by the Docker version. deployCC.sh handles the whole sequence:
   compile, build image, package, install, start container, approve, commit.

   To tear everything down:

       ./network.sh down


5. RUNNING THE OFF-CHAIN SERVICES

   Storage adapter (content-addressed, verifies on read):
       cd offchain/storage && npm install

   Oracle (aggregates readings off chain, anchors the raw series, submits
   only the summary and its hash on chain):
       cd offchain/oracle-service && npm install && npm start
       ORACLE_DRY_RUN=1 npm start     # aggregation + storage, no network

   Event indexer (subscribes to chaincode events, serves fast queries):
       cd offchain/indexer && npm install && npm start
       curl http://127.0.0.1:3001/health
       curl http://127.0.0.1:3001/batch/<batchId>/history

   The indexer answers a history query from its own store rather than from the
   ledger. Every response carries an X-Query-Time-Ms header as evidence for the
   fast-query requirement; 0.244 ms was observed against a live batch.


6. RUNNING THE DEMO

       cd application
       ./demo.sh

   Scripted end to end, with no commands typed live. The story it tells: a
   producer registers a batch, custody moves down the chain, a second batch
   walks the clean path to the warehouse and is marked DELIVERED by the
   warehouse identity, the oracle reports temperatures that breach the cold
   chain, coldchain-compliance flags the incident batch automatically through
   a cross-chaincode call, and the regulator reads the complete history back
   and cascades a recall through the derivation graph.


7. RUNNING THE TESTS

   Unit tests. No network required — the chaincode tests run against a stubbed
   ChaincodeStub:

       cd chaincode/batch-registry        && npm install && npm test    # 46
       cd chaincode/coldchain-compliance  && npm install && npm test    # 18
       cd offchain/shared                 && npm install && npm test    # 20
       cd offchain/storage                && npm install && npm test    # 34
       cd offchain/oracle-service         && npm install && npm test    # 51
       cd offchain/indexer                && npm install && npm test    # 82
       cd application                     && npm install && npm test    # 85

                                                             total      336

   End-to-end test. Needs the network up, identities registered and both
   chaincodes deployed (sections 3 and 4):

       test/integration/e2e.sh

   Covers the full required path together with the access-control rejections:
   registration by a producer, rejection of a non-producer, custody transfer,
   rejection of a non-holder, warehouse receipt and delivery (the full
   CREATED -> IN_TRANSIT -> AT_WAREHOUSE -> DELIVERED walk, with a non-holder
   refused MarkDelivered), rejection of a non-oracle reading, rejection of a
   malformed rawDataHash, three consecutive breaches, the automatic
   cross-chaincode flag, and the regulator's read of the complete ordered
   history, plus the private data collection (written via the transient map,
   absent from the public ledger, readable by a collection member, and its
   on-chain hash matching a locally computed SHA-256 of the payload) and the
   recall cascade through the derivation graph, two levels deep. It then
   starts the event indexer against the run's own blocks and asserts the
   delivery and the recall are served back over HTTP. 29 assertions.


8. REQUIREMENTS COVERAGE

   FR1 batch registration       batch-registry RegisterBatch, validating shelf
                                life, quantity and production date
   FR2 traceability             BatchQueryContract GetBatchHistory (full
                                custody chain) and GetBatchesByHolder
   FR3 problem batch marking    coldchain-compliance flags after three
                                consecutive breaches, and on regulator demand;
                                recalls cascade to derived batches
   Off-chain computation        oracle-service aggregates the reading series
                                off chain and submits only the summary
   Off-chain storage            storage adapter holds raw series, reports and
                                photographs; only the SHA-256 is anchored
   Oracle                       oracle-service submits under an identity whose
                                certificate carries oracle=true
   Private data                 batchPrivateDetails collection holds unit price
                                and inspection notes; only the hash is public
   Access control               ABAC role attributes on enrolment certificates
   Cross-chaincode call         coldchain-compliance invokes FlagBatch on
                                batch-registry, same channel, atomic write set


9. DESIGN NOTES WORTH KNOWING

   Determinism. Chaincode never calls Date.now(). Every endorsing peer must
   produce an identical write set or the transaction fails validation, so all
   timestamps come from ctx.stub.getTxTimestamp().

   Who may flag a batch. invokeChaincode does not re-sign the transaction, so
   when coldchain-compliance calls FlagBatch the client identity is still the
   oracle's, not a regulator's. FlagBatch therefore accepts either a regulator
   or the oracle, and records which in the emitted event, so the audit trail
   distinguishes a human decision from an automated one.

   Consecutive breaches. A single stray reading (a door opening) should not
   condemn a shipment, so the counter requires three breaches in a row and
   resets as soon as a reading returns to range.

   Tamper evidence. The storage adapter re-hashes content on read and refuses
   to return bytes that no longer match the hash anchored on chain.

   History ordering. getHistoryForKey returns newest-first against a real peer,
   so GetBatchHistory sorts explicitly before returning oldest-first.
