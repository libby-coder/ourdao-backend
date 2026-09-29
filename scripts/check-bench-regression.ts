/**
 * Issue #200 — compare a `bench:events` run against the committed baseline
 * and surface a regression loudly in the CI job summary.
 *
 * Policy: warn, never fail the build. GitHub-hosted runners share physical
 * hardware with other jobs, and this benchmark's timing numbers (bytes/row
 * and index sizes are deterministic; `reindexMsPerEvent` is not) are noisy
 * enough on shared runners that a hard failure would block unrelated PRs on
 * false positives. A loud, impossible-to-miss warning — a `::warning::`
 * annotation plus a highlighted job-summary section — gets a regression in
 * front of a reviewer without making CI flaky. Raise the failure bar later
 * if the noise turns out to be smaller than expected in practice.
 *
 *   BENCH_JSON_OUT=/tmp/bench-out.json npm run bench:events -- 20000
 *   npx tsx scripts/check-bench-regression.ts /tmp/bench-out.json
 */
import { readFileSync, appendFileSync } from 'node:fs'

interface BenchResult {
  targetEvents: number
  bytesPerRow: number
  indexBytes: Record<string, number>
  reindexMsPerEvent: number
}
interface BenchFile {
  ranAt: string
  results: BenchResult[]
}

// Deterministic metrics get a tight threshold; the timing metric gets a wide
// one to absorb shared-runner noise (see policy note above).
const THRESHOLDS = {
  bytesPerRow: 0.15,
  ginIndexBytes: 0.2,
  reindexMsPerEvent: 0.5,
}

function pctChange(before: number, after: number): number {
  return before === 0 ? (after === 0 ? 0 : Infinity) : (after - before) / before
}

function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%`
}

function main(): void {
  const [currentPath, baselinePath = 'docs/events-storage-baseline.json'] = process.argv.slice(2)
  if (!currentPath) {
    console.error('usage: check-bench-regression.ts <current-results.json> [baseline.json]')
    process.exit(2)
  }

  const current: BenchFile = JSON.parse(readFileSync(currentPath, 'utf8'))
  const baseline: BenchFile = JSON.parse(readFileSync(baselinePath, 'utf8'))

  const lines: string[] = []
  const warnings: string[] = []
  lines.push('### Events-storage benchmark')
  lines.push('')
  lines.push(`Baseline captured ${baseline.ranAt}. This run: ${current.ranAt}.`)
  lines.push('')
  lines.push('| events | metric | baseline | current | change |')
  lines.push('| ---: | --- | ---: | ---: | ---: |')

  for (const curr of current.results) {
    const base = baseline.results.find((r) => r.targetEvents === curr.targetEvents)
    if (!base) {
      lines.push(`| ${curr.targetEvents.toLocaleString()} | *(no baseline at this scale)* | — | — | — |`)
      continue
    }

    const rowChange = pctChange(base.bytesPerRow, curr.bytesPerRow)
    const flagRow = rowChange > THRESHOLDS.bytesPerRow
    lines.push(
      `| ${curr.targetEvents.toLocaleString()} | bytes/row | ${base.bytesPerRow} | ${curr.bytesPerRow} | ${flagRow ? '⚠️ ' : ''}${fmtPct(rowChange)} |`
    )
    if (flagRow) warnings.push(`bytes/row grew ${fmtPct(rowChange)} at ${curr.targetEvents} events (baseline ${base.bytesPerRow}, now ${curr.bytesPerRow})`)

    const ginBase = base.indexBytes.events_data_gin_idx
    const ginCurr = curr.indexBytes.events_data_gin_idx
    if (ginBase !== undefined && ginCurr !== undefined) {
      const ginChange = pctChange(ginBase, ginCurr)
      const flagGin = ginChange > THRESHOLDS.ginIndexBytes
      lines.push(
        `| ${curr.targetEvents.toLocaleString()} | events_data_gin_idx bytes | ${ginBase} | ${ginCurr} | ${flagGin ? '⚠️ ' : ''}${fmtPct(ginChange)} |`
      )
      if (flagGin) warnings.push(`events_data_gin_idx size grew ${fmtPct(ginChange)} at ${curr.targetEvents} events (baseline ${ginBase}, now ${ginCurr})`)
    }

    const msChange = pctChange(base.reindexMsPerEvent, curr.reindexMsPerEvent)
    const flagMs = msChange > THRESHOLDS.reindexMsPerEvent
    lines.push(
      `| ${curr.targetEvents.toLocaleString()} | reindex ms/event | ${base.reindexMsPerEvent.toFixed(3)} | ${curr.reindexMsPerEvent.toFixed(3)} | ${flagMs ? '⚠️ ' : ''}${fmtPct(msChange)} |`
    )
    if (flagMs) warnings.push(`reindex throughput dropped: ms/event grew ${fmtPct(msChange)} at ${curr.targetEvents} events (baseline ${base.reindexMsPerEvent.toFixed(3)}, now ${curr.reindexMsPerEvent.toFixed(3)})`)
  }

  lines.push('')
  if (warnings.length) {
    lines.push(`> ⚠️ **${warnings.length} metric(s) regressed beyond threshold.** This does not fail the build (see policy note in ` +
      '`scripts/check-bench-regression.ts`) — a human should look at it.')
    lines.push('')
    for (const w of warnings) lines.push(`> - ${w}`)
  } else {
    lines.push('No metric regressed beyond threshold.')
  }

  const report = lines.join('\n')
  console.log(report)

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `\n${report}\n`)

  for (const w of warnings) console.log(`::warning::events-storage benchmark regression — ${w}`)

  // Policy: warn, never fail — see module doc comment.
  process.exit(0)
}

main()
