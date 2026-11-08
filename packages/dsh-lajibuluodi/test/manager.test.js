import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LajibuluodiManager } from '../src/manager.js'
import { normalizeOptions } from '../src/options.js'
import { cleanRecycle, canUseRecycleBin, uniqueRoot, waitForRecycleEntry } from './helpers.js'

const maybe = process.platform === 'win32' ? test : test.skip

maybe('manager packages one turn and restores it', async t => {
  if (!(await canUseRecycleBin())) {
    t.skip('Recycle Bin is unavailable on this host')
    return
  }
  const root = uniqueRoot('manager-ws')
  const data = uniqueRoot('manager-data')
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(data, { recursive: true, force: true })
  await fsp.mkdir(path.join(root, 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(root, 'drop.txt'), 'drop me')
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep me')
  fs.writeFileSync(path.join(root, 'tmp', 'old.bin'), Buffer.from([1, 2, 3]))

  const logger = { info: () => {}, warn: () => {} }
  const manager = new LajibuluodiManager({
    ctx: {},
    options: normalizeOptions({ dataDir: data, maxFiles: 1000, scanIntervalMs: 1000, beforeToolBudgetMs: 1000 }),
    logger,
  })
  const session = { id: 'session-manager-test', header: { cwd: root }, log: [] }
  let record
  let recyclePath
  t.after(async () => {
    if (record) await cleanRecycle(record.zipPath)
    await manager.dispose()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(data, { recursive: true, force: true })
  })

  manager.onSessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '整理登录页' }] } })
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await new Promise(resolve => setTimeout(resolve, 500))
  const capture = manager.captureFor(session, 1)
  assert.ok(capture, 'capture exists')
  await capture.ensureReady()

  fs.rmSync(path.join(root, 'drop.txt'))
  fs.writeFileSync(path.join(root, 'tmp', 'fresh.png'), Buffer.from([9, 9, 9]))
  await new Promise(resolve => setTimeout(resolve, 400))
  await manager.beforeTool({ agent: { session } })
  fs.rmSync(path.join(root, 'tmp', 'fresh.png'))
  await new Promise(resolve => setTimeout(resolve, 200))

  await manager.finishTurn(session, 1)
  const resolved = path.resolve(root)
  const location = await manager.resolveDataRoot(resolved)
  const store = await manager.storeFor(location, resolved)
  const records = await store.list(5)
  assert.equal(records.length, 1)
  record = records[0]
  assert.equal(record.recycle, 'sent')
  assert.equal(record.fileCount, 2)
  assert.equal(fs.existsSync(record.zipPath), false)
  const entry = await waitForRecycleEntry(record.zipPath)
  assert.ok(entry, 'recycle entry exists')
  recyclePath = entry

  const text = await manager.restorePackage(record, store, true)
  assert.match(text, /恢复完成: 2/)
  assert.equal(fs.readFileSync(path.join(root, 'drop.txt'), 'utf8'), 'drop me')
  assert.deepEqual([...fs.readFileSync(path.join(root, 'tmp', 'fresh.png'))], [9, 9, 9])

  const status = await manager.runCommand('status', session)
  assert.match(status, /DSH-lajibuluodi/)
  const list = await manager.runCommand('list', session)
  assert.match(list, /drop|fresh|DSH-/)
})
