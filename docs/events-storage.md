# `events` log — growth, storage, and rebuild cost (issue #75)

The `events` table is append-only and is never pruned — that rule is correct
and stays. This document is the growth plan the rule needs: how big the log
gets per unit of DAO activity, what the secondary indexes cost, how long a
`npm run reindex` takes at scale, and the concrete threshold at which
partitioning becomes worth its migration cost.

> **Measure on your own hardware.** `npm run bench:events` seeds a throwaway
> database with a realistic symbol mix and prints heap/index sizes, bytes per
> row, and `reindexFromEventLog()` wall-time at 10k / 100k / 1M events. The
> figures below are a **model** derived from the column types and the observed
> event shapes — run the harness for real numbers before choosing any design.

## Continuous benchmarking (CI)

`.github/workflows/bench-events.yml` runs `npm run bench:events` daily and on
any pull request that touches `src/indexer/`, `src/db/schema.sql`, or
`src/db/migrations/`, against a throwaway Postgres service container. Results
(raw JSON and a comparison table) land in that run's job summary, so a
reviewer sees them without downloading an artifact.

The run is compared against a committed baseline,
[`docs/events-storage-baseline.json`](events-storage-baseline.json), by
`scripts/check-bench-regression.ts`. A regression beyond threshold (bytes/row
or the GIN index size growing >15–20%, fold throughput dropping by more than
2x) is surfaced as a `::warning::` annotation and a highlighted job-summary
banner — it does **not** fail the build. Shared GitHub-hosted runners are
noisy enough, especially on wall-clock timing, that a hard failure would
block unrelated PRs on false positives; a loud warning gets it in front of a
reviewer instead. Update the baseline (re-run the bench at the same scale and
commit the new `docs/events-storage-baseline.json`) as a deliberate step
whenever a change intentionally moves these numbers.

The baseline is measured, not modeled — 20,000 events, real Postgres 16:

| metric | value |
|---|---|
| bytes/row (`pg_total_relation_size / count(*)`) | 578 |
| `events_data_gin_idx` size | 2.6 MB |
| `events_pkey` size | 984 kB |
| `events_symbol_idx` size | 176 kB |
| `events_entity_id_idx` size | 328 kB |
| `events_contract_id_idx` size | 160 kB |
| `reindexFromEventLog` throughput | ~1.0 ms/event (~1,000 events/s) |
| distinct symbols / contract_ids in the seed mix | 16 / 2 |

This one measured point is consistent with the row-size model below (~578 vs.
a modeled ~420–720 bytes/row) and sits well inside modeled reindex throughput.
It does not replace the 1M-row model — that scale is out of budget for a
per-PR CI job — but it's now a real, continuously-checked data point rather
than an estimate nobody re-runs.

## Row-size model

Per `events` row (`src/db/schema.sql`):

| Column | Type | Typical bytes |
|---|---|---|
| `id` | `TEXT` (Soroban paging id, ~28 chars) | ~30 |
| `ledger` | `BIGINT` | 8 |
| `closed_at` | `TIMESTAMPTZ` | 8 |
| `contract_id` | `TEXT` (`C…` strkey, 56 chars) | ~58 |
| `symbol` | `TEXT` (≤10 chars) | ~10 |
| `topics` | `JSONB` (symbol + one address) | ~80 |
| `data` | `JSONB` (2–4 primitives) | ~120 |
| `tx_hash` | `TEXT` (64 hex) or NULL | ~66 |
| `created_at` | `TIMESTAMPTZ` | 8 |
| tuple header + null bitmap + line pointer | | ~30 |

**≈ 420–460 bytes/row heap**, plus indexes:

| Index | Purpose | Bytes/row (model) |
|---|---|---|
| `events_pkey` (`id`) | primary key, `ORDER BY … id` keyset tiebreak | ~50 |
| `events_symbol_idx` (`symbol`) | `?symbol=` filter on `/api/events` | ~25 |
| `events_ledger_idx` (`ledger`) | `ORDER BY ledger DESC`, reindex scan order | ~25 |
| `events_contract_id_idx` (`contract_id`) | `?contract=` filter (rare) | ~40 |
| `events_entity_id_idx` (`data->>0`) | loan/treasury timeline lookups | ~35 |
| `events_data_gin_idx` (`data`) | member activity JSONB containment | workload-dependent, ~70–120 |

**≈ 660–720 bytes/row all-in.** `topics`/`data` are small enough to stay
inline (below the ~2 KB TOAST threshold), so there is no TOAST traffic in
normal operation.

### Growth per unit of activity

