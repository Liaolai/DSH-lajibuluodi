import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LajibuluodiManager } from '../src/manager.js'
import { normalizeOptions } from '../src/options.js'
import { cleanRecycle, uniqueRoot } from './helpers.js'

const maybe = process.platform === 'win32' ? test : test.skip

maybe('manager packages each turn separately and skips empty turns', async t => {
  const root = uniqueRoot('multiturn-ws')
  const data = uniqueRoot('multiturn-data')
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(data, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b')

  const manager = new LajibuluodiManager({
    ctx: {},
    options: normalizeOptions({ dataDir: data, maxFiles: 1000, scanIntervalMs: 1000 }),
    logger: { info: () => {}, warn: () => {} },
  })
  const session = { id: 'session-multiturn', header: { cwd: root }, log: [] }
  const records = []
  t.after(async () => {
    for (const record of records) await cleanRecycle(record.zipPath)
    await manager.dispose()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(data, { recursive: true, force: true })
  })

  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await new Promise(resolve => setTimeout(resolve, 400))
  fs.rmSync(path.join(root, 'a.txt'))
  await manager.finishTurn(session, 1)

  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  await new Promise(resolve => setTimeout(resolve, 400))
  fs.rmSync(path.join(root, 'b.txt'))
  await manager.finishTurn(session, 2)

  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
  await new Promise(resolve => setTimeout(resolve, 300))
  await manager.finishTurn(session, 3)

  const resolved = path.resolve(root)
  const location = await manager.resolveDataRoot(resolved)
  const store = await manager.storeFor(location, resolved)
  records.push(...await store.list(10))
  assert.equal(records.length, 2)
  const byTurn = new Map(records.map(record => [record.turn, record]))
  assert.equal(byTurn.get(1).fileCount, 1)
  assert.equal(byTurn.get(2).fileCount, 1)
  assert.equal(byTurn.has(3), false)
  assert.match(byTurn.get(1).name, /T1\.zip$/)
  assert.match(byTurn.get(2).name, /T2\.zip$/)
  assert.equal(fs.existsSync(byTurn.get(1).zipPath), false)
  assert.equal(fs.existsSync(byTurn.get(2).zipPath), false)
})
