# End-to-end tests — owner: person 4

These run against a live network, unlike the chaincode unit tests.

Required path:

1. Producer registers a batch
2. Custody moves producer to transporter to warehouse
3. Oracle submits readings that breach the cold chain range
4. coldchain-compliance flags the batch through invokeChaincode
5. Regulator reads back the complete history, including the flag

## Running

Requires a live network with both chaincodes deployed and the four demo
identities registered — see `network/README.md`:

```bash
cd network/scripts
export FABRIC_SAMPLES_PATH=~/fabric-samples
./up.sh
./deployAll.sh
./setupDemoIdentities.sh
```

Then, from this directory:

```bash
npm install
npm test
```

Each `it` block depends on the state left by the ones before it (same
`batchId` throughout), so they run as one ordered scenario rather than
independent cases — this is what makes it an end-to-end test rather than a
unit test.

If your identities live somewhere other than `network/identities/`, point
at them individually, e.g. `PRODUCER1_ENV_PATH=/path/to/producer1.env npm
test`.
