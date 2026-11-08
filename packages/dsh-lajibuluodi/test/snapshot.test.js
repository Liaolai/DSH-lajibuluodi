import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SnapshotCapture } from '../src/snapshot.js'
import { uniqueRoot } from './helpers.js'

test('snapshot detects deletions and ignores renames', async t => {
  const root = uniqueRoot('snapshot-ws')
  const turnDir = path.join(uniqueRoot('snapshot-data'), 'turn-1')
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(root, 'delete.txt'), 'delete')
  fs.writeFileSync(path.join(root, 'sub', 'nested.bin'), Buffer.from([1, 2, 3]))
  fs.writeFileSync(path.join(root, 'rename-old.txt'), 'rename')
  const warnings = []
  const capture = new SnapshotCapture({
    workspace: root,
    turnDir,
    sessionId: 'test',
    turn: 1,
    exclude: ['node_modules'],
    maxFiles: 1000,
    maxCopyBytes: 1024 * 1024,
    scanIntervalMs: 1000,
    beforeToolBudgetMs: 1000,
    logger: { warn: message => warnings.push(message) },
  })
  t.after(async () => {
    await capture.dispose()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(path.dirname(turnDir), { recursive: true, force: true })
  })
  await capture.start()
  await capture.ensureReady()
  fs.rmSync(path.join(root, 'delete.txt'))
  fs.rmSync(path.join(root, 'sub'), { recursive: true, force: true })
  fs.renameSync(path.join(root, 'rename-old.txt'), path.join(root, 'rename-new.txt'))
  await new Promise(resolve => setTimeout(resolve, 800))
  fs.writeFileSync(path.join(root, 'temp-created.txt'), 'temp')
  await capture.beforeTool()
  fs.rmSync(path.join(root, 'temp-created.txt'))
  const result = await capture.finalize()
  const deleted = result.deletions.map(item => item.relative).sort()
  assert.deepEqual(deleted, ['delete.txt', 'sub/nested.bin', 'temp-created.txt'], warnings.join('\n'))
  assert.deepEqual(result.moved, ['rename-old.txt'])
})

test('snapshot excludes configured directories', async t => {
  const root = uniqueRoot('snapshot-exclude-ws')
  const turnDir = path.join(uniqueRoot('snapshot-exclude-data'), 'turn-1')
  await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'a.js'), 'x')
  fs.writeFileSync(path.join(root, 'visible.txt'), 'v')
  const capture = new SnapshotCapture({
    workspace: root,
    turnDir,
    sessionId: 'test',
    turn: 1,
    exclude: ['node_modules'],
    maxFiles: 1000,
    maxCopyBytes: 1024 * 1024,
    scanIntervalMs: 1000,
    beforeToolBudgetMs: 1000,
  })
  t.after(async () => {
    await capture.dispose()
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(path.dirname(turnDir), { recursive: true, force: true })
  })
  await capture.start()
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true })
  fs.rmSync(path.join(root, 'visible.txt'))
  const result = await capture.finalize()
  assert.deepEqual(result.deletions.map(item => item.relative), ['visible.txt'])
})
