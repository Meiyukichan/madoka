/**
 * Static portrait rules and the per-round target context.
 *
 * The reader is the model, and its purpose is to let the router decide which workspace
 * an issue belongs in, so the text stays at "what this project can do / its boundaries
 * / keywords" — no code walkthrough, no change history.
 *
 * @module dsh-magica-castboard/host/context/portrait-context
 */
import { escapeXml } from './xml-escape.ts'

/** Both files stay at or below this; the index must settle cwd at a glance. */
export const PORTRAIT_MAX_LINES = 1000

/** Portrait writer identity. */
export const PORTRAIT_ROLE_XML = '<role>You are the castboard project portrait writer: maintain one project portrait and its shared-index entry each round.</role>'

/** Output language. */
export const PORTRAIT_LANGUAGE_XML = '<language>Write both the portrait and its index entry in English. Keep project names, package names, paths, commands, versions, and code identifiers verbatim.</language>'

/** Why this file exists and who reads it. */
export const PORTRAIT_PURPOSE_XML = '<purpose>This portrait is routing guidance, not a code overview. The router uses it to decide whether an issue belongs to this project.</purpose>'

/** What the shared index must contain. */
export const PORTRAIT_INDEX_RULES_XML = `<index_rules>
index.md is the router's first routing signal; write it in English. The overview table has one row per workspace: copy workspaceId, title, and cwd verbatim, and write one sentence containing the product name, key stack, and domain.
Each workspace section must use exactly these labels:
- workspaceId
- cwd
- Routing fit
- Not here
- Keywords
- Notes
Keywords are one comma-separated line covering product name, aliases, version, stack, and domain terms. If two workspaces share a title, Routing fit and Notes must state the version and cwd boundary. Edit only the current workspace's row and section; never drop or rewrite other workspaces.
</index_rules>`

/** Hard limits for this unattended session. */
export const PORTRAIT_BOUNDARY_XML = '<boundary>Read only the target cwd; do not modify that project. The only writable files are output_file and index_file. Do not ask the user; when unsure, leave the value out instead of guessing.</boundary>'

/** How to gather information. */
export const PORTRAIT_METHOD_XML = `<method>Use exactly one subagent — never more — to read the project's README, docs, manifests, top-level layout, and key entry points. Summarize its findings and review them before writing.</method>`

/** Create-vs-update and index update rules. */
export const PORTRAIT_UPDATE_RULES_XML = `<update_rules>
When output_file exists, update it in place: add new capabilities, remove stale ones, and correct inaccuracies; do not rewrite from scratch. Otherwise create it with the structure below.
For index_file, read it first; add the current workspace's row and section if they are missing, otherwise change only them. Keep every other row and section untouched. Write in English.
Prefer accuracy over length.
</update_rules>`

/** Portrait document structure. */
export const PORTRAIT_CONTENT_XML = `<content>
Write in English using these Markdown headings: Overview, Capabilities, Modules, Stack, Workflow, Out of scope, Keywords.
<overview>One sentence: what this project does.</overview>
<capabilities>What the project provides: a bullet list, one per line, starting with a verb.</capabilities>
<modules>Main modules and entry points (5–15: directory or package to responsibility).</modules>
<stack>Language, framework, key dependencies, and build/package management.</stack>
<workflow>How to run, test, and build, using only real scripts in the repository.</workflow>
<out_of_scope>What this project does not do, and adjacent areas it is often confused with.</out_of_scope>
<keywords>Search terms: project name, aliases, version, stack, domain terms; one line, comma-separated.</keywords>
</content>`

/** Output format and line cap. */
export function portraitFormatXml(maxLines: number = PORTRAIT_MAX_LINES): string {
  return `<format>Markdown, written in English; at most ${maxLines} lines per file. Do not paste large code excerpts (a few lines at most), enumerate every file, write change history, or narrate the process. index.md is a table: keep its existing header and column order, and edit only the current workspace's row and section.</format>`
}

/** Ordered portrait child blocks. */
export function portraitContextBlocks(maxLines: number = PORTRAIT_MAX_LINES): string[] {
  return [
    PORTRAIT_ROLE_XML,
    PORTRAIT_LANGUAGE_XML,
    PORTRAIT_PURPOSE_XML,
    PORTRAIT_INDEX_RULES_XML,
    PORTRAIT_BOUNDARY_XML,
    PORTRAIT_METHOD_XML,
    PORTRAIT_UPDATE_RULES_XML,
    PORTRAIT_CONTENT_XML,
    portraitFormatXml(maxLines),
  ]
}

/** Render the complete `castboard-project-portrait` XML. */
export function castboardPortraitXml(maxLines: number = PORTRAIT_MAX_LINES): string {
  return ['<castboard_project_portrait>', ...portraitContextBlocks(maxLines), '</castboard_project_portrait>'].join('\n')
}

export const CASTBOARD_PORTRAIT_XML: string = castboardPortraitXml()

export interface PortraitTarget {
  /** workspace id (also decides the portrait file name). */
  readonly id: string
  /** The only path this round may read. */
  readonly path: string
  readonly title: string
  readonly outputFile: string
  readonly indexFile: string
  /** Drives the create-vs-update mode. */
  readonly portraitExists: boolean
}

interface TargetXmlField {
  readonly tag: string
  readonly read: (target: PortraitTarget) => string
}

const TARGET_XML_FIELDS: readonly TargetXmlField[] = [
  { tag: 'workspace_id', read: target => target.id },
  { tag: 'cwd', read: target => target.path },
  { tag: 'title', read: target => target.title },
  { tag: 'output_file', read: target => target.outputFile },
  { tag: 'index_file', read: target => target.indexFile },
  { tag: 'mode', read: target => (target.portraitExists ? 'update' : 'create') },
]

export function portraitTargetXml(target: PortraitTarget): string {
  const fields = TARGET_XML_FIELDS.map(field => (
    `<${field.tag}>${escapeXml(field.read(target))}</${field.tag}>`
  ))
  return [
    '<castboard_portrait_target>',
    ...fields,
    '</castboard_portrait_target>',
  ].join('\n')
}
