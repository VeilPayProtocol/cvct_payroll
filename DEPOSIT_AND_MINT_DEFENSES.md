# Deposit And Mint Defenses

The deposit path is now a staged-commit flow.

That means the current defense model is:
- request records intent only
- callback stages confidential mint state only
- settlement transfers backing assets and commits canonical state together

The share-minting math still uses virtual offsets to defend the empty-vault / donation-style rounding edge case:

`shares = floor(amount * (supply + VS) / (assets + VA))`

Current offsets:
- `VA = 1`
- `VS = 1`

For the full current explanation, see:
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/flows.md`](docs/flows.md)

This file remains as a short topical note so older references do not point to a stale refund-based deposit model.
