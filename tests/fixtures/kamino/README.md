# Kamino Local Test Artifacts

Place the pre-fetched local validator binaries in this directory before running
the Kamino adapter suite:

- `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.so`
- `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.so`
- `accounts/global_config.json`

These binaries should be fetched manually from the target deployment you want to
test against and then loaded into the local validator before running:

```bash
CVCT_RUN_KAMINO_LOCAL=1 arcium test
```

Recommended validator preload entries for local-only testing:

```toml
[[test.genesis]]
address = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd"
program = "tests/fixtures/kamino/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.so"

[[test.genesis]]
address = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
program = "tests/fixtures/kamino/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.so"

[[test.validator.account]]
address = "BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX"
filename = "tests/fixtures/kamino/accounts/global_config.json"
```
