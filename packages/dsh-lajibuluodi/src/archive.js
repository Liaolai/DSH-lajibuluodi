import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Run Windows PowerShell without a profile and return stdout/stderr.
 * @param {string} script
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runPowerShell(script, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('PowerShell timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error('PowerShell exited with ' + code + ': ' + (stderr.trim() || stdout.trim())))
    })
  })
}

/**
 * Create a ZIP from a directory with .NET's ZipFile (streams, no JS memory
 * spike). The archive contains the directory's children, not the base folder.
 * @param {string} sourceDir
 * @param {string} zipPath
 * @param {number} [timeoutMs]
 */
export async function createZipFromDirectory(sourceDir, zipPath, timeoutMs = 300_000) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true })
  await fsp.rm(zipPath, { force: true }).catch(() => {})
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory('" + psQuote(sourceDir) + "', '" + psQuote(zipPath) + "', [System.IO.Compression.CompressionLevel]::Fastest, $false)",
  ].join('; ')
  try {
    await runPowerShell(script, timeoutMs)
  } catch (error) {
    await fsp.rm(zipPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Build a staging folder of hard links plus manifest, then zip it. The
 * staging folder is deleted by the caller after the archive settles.
 * @param {object} input
 * @param {string} input.turnDir
 * @param {string} input.zipPath
 * @param {Array<{relative: string, snapshotPath: string, size: number, mtimeMs: number}>} input.deletions
 * @param {object} input.manifest
 * @param {number} input.maxFiles
 * @param {number} input.maxBytes
 * @param {object} [input.logger]
 * @returns {Promise<{packageDir: string, zipPath: string, included: object[], skipped: object[], bytes: number}>}
 */
export async function buildPackage(input) {
  const packageDir = path.join(input.turnDir, 'package')
  const filesDir = path.join(packageDir, 'files')
  await fsp.rm(packageDir, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(filesDir, { recursive: true })
  const included = []
  const skipped = []
  let bytes = 0
  for (const deletion of input.deletions) {
    if (included.length >= input.maxFiles) {
      skipped.push({ path: deletion.relative, reason: 'max-files' })
      continue
    }
    if (bytes + deletion.size > input.maxBytes) {
      skipped.push({ path: deletion.relative, reason: 'max-bytes' })
      continue
    }
    const target = path.join(filesDir, ...deletion.relative.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    try {
      await fsp.link(deletion.snapshotPath, target)
    } catch {
      try {
        await fsp.copyFile(deletion.snapshotPath, target)
      } catch (error) {
        skipped.push({ path: deletion.relative, reason: 'unreadable', message: error.message })
        continue
      }
    }
    included.push({ path: deletion.relative, size: deletion.size, mtimeMs: deletion.mtimeMs })
    bytes += deletion.size
  }
  const manifest = {
    ...input.manifest,
    fileCount: included.length,
    totalBytes: bytes,
    files: included,
    skipped,
  }
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await createZipFromDirectory(packageDir, input.zipPath)
  return { packageDir, zipPath: input.zipPath, included, skipped, bytes, manifest }
}

/**
 * Remove a staging folder; never throws.
 * @param {string} packageDir
 */
export async function removeStaging(packageDir) {
  await fsp.rm(packageDir, { recursive: true, force: true }).catch(() => {})
}

/**
 * Extract a ZIP into a destination folder.
 * @param {string} zipPath
 * @param {string} destination
 * @param {number} [timeoutMs]
 */
export async function extractZip(zipPath, destination, timeoutMs = 300_000) {
  await fsp.mkdir(destination, { recursive: true })
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory('" + psQuote(zipPath) + "', '" + psQuote(destination) + "')",
  ].join('; ')
  await runPowerShell(script, timeoutMs)
}
