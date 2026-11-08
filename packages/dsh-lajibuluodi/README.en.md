# DSH-lajibuluodi

**One task, one package — no more anonymous files piling up in the Recycle Bin.**

DSH-lajibuluodi is a DeepSeek Harness host plugin. At the end of every agent turn it collects the files that disappeared from the workspace, packs them into one ZIP named after the task, and sends that ZIP to the Windows Recycle Bin as a single entry.

## Why

Agent tasks leave dozens of temporary files in the Recycle Bin: tmp_verify.png, tmp_hero.jpg, a1b2c3.tmp. The bin becomes slow to open, the names mean nothing, and users are afraid to empty it.

With DSH-lajibuluodi the bin gains one readable entry per turn:

~~~
DSH-20261109-002021-fix-login-page-c0b16a-T1.zip
  manifest.json      session, turn, original paths, sizes, timestamps
  files/...          deleted files under their workspace-relative paths
~~~

## How it works

1. On turn/start the plugin builds a **hard-link mirror** of the workspace on the same volume. No file content is copied.
2. A recursive watcher plus a scan before every tool call captures files created during the turn.
3. On turn/end it compares mirror and live tree:
   - mirrored path gone and its inode gone → deleted;
   - inode still present elsewhere → rename/move, skip;
   - path still exists with different content → overwrite, not trash.
4. Deleted files become a ZIP (manifest.json + files/) which is handed to the Windows Recycle Bin via SendToRecycleBin.
5. A packages.jsonl record powers /lajibuluodi list and /lajibuluodi restore.

## Install

### Into a profile

Back up the profile first. For desktop:

~~~powershell
$profile = "$env:USERPROFILE/.dsh/profiles/desktop"
$dsh = 'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'  # adjust to your install
$repo = (Get-Location).Path  # run from the repository root
Copy-Item "$profile/package.json" "$profile/package.json.bak" -Force

& $dsh plugin --profile desktop add "file:$repo/packages/dsh-lajibuluodi"

# The plugin add command usually updates dsh.profile.bundles automatically.
# The block below is a fallback / verification.
$pkg = Get-Content "$profile/package.json" -Raw | ConvertFrom-Json
if ($pkg.dsh.profile.bundles -notcontains 'dsh-lajibuluodi') {
  $pkg.dsh.profile.bundles += 'dsh-lajibuluodi'
}
$json = $pkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText("$profile/package.json", $json, [Text.UTF8Encoding]::new($false))
~~~

Restart DSH or reload the profile. The log line

~~~
[lajibuluodi] active; data roots are resolved per workspace volume
~~~

means the plugin is mounted.

For a disposable test profile:

~~~powershell
& $dsh --profile laji-test --from-default-profile web --dump-config
~~~

then add dsh-lajibuluodi to that profile the same way.

## Usage

Fully automatic. No model tool is required.

~~~
/lajibuluodi status            active capture, data root, last package
/lajibuluodi list [n]          recent packages
/lajibuluodi restore <id|name> restore files to original paths (no overwrite)
/lajibuluodi restore <id|name> --overwrite
/lajibuluodi package           finish the current turn and package now
~~~

restore uses the outbox ZIP if it is still there; otherwise it locates the $R... payload in $Recycle.Bin by the original outbox path, extracts it, and writes the files back according to manifest.json.

Explorer's “Restore” on the ZIP only puts the ZIP back into the outbox; use the command above to restore its contents.

## Configuration

Override by row id in the profile's cordis.patch.yml:

~~~yaml
- id: lajibuluodi
  config:
    dataDir: 'D:/DSH-trash'
    exclude: ['.git', 'node_modules', 'tmp', '*.log']
    maxFiles: 20000
    maxPackageFiles: 5000
    maxPackageBytes: 1500000000
~~~

| Key | Default | Meaning |
|---|---|---|
| enabled | true | master switch |
| dataDir | empty | empty = volume root/.dsh-lajibuluodi; cross-volume falls back to copy mode |
| exclude | common build/dependency dirs | paths skipped by the snapshot; directory names, *, ?, a/b prefixes |
| maxFiles | 20000 | snapshot file cap per turn |
| maxPackageFiles | 5000 | files per package |
| maxPackageBytes | 1500000000 | bytes per package |
| maxCopyBytes | 67108864 | largest file copied when a hard link fails |
| scanIntervalMs | 5000 | background full-scan interval |
| beforeToolBudgetMs | 1500 | wait budget for the pre-tool scan |
| keepSnapshots | false | keep snapshots after packaging (debug) |
| packagePrefix | DSH | package name prefix |
| packageNameMaxLength | 120 | package name cap |

## Limitations

- A file created and deleted **inside one shell command** may be missed; the watcher and pre-tool scan cannot guarantee seeing it. Cross-tool temporary files (the common case) are captured.
- Only deletions are packaged; overwrites, renames, and moves are ignored (renames are recognized by inode).
- Workspaces above maxFiles are truncated; files beyond the cap are not recoverable.
- Oversized files/packages are listed under skipped in manifest.json instead of aborting the whole package.
- Non-Windows: the ZIP stays in the outbox; no Recycle Bin handoff.
- ZIPs contain **plaintext file contents**, potentially secrets. Exclude sensitive paths or avoid the plugin on highly sensitive machines.
- The plugin runs in the DSH host process and writes to the volume root, outside the workspace sandbox.

## Development

~~~powershell
# from the repository root
node --test "packages/dsh-lajibuluodi/test/*.test.js"
~~~

Tests cover naming, exclude rules, hard-link snapshots, deletion/rename detection, one-turn packaging → Recycle Bin → restore, and multi-turn separation. They write real Recycle Bin entries and clean them up.

## License

MIT
