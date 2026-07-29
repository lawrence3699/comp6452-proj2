# COMP6452 26T2 — Project 2, Task 3

Blockchain-based cold-chain traceability and automated recall proof of concept
for pasteurised milk, built on Hyperledger Fabric. `pasteurised-milk` uses the
existing chilled temperature profile of 0–4°C.

## Team

| | Member | zID | Area |
|---|---|---|---|
| Person 1 | Yan, Chaoliang | z5643222 | `batch-registry` chaincode, private data collection |
| Person 2 | Huang, Neier | z5400040 | `coldchain-compliance` chaincode |
| Person 3 | Hu, Zhaoheng | z5357529 | Off-chain oracle, storage, event indexer |
| Person 4 | Lin, Chi-Hsien | z5620437 | Fabric network, client applications, integration tests |

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

## Running the unit tests

Chaincode unit tests use a mocked chaincode stub, so no Fabric network is
required:

```bash
cd chaincode/batch-registry && npm install && npm test
cd chaincode/coldchain-compliance && npm install && npm test
```

## Submission

`readme.txt` and `addresses.txt` are the marked submission files. Produce a
clean archive straight from git, which excludes everything in `.gitignore`
as well as the `.git` directory itself:

```bash
git archive --format=zip HEAD -o proj2_3.zip
```
