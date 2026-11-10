/**
 * Package contract: version, bundle patch and zero runtime dependencies.
 * @module test/package.spec
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('package contract', () => {
  it('single-sources the version', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('declares a bundle patch, publishes it, and keeps runtime dependencies empty', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('lib')
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0)
    expect(pkg.peerDependencies?.['@perrylink/dsh-research-core']).toBeDefined()
  })

  it('documents every config key used by the loader', async () => {
    const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
    for (const key of ['enabled', 'root', 'mailto', 'timeoutMs', 'maxResults', 'maxRounds', 'perRound', 'minCore', 'minTotal']) {
      expect(patch).toContain(key)
    }
  })
})
