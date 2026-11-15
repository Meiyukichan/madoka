---
name: dsh-plugins-principles
description: Mandatory rules for dsh 0.2.0-rc.2 plugins — packaging and client-bundle contract, peer ranges, host runtime safety, MarkdownText/UI-primitives reuse, slot+locale i18n, --dsw-alias-* theming, dev-profile isolation. Use when writing, reviewing, or debugging a dsh plugin.
---

# dsh Plugin Development Principles and Requirements

Any plugin built for dsh must obey the rules and requirements below — they are rules, not process steps. Before writing code, read the official implementation of the same feature in the dsh source (section 3) and match its API usage, naming, and return shapes.

## 1. Engineering requirements (package.json / build / dependencies)

1. **All build output lives in `lib/`**: both `tsconfig` and `tsdown` set `outDir: lib`, and the client bundle lands at `lib/client.js`; `package.json`'s `main`/`exports`/`types`/`files` all point into `lib/`, with no `dist/` or standalone `client/` directory. The final `lib/` holds only `index.js` and `client.js` (types live in `lib/types`); **`*.js.map` and source or intermediate files must never enter `lib/`**.

2. **`package.json` declares `dsh.bundle.patch` pointing at this package's `cordis.patch.yml`**; `exports` exposes `.`, `./client`, `./package.json` (add `./locale/*.json` when the plugin shows display metadata); `type: module`. `cordis.patch.yml` needs no `exports` entry (the loader reads it from the package directory), but it must be in `files`, and `files` must cover every relative runtime import and artifact:

   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
   }
   ```

   - `platform` is always `"web"`; declaring `dsh.client` without the `./client` export fails the Host scan immediately.
   - `dsh.client.inject` lists **package dependency edges** (boot-graph ordering, HMR diff), not Cordis service injection; declare service dependencies at module level instead: `export const inject = ['slots', 'locale', ...]`.
   - `dsh.client.external` is only for infrastructure, transport, or generated-wiring module requests; a feature plugin must not use it to reach another plugin's runtime values (the build-time purity gate rejects cross-plugin value imports).
   - `immediately: true` is only for stage-one prefetch rows that must register their factory before the shell boots; ordinary plugins leave it out.

3. **Dependency ranges must cover the running dsh runtime**: dsh packages that must share an instance with the host (cordis, dsh-llm, dsh-settings, dsh-tools, schemastery, ...) belong in **both** `peerDependencies` and `devDependencies`, with ranges covering the runtime (e.g. `^0.2.0-rc.2` / `>=0.2.0-rc.2`). Baseline modules injected by the shell module table (`react`/`react-dom`, `ui-primitives`/`ui-slots`/`client-store`, ...) go in `devDependencies` only, for type checking; they are never bundled.

   ```json
   "peerDependencies": { "@deepseek-ai/cordis": "^4.0.4", "@deepseek-ai/dsh-llm": "^0.2.0-rc.2" },
   "devDependencies": { "@deepseek-ai/cordis": "^4.0.4", "@deepseek-ai/dsh-llm": "^0.2.0-rc.2" }
   ```

   - During profile composition, 0.2 semver-checks the `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers (**prereleases included**): a row with an unsatisfied peer is **disabled outright** (the plugin manager also rolls back and refuses the install). The only way through is a per-version exemption: `dsh plugin --profile <p> allow-version <pkg@version> --dsh-version <exact> --accept-risk`.
   - `engines.dsh` is declarative only — nothing in the source reads it, so it provides no protection.

4. **`cordis.patch.yml` mounts rows with `insert`** (`id` + `name`), and the profile applies it on install. **The inserted `name` must exactly equal `package.json`'s `name`** (the full scoped package name) — the loader locates the package at `node_modules/<name>` by that name.

   - Rows accept `inject`, `config`, `disabled`, and `!!js` expressions; later layers win per row, and a patch **replaces** the target row's `config` wholesale (no deep merge), so restate every key when overriding an existing row.
   - **Only the bare-package-name row mounts `./client`**; a `pkg/subpath` row has the host half only, so a page or plugin that needs its own lifecycle must be its own package.

