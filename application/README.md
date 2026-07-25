# Client applications — owner: person 4

Three role-specific clients built on `@hyperledger/fabric-gateway`, each using
its own identity so that the demo shows access control taking effect rather
than one super user doing everything.

| Client | Actions |
|---|---|
| `producer` | Register a batch, attach an inspection report |
| `transporter` | Hand over custody, log in-transit events |
| `regulator` | Flag a batch, query the full traceability history |

The five minute demo must be scripted end to end. Do not type commands live.

## Run the demo

```bash
cd application
npm install
./demo.sh            # ~5 minutes, with pauses for narration
./demo.sh --fast     # same steps, no pauses
```

Non-interactive: it takes no input and exits non-zero if any step fails to
behave as scripted. The batch id is generated per run, so it is re-runnable
(`RegisterBatch` rejects a duplicate id). `DEMO_BATCH=MY-ID ./demo.sh` pins it.

The demo needs the network up, the two chaincodes committed, and the demo
identities enrolled — see `network/`.

## Run a single command

One CLI, with the role as the first argument. `npm run cli -- --help` prints
the full reference; the role selects the signing identity.

```bash
npm run cli -- producer    register --batch B-1 --quantity 500
npm run cli -- producer    report   --batch B-1
npm run cli -- transporter transfer --batch B-1 --to Org2MSP
npm run cli -- transporter log      --batch B-1 --location "Goulburn NSW"
npm run cli -- regulator   history  --batch B-1
npm run cli -- regulator   holdings --holder Org2MSP
npm run cli -- regulator   flag     --batch B-1 --reason "Inspection failure"
npm run cli -- regulator   recall   --batch B-1
```

Two flags exist for demonstrating access control rather than for normal use:

- `--as NAME` signs with a different enrolled identity, so a producer command
  can be pointed at a transporter certificate and refused.
- `--expect-rejection` inverts the exit code: a policy rejection becomes
  success, and an unexpected **acceptance** becomes failure. The demo's
  "this must be refused" steps use it, so a missing guard fails the run
  instead of passing quietly.

## Identities

Each role signs as its own Fabric CA identity, enrolled by
`network/registerIdentities.sh`, with the role carried as a signed ABAC
attribute on the certificate:

| Role | Identity | Attribute |
|---|---|---|
| producer | `producer1` | `role=producer` |
| transporter | `transporter1` | `role=transporter` |
| regulator | `regulator1` | `role=regulator` |

`FABRIC_USER` overrides all of them. The gateway connection itself is **not**
reimplemented here: it is reused from `@comp6452/offchain-shared` through a
`file:` dependency, so the whole repository has one place that dials a peer.

## Layout

| File | Contents |
|---|---|
| `src/run.ts` | CLI entry point, dispatch and exit codes |
| `src/producer.ts` | RegisterBatch (with transient private data), report verify |
| `src/transporter.ts` | TransferCustody, off-chain transit logging |
| `src/regulator.ts` | Flag, recall, history and holdings queries |
| `src/errors.ts` | Turns a gRPC `EndorseError` into a readable rejection |
| `src/args.ts`, `src/format.ts` | Pure argument parsing and output rendering |
| `demo.sh` | The scripted five-minute demo |

`npm test` covers the pure logic — argument parsing, output formatting, error
translation and CLI dispatch. The network paths are verified by running
`demo.sh` against the live network, which is stronger evidence than a mocked
peer would be.
