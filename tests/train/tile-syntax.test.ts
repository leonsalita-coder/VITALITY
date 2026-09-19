import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as acorn from 'acorn'

/**
 * The structural check typecheck cannot do.
 *
 * Inside public/tiles/*.html the code is a string until a browser reads
 * it, so `tsc` never sees it and every mistake there is found at runtime
 * or not at all. A duplicate object key shipped twice from exactly that
 * blind spot — JavaScript accepts one silently, the later value wins, and
 * the suite stayed green both times.
 *
 * So the tile gets parsed by a real parser, and the failures that a parser
 * can see are failures here.
 */

const TILES = ['public/tiles/train.html', 'tiles-library/train.html']

interface Block { code: string; offset: number }

function scriptsIn(html: string): Block[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({
    code: m[1],
    offset: (m.index as number) + m[0].indexOf(m[1]),
  }))
}

function parse(block: Block) {
  return acorn.parse(block.code, { ecmaVersion: 'latest', sourceType: 'script' })
}

/** Every object literal in the tree, walked without a dependency. */
function objectLiterals(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => objectLiterals(n, out))
    return out
  }
  if (node.type === 'ObjectExpression') out.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    objectLiterals(node[key], out)
  }
  return out
}

describe.each(TILES)('%s', (path) => {
  const html = readFileSync(path, 'utf8')
  const blocks = scriptsIn(html)

  it('has script blocks to check at all', () => {
    // a regex that matched nothing would make every test below vacuous
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.code.length > 1000)).toBe(true)
  })

  it('parses — a syntax error here is otherwise found only by a browser', () => {
    for (const block of blocks) expect(() => parse(block)).not.toThrow()
  })

  it('has no object literal with the same key twice', () => {
    const duplicates: string[] = []
    for (const block of blocks) {
      for (const object of objectLiterals(parse(block))) {
        const seen = new Set<string>()
        for (const prop of object.properties) {
          if (prop.type !== 'Property' || prop.computed) continue
          const name =
            prop.key.type === 'Identifier' ? prop.key.name
            : prop.key.type === 'Literal' ? String(prop.key.value)
            : null
          if (name == null) continue
          if (seen.has(name)) {
            const line = html.slice(0, block.offset + prop.start).split('\n').length
            duplicates.push(`${name} (line ${line})`)
          }
          seen.add(name)
        }
      }
    }
    expect(duplicates).toEqual([])
  })
})
