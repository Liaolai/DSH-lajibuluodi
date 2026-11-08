/**
 * Compile the user's exclude list into a predicate over slash-separated
 * workspace-relative paths. A bare name matches any path segment; a pattern
 * containing "/" matches a path prefix; * and ? are supported.
 * @param {readonly string[]} patterns
 * @returns {(relativePath: string) => boolean}
 */
export function createExcludeMatcher(patterns) {
  const rules = patterns
    .map(pattern => String(pattern ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(compileRule)
  return relativePath => {
    const value = String(relativePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    return rules.some(rule => rule(value))
  }
}

function compileRule(pattern) {
  const hasSlash = pattern.includes('/')
  const regex = globToRegExp(pattern)
  if (hasSlash) {
    return value => {
      const parts = value.split('/')
      for (let index = 1; index <= parts.length; index += 1) {
        if (regex.test(parts.slice(0, index).join('/'))) return true
      }
      return false
    }
  }
  return value => {
    const parts = value.split('/')
    return parts.some(part => regex.test(part))
  }
}

function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`, process.platform === 'win32' ? 'i' : '')
}
