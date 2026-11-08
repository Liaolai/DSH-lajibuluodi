import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findRecycleEntry, sendToRecycleBin } from '../src/recycle.js'

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

/**
 * Wait briefly for the Recycle Bin metadata to appear. Some Windows hosts
 * publish the $I/$R pair asynchronously after the shell delete returns.
 * @param {string} originalPath
 * @param {number} [timeoutMs]
 */
export async function waitForRecycleEntry(originalPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const entry = await findRecycleEntry(originalPath)
    if (entry !== undefined) return entry
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

let recycleAvailable
/**
 * Probe whether this host really has a working Recycle Bin. CI images and
 * locked-down servers may disable it, in which case Shell delete silently
 * becomes a permanent delete.
 */
export async function canUseRecycleBin() {
  if (recycleAvailable !== undefined) return recycleAvailable
  if (process.platform !== 'win32') {
    recycleAvailable = false
    return false
  }
  const probe = path.join(os.tmpdir(), 'dsh-lajibuluodi-recycle-probe-' + Date.now() + '.txt')
  try {
    await fsp.writeFile(probe, 'probe')
    await sendToRecycleBin(probe)
    const entry = await waitForRecycleEntry(probe, 3_000)
    if (entry === undefined) {
      recycleAvailable = false
      return false
    }
    await fsp.rm(entry.dataPath, { force: true }).catch(() => {})
    await fsp.rm(entry.metadataPath, { force: true }).catch(() => {})
    recycleAvailable = true
    return true
  } catch {
    recycleAvailable = false
    return false
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => {})
  }
}
