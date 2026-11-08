import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findRecycleEntry } from '../src/recycle.js'

export async function makeWorkspace(root) {
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true })
  return root
}

export async function cleanRecycle(originalPath) {
  const entry = await findRecycleEntry(originalPath)
  if (entry === undefined) return
  await fsp.rm(entry.dataPath, { force: true }).catch(() => {})
  await fsp.rm(entry.metadataPath, { force: true }).catch(() => {})
}

export function uniqueRoot(prefix) {
  return path.join(os.tmpdir(), 'dsh-lajibuluodi-tests', prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))
}
