# End-to-end tests — owner: person 4

These run against a live network, unlike the chaincode unit tests.

Required path:

1. Producer registers a batch
2. Custody moves producer to transporter to warehouse, and the holder marks
   the batch delivered
3. Oracle submits readings that breach the cold chain range
4. coldchain-compliance flags the (already delivered) batch through
   invokeChaincode
5. Regulator recalls it, and the recall cascades to derived batches
6. Regulator reads back the complete lifecycle history:
   CREATED → IN_TRANSIT → AT_WAREHOUSE → DELIVERED → FLAGGED → RECALLED
7. The off-chain indexer, replaying this run's blocks, serves the same story
   over HTTP

Assertions (29):

- registration: producer can register; a transporter is refused
- private data: registered via transient map; unitPrice absent from the public
  ledger; readable by a collection member; on-chain hash matches the payload
- custody: holder can transfer; status IN_TRANSIT; a non-holder is refused
- delivery: warehouse receipt yields AT_WAREHOUSE; a non-holder cannot mark
  delivery; the holder marks the batch DELIVERED
- oracle: a non-oracle is refused; a malformed rawDataHash is refused; three
  breach readings (real SHA-256 hashes) are accepted
- flagging: breach count reaches 3; the cross-chaincode call flags the batch
- recall: named batch, derived batch and grandchild are all RECALLED
- history: contains every state change; ordered oldest-first, CREATED through
  RECALLED
- indexer: /batch/:id/history answers 200; the indexed history records the
  delivery and the recall; responses carry Access-Control-Allow-Origin and
  X-Query-Time-Ms
