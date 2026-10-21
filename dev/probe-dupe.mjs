/**
 * dev/probe-dupe.mjs — 只读：同目录 v3 与 v4 两个日志是不是同一批调用？
 * 判据用 callId 集合（tool/call 的唯一标识），以及时间范围。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eachFrame, parseEvents } from '../lib/frames.mjs'
import { dshHome } from '../lib/hostinfo.js'

const root = join(dshHome(), 'sessions')
const targets = []

for (const wsName of readdirSync(root)) {
  const wsDir = join(root, wsName)
  let ids = []
  try { if (!statSync(wsDir).isDirectory()) continue; ids = readdirSync(wsDir) } catch { continue }
  for (const id of ids) {
    const dir = join(wsDir, id)
    let names = []
    try { if (!statSync(dir).isDirectory()) continue; names = readdirSync(dir) } catch { continue }
    const logs = names.filter((n) => n.startsWith('session') && n.includes('.zstd'))
    if (logs.length > 1) targets.push({ id, dir, logs })
  }
}
console.log('sessions with >1 log:', targets.length)

function facts(file) {
  const buf = readFileSync(file)
  const callIds = new Set()
  let calls = 0
  let minT = Infinity
  let maxT = 0
  let header = null
  let title = null
  eachFrame(buf, (text) => {
    const { events } = parseEvents(text)
    for (const e of events) {
      if (e.type === 'session' && !header) header = e
      else if (e.type === 'session/title' && typeof e.data?.title === 'string') title = e.data.title
      else if (e.type === 'tool/call') {
        const id = e.data?.callId
        if (typeof id === 'string') { callIds.add(id); calls++ }
        if (typeof e.time === 'number') { if (e.time < minT) minT = e.time; if (e.time > maxT) maxT = e.time }
      }
    }
  })
  return { callIds, calls, minT, maxT, header, title, bytes: buf.length }
}

const fmt = (t) => (t === Infinity || t === 0 ? '-' : new Date(t).toISOString().slice(5, 16))
for (const target of targets.slice(0, 8)) {
  console.log('')
  console.log('==', target.id.slice(0, 12), target.logs.join(' + '))
  const rows = target.logs.map((n) => ({ n, ...facts(join(target.dir, n)) }))
  for (const r of rows) console.log('  ', r.n.padEnd(24), 'calls=' + String(r.calls).padStart(4), 'uniqIds=' + String(r.callIds.size).padStart(4), fmt(r.minT), '→', fmt(r.maxT), 'title=' + JSON.stringify(String(r.title ?? '').slice(0, 20)))
  if (rows.length === 2) {
    const [a, b] = rows
    let shared = 0
    for (const id of a.callIds) if (b.callIds.has(id)) shared++
    const onlyA = a.callIds.size - shared
    const onlyB = b.callIds.size - shared
    console.log('   overlap:', shared, ' onlyIn', a.n, ':', onlyA, ' onlyIn', b.n, ':', onlyB, ' => 同源?', onlyA === 0 && onlyB === 0 ? 'YES(完全重复)' : onlyA + onlyB === 0 ? '?' : 'NO(内容不同)')
    console.log('   header same id?', a.header?.id === b.header?.id, ' version:', a.header?.version, '/', b.header?.version)
  }
}
