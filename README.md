# DSH-lajibuluodi workspace

[![test](https://github.com/Liaolai/DSH-lajibuluodi/actions/workflows/test.yml/badge.svg)](https://github.com/Liaolai/DSH-lajibuluodi/actions/workflows/test.yml)

This workspace contains the **DSH-lajibuluodi** plugin: one recognizable Recycle Bin package per DSH agent turn.

- Package: [packages/dsh-lajibuluodi](packages/dsh-lajibuluodi)
- Chinese README: [packages/dsh-lajibuluodi/README.md](packages/dsh-lajibuluodi/README.md)
- English README: [packages/dsh-lajibuluodi/README.en.md](packages/dsh-lajibuluodi/README.en.md)
- Design notes: [NOTES.md](NOTES.md)

## Status

- 12 unit/integration tests pass.
- Verified in a real DSH headless profile with a mock Messages API: the agent deleted a file, the plugin produced one ZIP in the E: Recycle Bin, and /lajibuluodi restore restored the file.
- The running desktop profile was not modified.

## Test

~~~powershell
# from the repository root
node --test "packages/dsh-lajibuluodi/test/*.test.js"
~~~

The tests create real Recycle Bin entries and clean them up. Run them on a test machine.
