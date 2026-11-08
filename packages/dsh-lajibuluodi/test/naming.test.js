import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeComponent, buildPackageName, formatTimestamp, truncateFileName } from '../src/naming.js'

test('sanitizeComponent removes Windows-illegal characters and reserved names', () => {
  assert.equal(sanitizeComponent('a<b>c:d"e/f\\g|h?i*j'), 'a b c d e f g h i j')
  assert.equal(sanitizeComponent('CON'), '_CON')
  assert.equal(sanitizeComponent('   ...   '), 'task')
})

test('package names are readable and always end in .zip', () => {
  const name = buildPackageName({ prefix: 'DSH', date: new Date(2026, 10, 9, 0, 16, 47), title: '修复 登录页', turn: 3, sessionId: 'session-abcdef' })
  assert.match(name, /^DSH-20261109-001647-修复 登录页-abcdef-T3\.zip$/)
  assert.ok(name.length <= 120)
})

test('truncateFileName keeps the extension', () => {
  const name = truncateFileName('a'.repeat(200) + '.zip', 40)
  assert.equal(name.length, 40)
  assert.ok(name.endsWith('.zip'))
})

test('formatTimestamp is local and zero-padded', () => {
  const value = formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))
  assert.equal(value, '20260102-030405')
})
