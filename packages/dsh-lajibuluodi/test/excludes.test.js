import test from 'node:test'
import assert from 'node:assert/strict'
import { createExcludeMatcher } from '../src/excludes.js'

test('bare names match any segment', () => {
  const excluded = createExcludeMatcher(['node_modules', '.git'])
  assert.equal(excluded('node_modules'), true)
  assert.equal(excluded('packages/a/node_modules'), true)
  assert.equal(excluded('src/index.js'), false)
})

test('slash patterns match a path prefix', () => {
  const excluded = createExcludeMatcher(['dist', 'tmp/cache'])
  assert.equal(excluded('tmp/cache'), true)
  assert.equal(excluded('tmp/cache/a.png'), true)
  assert.equal(excluded('tmp/other/a.png'), false)
})

test('wildcards are supported', () => {
  const excluded = createExcludeMatcher(['*.tmp', 'build/**/x'])
  assert.equal(excluded('a.tmp'), true)
  assert.equal(excluded('sub/a.tmp'), true)
  assert.equal(excluded('build/a/x'), true)
  assert.equal(excluded('build/a/y'), false)
})
