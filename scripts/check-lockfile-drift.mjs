#!/usr/bin/env node
// scripts/check-lockfile-drift.mjs — fail fast when pnpm-lock.yaml and package.json disagree.
//
// Why this exists: pnpm 12 keeps the package manager's own version in the
// lockfile, so the file `pnpm install` writes is two YAML documents — a leading
// package-manager document (@pnpm/exe resolution, `packageManagerDependencies`)
// and then the project document. Committing exactly that shape makes a local
// `pnpm install` a no-op: the lockfile is already what pnpm would write, so it
// does not show up as a spurious modification.
//
// The gate is offline and checks two things:
//   1. the lockfile is the natural two-document form (self-management document
//      first, project document last), so a local install does not rewrite it;
//   2. every dependencies / devDependencies / optionalDependencies entry in
//      package.json appears in the project document's root importer with the
//      same specifier, and the lockfile has no extra entry.
//
// Usage:
//   node scripts/check-lockfile-drift.mjs          # verify (CI runs this)
//
// Exit codes: 0 = in sync; 1 = drift.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const failures = []

/** The project document starts at the last top-level lockfileVersion line. */
function splitDocuments(text) {
  const starts = []
  text.split('\n').forEach((line, index) => {
    if (/^lockfileVersion: /u.test(line)) starts.push(index)
  })
  if (starts.length === 0) return []
  if (starts.length === 1) return [{ self: '', project: text }]
  const lines = text.split('\n')
  const projectStart = starts.at(-1)
  // The separator line (`---`) belongs to neither document.
  let separator = projectStart - 1
  while (separator >= 0 && lines[separator] !== '---') separator -= 1
  const headEnd = separator === -1 ? projectStart : separator
  return [{ self: lines.slice(0, headEnd).join('\n'), project: lines.slice(projectStart).join('\n') }]
}

/** @param text project document @returns dependency maps of the root importer */
function parseRootImporter(text) {
  const lines = text.split('\n')
  const importersAt = lines.findIndex((line) => line === 'importers:')
  if (importersAt === -1) throw new Error('the project document has no importers section')
  const rootAt = lines.findIndex((line, index) => index > importersAt && line === '  .:')
  if (rootAt === -1) throw new Error('the project document has no root importer (.)')
  const fields = { dependencies: {}, devDependencies: {}, optionalDependencies: {} }
  let field = null
  for (let index = rootAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/u.test(line)) break
    const header = /^    (dependencies|devDependencies|optionalDependencies):$/u.exec(line)
    if (header !== null) {
      field = header[1]
      continue
    }
    const entry = /^      ('[^']+'|"[^"]+"|[A-Za-z0-9@._/-]+):$/u.exec(line)
    if (entry === null || field === null) continue
    const name = entry[1].replace(/^['"]|['"]$/gu, '')
    let specifier = null
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^        specifier: (.*)$/u.exec(lines[cursor])
      if (next !== null) {
        specifier = next[1].trim().replace(/^['"]|['"]$/gu, '')
        break
      }
      if (!lines[cursor].startsWith('        ')) break
    }
    fields[field][name] = specifier
  }
  return fields
}

const documents = splitDocuments(lock).at(-1)
let project = null
if (documents === undefined) {
  failures.push('pnpm-lock.yaml has no lockfileVersion line')
} else if (documents.self === '') {
  failures.push(
    'pnpm-lock.yaml has a single document. Commit the two-document lockfile pnpm writes ' +
      '(run `pnpm install --lockfile-only`, commit pnpm-lock.yaml); a local install is then a no-op.',
  )
  project = documents.project
} else {
  const self = documents.self
  if (!/packageManagerDependencies:/u.test(self) || !/@pnpm\/exe/u.test(self)) {
    failures.push(
      'the first pnpm-lock.yaml document is not pnpm\'s package-manager document; ' +
        'regenerate with `pnpm install --lockfile-only` and commit the result',
    )
  }
  project = documents.project
}

let matched = 0
if (project !== null) {
  try {
    const actual = parseRootImporter(project)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const expected = pkg[field] ?? {}
      for (const [name, specifier] of Object.entries(expected)) {
        if (!(name in actual[field])) {
          failures.push(`${field}: ${name} is in package.json but missing from the lockfile importer`)
        } else if (actual[field][name] !== specifier) {
          failures.push(
            `${field}: ${name} specifier ${JSON.stringify(actual[field][name])} does not match package.json ${JSON.stringify(specifier)}`,
          )
        } else {
          matched += 1
        }
      }
      for (const name of Object.keys(actual[field])) {
        if (!(name in expected)) failures.push(`${field}: ${name} is in the lockfile importer but not in package.json`)
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}

if (failures.length > 0) {
  console.error('lockfile drift:')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  console.error('Fix: `pnpm install --lockfile-only` (then commit pnpm-lock.yaml) after a dependency change;')
  console.error('do not hand-edit or trim the lockfile.')
  process.exit(1)
}

console.log(`lockfile ok: natural two-document form, ${matched} direct dependencies match package.json`)
