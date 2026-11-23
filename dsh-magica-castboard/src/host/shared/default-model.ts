/**
 * Default model resolution. The session facade does not fill in a model for the caller, and
 * the system prompt's `{{model}}` interpolation must have one — without it every turn dies
 * with `prompt variable "{{model}}" has no value for this assembly`, after the session has
 * already been created and its context injected. So resolve once, tolerantly, and return
 * `undefined` when nothing is found; the caller decides whether to give up.
 *
 * Order: pinned `DSH_MODEL_PROVIDER` + `DSH_MODEL`, the caller's override variable
 * (`provider/model`), `agentDefaultModel.currentSelection()`, then any default-model
 * surface the `settings` / `agents` services expose. Never throws — a missing service or a
 * malformed value just means "not resolved".
 *
 * @module dsh-magica-castboard/host/shared/default-model
 */

/** `reasoningEffort` is only ever carried by a default selection. */
export interface ResolvedModel {
  provider: string
  model: string
  reasoningEffort?: string
}

const PROVIDER_ENV = 'DSH_MODEL_PROVIDER'

const MODEL_ENV = 'DSH_MODEL'

interface ServiceLookup {
  get?: (name: string) => unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pair(provider: unknown, model: unknown): ResolvedModel | undefined {
  const p = text(provider)
  const m = text(model)
  if (p === '' || m === '') return undefined
  return { provider: p, model: m }
}

function splitChoice(raw: unknown): ResolvedModel | undefined {
  const value = text(raw)
  if (value === '') return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash >= value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

function fromSelection(raw: unknown): ResolvedModel | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const selection = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  const base = pair(selection.provider, selection.model)
  if (base === undefined) return undefined
  const effort = text(selection.reasoningEffort)
  return effort === '' ? base : { ...base, reasoningEffort: effort }
}

function fromAnything(raw: unknown, depth: number): ResolvedModel | undefined {
  return fromSelection(raw)
    ?? splitChoice(raw)
    ?? (depth > 0 ? fromFace(raw, depth - 1) : undefined)
}

/**
 * Probe one service face. Deployments hang "the current default" off different members (a
 * method, a property, or the value returned by `get(ns)`), so each known shape is tried
 * separately; `depth` bounds the inward probing so services referencing each other cannot
 * recurse forever.
 */
function fromFace(face: unknown, depth: number): ResolvedModel | undefined {
  if (depth < 0 || face === null || typeof face !== 'object') return undefined
  const holder = face as Record<string, unknown>

  const current = holder.currentSelection
  if (typeof current === 'function') {
    try {
      const found = fromSelection((current as () => unknown).call(face))
      if (found !== undefined) return found
    } catch {
      // A throwing service means this face is unusable; try the next one.
    }
  }

  const currentOptions = holder.defaultAgentOptions
  if (typeof currentOptions === 'function') {
    try {
      const found = fromSelection((currentOptions as () => unknown).call(face))
      if (found !== undefined) return found
    } catch {
      /* unusable */
    }
  }

  for (const key of ['selection', 'defaultModel', 'currentModel', 'model', 'defaults']) {
    try {
      const found = fromAnything(holder[key], depth - 1)
      if (found !== undefined) return found
    } catch {
      /* a throwing getter is not a choice */
    }
  }

  const getter = holder.get
  if (typeof getter === 'function') {
    for (const key of ['agentDefaultModel', 'agent-default-model', 'model']) {
      try {
        const found = fromAnything((getter as (name: string) => unknown).call(face, key), depth - 1)
        if (found !== undefined) return found
      } catch {
        /* no such service */
      }
    }
  }

  return undefined
}

export function resolveDefaultModel(ctx?: unknown, envOverride?: string): ResolvedModel | undefined {
  const fromEnvironment = pair(process.env[PROVIDER_ENV], process.env[MODEL_ENV])
  if (fromEnvironment !== undefined) return fromEnvironment

  if (envOverride !== undefined && envOverride !== '') {
    const override = splitChoice(process.env[envOverride])
    if (override !== undefined) return override
  }

  const lookup = ctx as ServiceLookup | undefined
  if (lookup === undefined || typeof lookup.get !== 'function') return undefined

  // The default model service is authoritative; settings/agents are fallbacks for
  // deployments that expose the default elsewhere.
  for (const name of ['agentDefaultModel', 'settings', 'agents']) {
    try {
      const found = fromFace(lookup.get(name), 2)
      if (found !== undefined) return found
    } catch {
      /* continue with the next candidate */
    }
  }
  return undefined
}
