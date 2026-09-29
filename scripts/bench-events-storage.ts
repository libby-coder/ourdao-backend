/**
 * Issue #75 — measure the `events` log's real storage and rebuild cost.
 *
 * Seeds a database with a realistic symbol distribution and reports, at
 * several scales:
 *   - heap size, per-row bytes, TOAST size
 *   - each secondary index's size (and its rows-per-scan selectivity estimate)
 *   - `reindexFromEventLog()` wall-clock time
 *
 * Run against a THROWAWAY database — it TRUNCATEs `events` and every derived
 * table:
 *
 *   DATABASE_URL=postgres://ourdao:ourdao@localhost:5432/ourdao_bench \
 *     npm run bench:events -- 10000 100000 1000000
 *
 * Numbers land in docs/events-storage.md. Re-run when the schema, the event
 * catalog, or the reindex path changes.
 *
 * Set BENCH_JSON_OUT=<path> to also write a machine-readable JSON array of
 * per-scale results (issue #200 — this is what CI parses to build the job
 * summary and check for regressions against docs/events-storage-baseline.json).
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pool } from '../src/db/index.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { DERIVED_TABLES } from '../src/indexer/derived-tables.js'
import { EVENT_FIELDS } from '../src/stellar/events.js'

// Rough production mix: loan lifecycle events dominate, membership churn is
// steady, admin events are rare. Weights are relative, not percentages.
const SYMBOL_MIX: Array<[keyof typeof EVENT_FIELDS, number]> = [
  ['loan_req', 20],
  ['loan_vote', 30],
  ['loan_appr', 12],
  ['loan_rpy', 18],
  ['loan_dflt', 2],
  ['joined', 8],
  ['exited', 3],
  ['staked', 6],
  ['unstaked', 4],
  ['claimed', 5],
  ['interest', 3],
  ['tre_prop', 2],
  ['tre_vote', 4],
  ['tre_exec', 1],
  ['name_reg', 1],
  ['admin_add', 1],
]

const WEIGHTED: Array<keyof typeof EVENT_FIELDS> = SYMBOL_MIX.flatMap(([s, w]) =>
  Array<keyof typeof EVENT_FIELDS>(w).fill(s)
)

const CONTRACT_IDS = [
  'CBENCH0000000000000000000000000000000000000000000000000000001',
  'CBENCH0000000000000000000000000000000000000000000000000000002',
]

function fakeAddress(n: number): string {
  return 'G' + String(n).padStart(55, 'A').slice(0, 55)
}

function sampleEvent(seq: number): {
  id: string
  ledger: number
  closedAt: string
  contractId: string
  symbol: string
  topics: unknown[]
  data: unknown[]
} {
  const symbol = WEIGHTED[seq % WEIGHTED.length]!
  const fieldNames = EVENT_FIELDS[symbol] as readonly string[]
  const data = fieldNames.map((name) => {
    if (name.includes('id') || name === 'proposal_id') return (seq % 500) + 1
    if (name === 'support' || name === 'active' || name === 'private') return seq % 2 === 0
    if (name.includes('member') || name.includes('borrow') || name.includes('voter') || name === 'owner' || name === 'destination')
      return fakeAddress(seq % 2000)
    if (name === 'name') return `dao-name-${seq % 300}`
    return String(1_000_000 + (seq % 9_000_000)) // i128-ish amount
  })
  const ledger = 1000 + Math.floor(seq / 4)
  return {
    id: `${String(ledger).padStart(10, '0')}-${String(seq % 10000).padStart(6, '0')}-${randomUUID().slice(0, 8)}`,
    ledger,
    closedAt: new Date(1_760_000_000_000 + seq * 5000).toISOString(),
    contractId: CONTRACT_IDS[seq % CONTRACT_IDS.length]!,
    symbol,
    topics: [symbol, fakeAddress(seq % 2000)],
    data,
  }
}

async function seed(target: number, batch = 2000): Promise<void> {
  let done = 0
  while (done < target) {
    const n = Math.min(batch, target - done)
    const values: string[] = []
    const params: unknown[] = []
    for (let i = 0; i < n; i++) {
      const ev = sampleEvent(done + i)
      const b = i * 9
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`)
      params.push(
        ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
        JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash, ev.decodeError
      )
    }
    await pool.query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash, decode_error)
       VALUES ${values.join(',')} ON CONFLICT (id) DO NOTHING`,
      params
    )
    done += n
  }
}

// pg_size_pretty is nice for a human reading the log, but issue #200's CI
// regression check needs raw byte counts to do arithmetic on — so this
// queries bytes directly and formats them the same way for console output,
// rather than parsing pg_size_pretty's text back apart.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface SizeReport {
  totalBytes: number
  heapBytes: number
  toastBytes: number
  rows: number
  bytesPerRow: number
  indexBytes: Record<string, number>
  distinctSymbols: number
  distinctContracts: number
}

async function reportSizes(): Promise<SizeReport> {
  const { rows: [heap] } = await pool.query<{ total_bytes: number; heap_bytes: number; toast_bytes: number; rows: number }>(
    `SELECT pg_total_relation_size('events') AS total_bytes,
            pg_relation_size('events') AS heap_bytes,
            COALESCE(pg_total_relation_size(reltoastrelid), 0) AS toast_bytes,
            (SELECT count(*) FROM events) AS rows
       FROM pg_class WHERE relname = 'events'`
  )
  const bytesPerRow = heap.rows > 0 ? Math.round(heap.total_bytes / heap.rows) : 0
  console.log(
    `  events: total=${formatBytes(heap.total_bytes)} heap=${formatBytes(heap.heap_bytes)} ` +
      `toast=${formatBytes(heap.toast_bytes)} rows=${heap.rows}`
  )
  console.log(`  bytes/row (incl. indexes + toast): ${bytesPerRow}`)

  const idx = await pool.query<{ indexname: string; bytes: number }>(
    `SELECT indexname, pg_relation_size(indexname::regclass) AS bytes
       FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname`
  )
  const indexBytes: Record<string, number> = {}
  for (const r of idx.rows) {
    indexBytes[r.indexname] = r.bytes
    console.log(`  index ${r.indexname}: ${formatBytes(r.bytes)}`)
  }

  const sel = await pool.query<{ symbol_card: number; contract_card: number }>(
    `SELECT
       (SELECT count(DISTINCT symbol) FROM events) AS symbol_card,
       (SELECT count(DISTINCT contract_id) FROM events) AS contract_card`
  )
  const { symbol_card: distinctSymbols, contract_card: distinctContracts } = sel.rows[0]!
  console.log(
    `  distinct symbols=${distinctSymbols}, distinct contract_ids=${distinctContracts} ` +
      `(events_contract_id_idx selectivity — see docs/events-storage.md)`
  )

  return {
    totalBytes: heap.total_bytes,
    heapBytes: heap.heap_bytes,
    toastBytes: heap.toast_bytes,
    rows: heap.rows,
    bytesPerRow,
    indexBytes,
    distinctSymbols,
    distinctContracts,
  }
}

interface BenchResult extends SizeReport {
  targetEvents: number
  reindexMs: number
  reindexMsPerEvent: number
}

async function main(): Promise<void> {
  const scales = (process.argv.slice(2).map(Number).filter((n) => n > 0))
  const targets = scales.length ? scales : [10_000, 100_000, 1_000_000]
  const results: BenchResult[] = []

  await pool.query(`TRUNCATE ${['events', ...DERIVED_TABLES].join(', ')} RESTART IDENTITY CASCADE`)
  await pool.query(
    `INSERT INTO dao_totals (id) VALUES (1) ON CONFLICT (id) DO UPDATE
       SET interest_collected = 0, principal_lent = 0, principal_repaid = 0, value_defaulted = 0`
  )

  let seeded = 0
  for (const target of targets.sort((a, b) => a - b)) {
    await seed(target - seeded)
    seeded = target
    await pool.query('VACUUM ANALYZE events')

    console.log(`\n=== ${target.toLocaleString()} events ===`)
    const sizes = await reportSizes()

    const t0 = performance.now()
    const { events } = await reindexFromEventLog()
    const reindexMs = performance.now() - t0
    const reindexMsPerEvent = reindexMs / target
    console.log(`  reindexFromEventLog: ${(reindexMs / 1000).toFixed(1)}s for ${events.toLocaleString()} events (${reindexMsPerEvent.toFixed(2)} ms/event)`)

    results.push({ ...sizes, targetEvents: target, reindexMs, reindexMsPerEvent })
  }

  const jsonOut = process.env.BENCH_JSON_OUT
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2))
    console.log(`\nWrote JSON results to ${jsonOut}`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error('[bench:events] failed:', err)
  process.exit(1)
})
