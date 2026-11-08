import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LajibuluodiManager } from '../src/manager.js'
import { normalizeOptions } from '../src/options.js'
import { findRecycleEntry } from '../src/recycle.js'
import { uniqueRoot } from './helpers.js'

const maybe = process.platform === 'win32' ? test : test.skip

maybe('review mode keeps the package in the outbox and never touches the Recycle Bin', async t => {
  const root = uniqueRoot('review-ws')
  const data = uniqueRoot('review-data')
  await fsp.mkdir(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'drop.txt'), 'drop me')
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep me')

  const manager = new LajibuluodiManager({
    ctx: {},
    options: normalizeOptions({
      dataDir: data,
      recycle: false,
      maxFiles: 1000,
      scanIntervalMs: 1000,
      beforeToolBudgetMs: 1000,
    }),
    logger: { info: () => {}, warn: () => {} },
  })
  const session = { id: 'session-review-test', header: { cwd: root }, log: [] }
  t.after(async () => {
    await manager.dispose()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(data, { recursive: true, force: true })
  })

  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await new Promise(resolve => setTimeout(resolve, 500))
  fs.rmSync(path.join(root, 'drop.txt'))
  await new Promise(resolve => setTimeout(resolve, 400))
  await manager.finishTurn(session, 1)

  const resolved = path.resolve(root)
  const location = await manager.resolveDataRoot(resolved)
  const store = await manager.storeFor(location, resolved)
  const records = await store.list(5)
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.recycle, 'kept')
  assert.equal(fs.existsSync(record.zipPath), true, 'ZIP must remain in the outbox')
  assert.equal(await findRecycleEntry(record.zipPath), undefined, 'no Recycle Bin entry in review mode')

  const text = await manager.restorePackage(record, store, true)
  assert.match(text, /恢复完成: 1/)
  assert.equal(fs.readFileSync(path.join(root, 'drop.txt'), 'utf8'), 'drop me')
})
