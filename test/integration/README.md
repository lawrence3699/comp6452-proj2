# End-to-end tests — owner: person 4

These run against a live network, unlike the chaincode unit tests.

Required path:

1. Producer registers a batch
2. Custody moves producer to transporter to warehouse
3. Oracle submits readings that breach the cold chain range
4. coldchain-compliance flags the batch through invokeChaincode
5. Regulator reads back the complete history, including the flag