5. **The client bundle must be a closure factory** (mirror dsh's own `tsdown.client.ts`; the official `clientBundle` preset ships in no published package, so outside the repository you must reproduce the contract yourself): `format: cjs`, `platform: browser`, `outDir: lib`, `entryFileNames: client.js`, with all three of banner / intro / footer, wrapped as:

   ```js
   window.__ModuleLoader__.load({ id: "@acme/dsh-panel", factory: (require) => {
   var module = { exports: {} }; var exports = module.exports;
   /* bundle body */
   return module.exports; } });
   ```

   - Externals may only be specifiers from the shell baseline module table (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`) plus whatever this package declares in `dsh.client.external`; every other dependency must be bundled — a leftover bare import throws at runtime.
   - Code-split chunks register with a `chunk` field and compile to `require.async("./client.<name>.js")`; a chunk must not synchronously require a sibling chunk.
   - sourcemaps are debug-only and **never ship in `lib/`**: the official preset writes `client.js.map`, so strip it from the artifact (see 1.1).

## 2. Runtime safety (prohibited patterns)

1. **No synchronous blocking on hot paths (graded by harm)**: host code runs in the dsh web Node process, where synchronous I/O blocks the event loop. Harm = time per call × frequency:
   - 🔴 **True hot path + heavy I/O must go async**: `readdirSync` over a large directory, `rmSync(recursive)` on a directory tree, large file reads and writes — these genuinely stall the process, so they come first.
   - 🟡 **Hot path + light I/O read per call** (`readFileSync` on a small config, `existsSync`, `statSync`): the best fix is **caching** (read once at startup, invalidate on file change), not a mechanical switch to async — bigger win, lower risk.
   - 🟢 **Atomic writes keep `writeFileSync(tmp) + renameSync` synchronous**: the standard pattern that preserves file integrity; converting it to async means carefully preserving the atomic semantics.
   - **Cold paths (startup, login, install) may stay synchronous**: a one-off read barely affects process health. Synchronous infinite loops remain absolutely forbidden.

2. **No uncaught exceptions or unhandled rejections**: an unhandled rejection faults the fiber and can take down the web process or fail profile startup (fail-loud). Every path that can throw needs `try/catch` or `.catch()`; HTTP handlers guard with `if (!res.headersSent)` before responding, and must never answer empty or let the exception escape.

3. **Every side effect must be reversible**: services, event listeners, slots, timers, and `<style>` tags must return a disposer, all collected in one `ctx.effect(() => { ... return dispose }, 'label')` so stop, update, and unload clean up completely. **Exception**: `process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'` for enterprise self-signed certificates (IDaaS, InferHub, ...) is not treated as P0, but prefer a scoped `https.Agent({ rejectUnauthorized: false })` (global env is acceptable, a local agent is better).

4. **Optional services are read with `ctx.get('xxx')` and checked for `undefined`; only hard dependencies go in `inject: ['xxx']`**. Never touch a service property that inject did not declare.

5. **Do not open your own long-lived connection (SSE / WebSocket)**: dsh's long-lived connections (the Gateway WebSocket mux, HMR's SSE) belong to the shell; a plugin that opens its own leaves a connection nobody can reclaim after its route unmounts. Plugin events travel only two ways: Typert Remote methods plus short frontend polling (interval ≥ 5s, with a stop condition — task finished, limit reached, or component unmounted — and the poll timer owned by `ctx.effect`); or `ctx.remote.$on(event, listener)` over events the shell already forwards (only the `API_REMOTE_FORWARDED_EVENTS` allowlist; a plugin cannot extend it).

6. **Bound concurrency; do not exhaust the libuv thread pool**: one dsh web Node process has only 4 thread-pool slots, and filling them queues every HTTP handler, including requests from other plugins. Asynchronous I/O such as outbound fetch DNS resolution and `fs/promises` does not block the event loop (see item 1) but still uses the pool, so limit fan-out and keep headroom: give fetches a timeout (`AbortSignal.timeout`) and read files in batches of 2–4 rather than unbounded parallelism.

## 3. Source reference and consistency

1. **Read the equivalent official implementation first**, and match its API usage, naming, and return shapes. Prefer the local dsh source checkout; when it is missing, run `where dsh` (Windows) / `which dsh` (Unix-like) to locate the compiled JS and read that.

2. **Match dsh's UI style**: components, layout, interaction, and copy tone follow `packages/client/ui-primitives` (Modal, Input, Button, MarkdownText, ...); do not invent a second visual language.

3. **Reuse what dsh already exports**: utilities, services, and APIs are there to be used; check the available exports before building your own.

4. **Markdown text pages use the official MarkdownText**: when a plugin renders streaming text (AI messages, review progress) or a Markdown report (audit report, release notes), **prefer the official** `import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'` instead of writing your own Markdown renderer:

   ```tsx
   <MarkdownText text={content} streaming={isStreaming} labels={mdLabels} variant="body" />
   ```

   - `streaming` drives incremental chunks (live AI output); `variant` is `'body' | 'compact'`.
   - Since 0.2, `labels` is **required**: `{ code: { copyLabel, copiedLabel }, footnotes }` (`MarkdownCodeLabels` may also carry an optional `toolbarLabels`). Memoize the object per locale revision — a new identity discards the streaming render cache.
   - `fileMentions` turns inline-code tokens that resolve to real files into links; `pathImages` rewrites local image paths into displayable URLs. Local link activation comes from the nearest `MarkdownDelegateProvider`; without one, local links stay plain text.
   - The types ship in the public `@deepseek-ai/dsh-client-ui-primitives` exports (`MarkdownText`, `MarkdownLabels`, ...), so never hide an import error behind `@ts-expect-error`.

5. **Check this repository's 0.2-line SDK before writing or changing a plugin (strongly recommended)**: the SDK package is `dsh-magica-spellbook`, documented in `docs/spellbook/dsh-spellbook-sdk.md`; when this work needs it, import it directly instead of rebuilding it.

## 4. Internationalization and light/dark theming

1. **i18n**: the service is `@deepseek-ai/dsh-client-locale`, and its name is still `ctx.locale`. The client's **Cordis** `inject` must list `'locale'` (e.g. `export const inject = ['slots', 'locale']`); register dictionaries inside `ctx.effect(() => ctx.locale.register(NS, { zh, en }))` (both dictionaries carry the same key set; registering the same `(ns, locale)` twice throws, so registration must be disposable), and take a stable `t` from `ctx.locale.bind(NS)`. Components get `t` the supported way: the slot registration declares `locale: NS` and the renderer passes it as the `t` prop — **never** subscribe from a component with `useSyncExternalStore(locale.subscribe, locale.getSnapshot)`. Every visible string goes through `t()`, reusing the `common` vocabulary; external language packs use `ctx.locale.addLanguage({ id, label, fallback })` + `ctx.locale.register(ns, lang, dict)`. The plugin's display name and description on the Plugins page come from `meta.title` / `meta.description` in `locale/en.json` and `locale/zh.json` (`package.json`'s `icon` is a relative-path image, ≤ 256 KiB), and the package exports `./package.json` plus `./locale/*.json`. There is **no** `.i18n({ zh, en })` convention for host Config schemas: describe fields with `description()` and keep UI copy in the locale service.

2. **Light/dark theming**: colors always come from `--dsw-alias-*` semantic tokens — never hardcode `#fff`/`#000`/`rgba(...)` (exceptions: fully transparent, and shiki's fixed highlight colors) — and feature CSS never targets `body[data-ds-dark-theme]` (light/dark overrides belong to ui-theme; plugins only read tokens). Common tokens: text `--dsw-alias-label-primary/secondary/tertiary`, background `--dsw-alias-bg-layer-1/2/3`, borders `--dsw-alias-border-l1~l4`. Use only token names dsh actually defines — a nonexistent name silently fails in dark mode (`bg-module-secondary`, `bg-layer-0`, and `state-danger-primary` do not exist; dsh calls it error, not danger). For the complete list (hover, error, primary button, overlays, ...) read `packages/client/ui-theme/src/styles/design-platform.css` (first choice); without source, grep `design_platform_css_default` in an installed dsh project's (`which dsh` / `where dsh` / `D:\app-tools\dsh-patch` / `~\app-tools\dsh-patch`) `node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js` (an inlined minified string).

## 5. Debugging (dev-profile isolation)

dsh isolates profiles physically: each profile is its own directory under `~/.dsh/profiles/<name>`, so whatever you install there — or deleting the directory to reset it — never touches the main installation or another profile. **All personal development happens in the dev profile.**

- **Creating the dev profile**: no manual directory creation — the first `dsh plugin --profile dev add <plugin>` initializes it. The dev profile contains only `dsh-base` by default; to test a plugin with web UI, also add `dsh plugin --profile dev add @deepseek-ai/dsh-web-app`.
- **Starting the dev instance**: `dsh --profile dev --port 3081` (offset from the default web port 3080), then open `http://127.0.0.1:3081`.
- **Installing or updating a local plugin**: `dsh plugin --profile dev add <absolute path to the plugin>` (run `pnpm build` first, re-run the command to overwrite the update, then restart dev to verify).
- **Confirming the layer is mounted**: `dsh --profile dev --dump-config` prints the composed tree layer by layer; a `# == <package name>` line proves the bundle is in `dsh.profile.bundles`.
- **Removing a plugin**: `dsh plugin --profile dev remove <local plugin path or package name>`.
- When dsh cannot start, use the dsh web error output and logs to locate and fix the cause.

## 6. Prohibitions

- Never run `npm publish` on your own.
- Never modify configuration under `~/.dsh/profiles/web`.

## 7. Compliance notes

- Ignore the checks configured in .gitignore
- Ignore .npmrc checks
- Using `^` in `peerDependencies` is fine (`^0.2.0-rc.2` covers the runtime; the 0.2 peer check includes prereleases)