| DAO activity | events emitted | log growth |
|---|---|---|
| one loan, full lifecycle (req → votes ×N → appr → repayments ×M) | ~6–15 | ~4–9 KB |
| one member join + first stake | 2 | ~1.2 KB |
| one treasury proposal, executed | ~5 | ~3 KB |
| **1,000 loans of lifetime activity** | ~10k | **~6 MB** |
| **100k events** | — | **~65–72 MB** |
| **1M events** | — | **~650–720 MB** |

A testnet DAO reaches maybe tens of thousands of events. A busy mainnet DAO
running for years lands in the low millions. **This is not a scale problem
yet, and won't be soon.**

## Rebuild cost

`reindexFromEventLog()` keyset-pages every row (`ORDER BY ledger ASC, id ASC` —
served by `events_ledger_idx`) in bounded batches and folds it in one
transaction. Its Node memory stays bounded, but its transaction duration and
database work remain `O(total history)`. Modelled fold throughput is a few tens
of thousands of events/second (pure Postgres round-trips in `applyEvent`, no
network):

| events | modelled reindex time |
|---|---|
| 10k | < 1 s |
| 100k | ~3–8 s |
| 1M | ~40–90 s |
| 5M | ~4–8 min |

Because the transaction spans the full rebuild, it can delay cleanup of dead
tuples even though the reader itself is streamed. Schedule a large reindex as
maintenance and monitor its age alongside autovacuum activity.

## Index review

- **`events_ledger_idx`** — earns its cost. Serves both the API sort and the
  reindex scan order. Keep.
- **`events_symbol_idx`** — earns its cost. `?symbol=` is a common filter and
  symbol cardinality is low (~30), so it's a cheap, effective partial scan.
  Keep.
- **`events_contract_id_idx`** — added for `?contract=` (issue #16), which is
  only used when one database has held more than one `CONTRACT_ID`
  (`resetForContractChange`). Cardinality is 1 for almost every deployment,
  making the index dead weight on writes. **Recommendation:** measure
  `count(DISTINCT contract_id)` in production (the harness prints it); if it's
  1, drop the index and let `?contract=` fall back to a seq scan on the rare
  admin query that uses it. Not dropped in this change — it's a one-line
  migration once the measurement confirms it.

## Recommendation: no schema change yet

At the current and near-term scale, partitioning / column compression / an
archival tier would all be **speculative** — they add migration risk and
operational surface to solve a problem no deployment has. The append-only
guarantee and `reindex` are fine as they are.

### Revisit threshold

Partition `events` by `ledger` range when **any** of:

- `events` exceeds **~5 million rows** (~3 GB all-in), or
- a full `npm run reindex` exceeds **~90 seconds**, or
- `pg_total_relation_size('events')` exceeds **~5 GB**.

Check with the harness or:

```sql
SELECT count(*), pg_size_pretty(pg_total_relation_size('events')) FROM events;
```

## Migration plan for when the threshold is hit

Converting a large non-partitioned `events` to a partitioned table without a
maintenance window:

1. **New parent.** `CREATE TABLE events_p (LIKE events INCLUDING ALL)
   PARTITION BY RANGE (ledger);` Create partitions covering all existing
   ledgers plus a generous head partition (e.g. 1M ledgers each).
2. **Backfill in batches.** `INSERT INTO events_p SELECT * FROM events WHERE
   ledger >= $lo AND ledger < $hi` per range, committing between batches. The
   log is append-only, so already-copied ranges never change under you.
3. **Cut over.** In one transaction: copy the tail (rows added during
   backfill), `ALTER TABLE events RENAME TO events_old`, `ALTER TABLE events_p
   RENAME TO events`. Recreate `events_symbol_idx` / `events_ledger_idx` /
   `events_contract_id_idx` on the partitioned parent (they propagate to
   partitions).
4. **`resetForContractChange` compatibility.** That path preserves `events`
   while wiping derived tables so one database can hold multiple deployments'
   history — partitioning by `ledger` (not `contract_id`) keeps this working
   unchanged; a multi-contract database just has interleaved ledgers within
   each partition, which is fine.
5. **`reindex` compatibility.** `reindexFromEventLog`'s `SELECT … ORDER BY
   ledger ASC, id ASC` is unchanged — Postgres plans it as an ordered append
   across partitions. Byte-identical derived state, verified by
   `test/events-storage.test.ts`.
6. **Drop `events_old`** after a soak period.

Ship this as its own PR with the batch sizes and cut-over timing measured
against a production-sized copy — it is the hard part and deserves its own
review.
