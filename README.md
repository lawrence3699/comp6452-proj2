# COMP6452 26T2 — Project 2, Task 3

Blockchain-based traceability proof of concept for a fresh food supply chain,
built on Hyperledger Fabric.

## Team

| | Member | zID | Area |
|---|---|---|---|
| Person 1 | Yan, Chaoliang | z5643222 | `batch-registry` chaincode, private data collection |
| Person 2 | Hu, Zhaoheng | z5357529 | `coldchain-compliance` chaincode |
| Person 3 | Lin, Chi-Hsien | z5620437 | Off-chain oracle, storage, event indexer |
| Person 4 | Huang, Neier | z5400040 | Fabric network, client applications, integration tests |

## Layout

```
chaincode/batch-registry/          FR1 registration, FR2 traceability   person 1
chaincode/batch-registry/src/queries.ts   read-only query path          person 4
chaincode/coldchain-compliance/    FR3 flagging, oracle consumption     person 2
offchain/oracle-service/           temperature aggregation and submit   person 3
offchain/storage/                  IPFS / cloud adapter                 person 3
offchain/indexer/                  chaincode event listener and query   person 3
network/                           test-network, channel, lifecycle     person 4
application/                       producer / transporter / regulator   person 4
test/integration/                  end-to-end tests                     person 4
docs/interfaces.md                 interfaces frozen on day 1
```

Start from `docs/interfaces.md` — every workstream depends on those shapes.

## Quick start

```bash
cd network
./network.sh up          # test-network + CAs + mychannel
./network.sh identities  # producer1, transporter1, warehouse1, regulator1, oracle1
./deployCC.sh            # build, package, install, approve, commit both chaincodes
```

Both chaincodes deploy as Chaincode-as-a-Service, because the peer's built-in
Docker builder no longer works against Docker 29. `readme.txt` section 4 has
the details.

## Running the tests

Unit tests need no network — the chaincode tests run against a stubbed
`ChaincodeStub`:

```bash
cd chaincode/batch-registry        && npm install && npm test   # 12
cd chaincode/coldchain-compliance  && npm install && npm test   # 12
cd offchain/shared                 && npm install && npm test   # 20
cd offchain/storage                && npm install && npm test   # 16
cd offchain/oracle-service         && npm install && npm test   # 51
cd offchain/indexer                && npm install && npm test   # 57
cd application                     && npm install && npm test   # 79
```

The end-to-end suite runs against a live network and covers the full required
path, the access-control rejections and the private data collection:

```bash
test/integration/e2e.sh   # 20 assertions
```

## Submission

`readme.txt` and `addresses.txt` are the marked submission files. Produce a
clean archive straight from git, which excludes everything in `.gitignore`
as well as the `.git` directory itself:

```bash
git archive --format=zip HEAD -o proj2_3.zip
```
