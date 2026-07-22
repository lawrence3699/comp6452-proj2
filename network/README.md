# Network — owner: person 4

Holds the scripts that bring up the Fabric test network, create the channel
and drive the chaincode lifecycle.

Priority for days 1 and 2: get two *empty* chaincodes through the full
package / install / approve / commit lifecycle. Do not wait for business
logic — the lifecycle is the risky part, not the code.

`collections_config.json` defines the private data collection that holds
commercially sensitive batch details. It is referenced at commit time with
`--collections-config`.
