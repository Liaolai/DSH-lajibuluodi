import fsp from 'node:fs/promises'
import path from 'node:path'
import { runPowerShell } from './archive.js'

function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Send one file to the Windows Recycle Bin as a single entry.
 * @param {string} filePath
 * @param {number} [timeoutMs]
 */
export async function sendToRecycleBin(filePath, timeoutMs = 60_000) {
  const absolute = path.resolve(filePath)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('" + psQuote(absolute) + "', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    "if (Test-Path -LiteralPath '" + psQuote(absolute) + "') { throw 'file still exists after Recycle Bin handoff' }",
  ].join('; ')
  await runPowerShell(script, timeoutMs)
}

/**
 * Parse the fixed part and original path of a $I metadata file.
 * @param {Buffer} buffer
 * @returns {{size: number, deletedAt: Date, originalPath: string} | undefined}
 */
export function parseRecycleMetadata(buffer) {
  if (buffer.length < 28) return undefined
  const size = Number(buffer.readBigUInt64LE(8))
  const fileTime = buffer.readBigUInt64LE(16)
  const deletedAt = new Date(Number(fileTime / 10_000n) - 11_644_473_600_000)
  const pathLength = buffer.readUInt32LE(24)
  if (!Number.isSafeInteger(pathLength) || pathLength < 1 || pathLength > 32_768) return undefined
  const byteLength = (pathLength - 1) * 2
  if (28 + byteLength > buffer.length) return undefined
  const originalPath = buffer.toString('utf16le', 28, 28 + byteLength)
  if (originalPath === '') return undefined
  return { size, deletedAt, originalPath }
}

/**
 * Find the Recycle Bin entry whose original path is exactly this file.
 * @param {string} originalPath
 * @returns {Promise<{metadataPath: string, dataPath: string, originalPath: string, size: number, deletedAt: Date} | undefined>}
 */
export async function findRecycleEntry(originalPath) {
  const absolute = path.resolve(originalPath)
  const root = path.parse(absolute).root
  const recycleRoot = path.join(root, '$Recycle.Bin')
  let sidEntries
  try {
    sidEntries = await fsp.readdir(recycleRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const normalizedTarget = absolute.toLowerCase()
  for (const sidEntry of sidEntries) {
    if (!sidEntry.isDirectory()) continue
    const sidDir = path.join(recycleRoot, sidEntry.name)
    let files
    try {
      files = await fsp.readdir(sidDir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.startsWith('$I')) continue
      const metadataPath = path.join(sidDir, name)
      let buffer
      try {
        buffer = await fsp.readFile(metadataPath)
      } catch {
        continue
      }
      const parsed = parseRecycleMetadata(buffer)
      if (parsed === undefined) continue
      if (path.resolve(parsed.originalPath).toLowerCase() !== normalizedTarget) continue
      const dataPath = path.join(sidDir, '$R' + name.slice(2))
      try {
        const stat = await fsp.stat(dataPath)
        return { metadataPath, dataPath, originalPath: parsed.originalPath, size: stat.size, deletedAt: parsed.deletedAt }
      } catch {
        continue
      }
    }
  }
  return undefined
}

/**
 * Copy a package ZIP out of the Recycle Bin without restoring it in Explorer.
 * @param {string} originalPath - the path the ZIP had before recycling.
 * @param {string} destination
 * @returns {Promise<boolean>}
 */
export async function restoreZipFromRecycle(originalPath, destination) {
  const entry = await findRecycleEntry(originalPath)
  if (entry === undefined) return false
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.copyFile(entry.dataPath, destination)
  return true
}
