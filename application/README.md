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
