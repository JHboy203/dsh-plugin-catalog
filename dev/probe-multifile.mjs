/**
 * dev/probe-multifile.mjs — 只读：一个会话目录里会不会有多个会话日志文件？
 * 若有，按 sid 合并就会把同一批调用算两遍 —— 必须先证明再决定去重口径。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceRoot, dshHome } from '../lib/hostinfo.js'

const root = join(dshHome(), 'sessions')
const ws = workspaceRoot()
console.log('workspace:', ws)
console.log('sessions root:', root)

let dirs = 0
let multi = 0
const samples = []
for (const wsName of readdirSync(root)) {
  const wsDir = join(root, wsName)
  let ids = []
  try { if (!statSync(wsDir).isDirectory()) continue; ids = readdirSync(wsDir) } catch { continue }
  for (const id of ids) {
    const dir = join(wsDir, id)
    let names = []
    try { if (!statSync(dir).isDirectory()) continue; names = readdirSync(dir) } catch { continue }
    const logs = names.filter((n) => n.startsWith('session') && n.includes('.zstd'))
    if (logs.length === 0) continue
    dirs++
    if (logs.length > 1) {
      multi++
      if (samples.length < 8) samples.push({ id, logs: logs.map((n) => ({ n, kb: Math.round(statSync(join(dir, n)).size / 1024) })) })
    }
  }
}
console.log('session dirs with logs:', dirs, ' with >1 log file:', multi)
for (const s of samples) console.log(' ', s.id.slice(0, 12), JSON.stringify(s.logs))
