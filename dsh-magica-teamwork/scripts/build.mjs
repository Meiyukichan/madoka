/**
 * 构建：把服务端 + SDK 打成**单个压缩文件** `lib/index.js`，并产一份合并的 `lib/index.d.ts`。
 *
 * 步骤：
 *  1. 把 `src/server/db/migrations/*.sql` 生成为 `src/server/db/migrations.generated.ts`
 *     （单文件产物没有 migrations 目录，SQL 必须内联成字符串）
 *  2. esbuild 打包 `src/index.ts` → `lib/index.js`（ESM、minify、fastify 保持外部依赖）
 *  3. tsc 只出声明到 `.dts/`，再用 dts-bundle-generator 合成单个 `lib/index.d.ts`
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS_DIR = join(ROOT, 'src/server/db/migrations')
const GENERATED = join(ROOT, 'src/server/db/migrations.generated.ts')

function inlineMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) throw new Error('没有找到迁移 SQL')
  const entries = files
    .map((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      // 用 JSON.stringify 保证换行/引号安全
      return `  ${JSON.stringify(f)}: ${JSON.stringify(sql)},`
    })
    .join('\n')
  const content = `// 由 scripts/build.mjs 生成，不要手改
/** 内联的迁移脚本（文件名 → SQL 文本） */
export const EMBEDDED_MIGRATIONS: Readonly<Record<string, string>> = {
${entries}
}
`
  writeFileSync(GENERATED, content, 'utf8')
  console.log(`  inline ${files.length} migration file(s) → src/server/db/migrations.generated.ts`)
}

async function bundle() {
  const result = await build({
    entryPoints: [join(ROOT, 'src/index.ts')],
    outfile: join(ROOT, 'lib/index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    // 依赖交给 node_modules（单文件只含本包源码）
    // @meiyukichan/dsh-magica-spellbook：出站（TLS/代理/闸）+ 日志 + JSON 路由的发布包，runtime 依赖
    external: ['fastify', '@sinclair/typebox', '@meiyukichan/dsh-magica-spellbook'],
    banner: {
      js: '#!/usr/bin/env node',
    },
    logLevel: 'info',
  })
  if (result.errors.length) throw new Error('esbuild 打包失败')
}

/**
 * 组件库产物：`lib/client.js`（ESM）+ 声明。
 *
 * 为什么必须单独产：`exports["./client"]` 指向它；只发 `src/client` 源码时，
 * 消费方的构建器不一定能编译 node_modules 里的 TSX（本仓就踩过）。
 */
async function bundleClient() {
  const result = await build({
    entryPoints: [join(ROOT, 'src/client/index.ts')],
    outfile: join(ROOT, 'lib/client.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    jsx: 'automatic',
    // react / DSH 基线组件由宿主提供（peerDependencies），不打进产物
    external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    logLevel: 'info',
  })
  if (result.errors.length) throw new Error('esbuild 打包 client 失败')
}

function clientDeclarations() {
  const out = join(ROOT, '.dts-client')
  rmSync(out, { recursive: true, force: true })
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    '-p', 'tsconfig.client-dts.json',
  ], { cwd: ROOT, stdio: 'inherit' })
  const built = join(out, 'index.d.ts')
  if (!existsSync(built)) throw new Error('没生成 .dts-client/index.d.ts')
  // 打成一个自包含的 .d.ts（否则 re-export 指向不存在的相对路径）
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/dts-bundle-generator/dist/bin/dts-bundle-generator.js'), '-o', 'lib/client.d.ts', '.dts-client/index.d.ts', '--no-check', '--no-banner'],
    { cwd: ROOT, stdio: 'inherit' },
  )
  rmSync(out, { recursive: true, force: true })
}

function declarations() {
  const dtsDir = join(ROOT, '.dts')
  rmSync(dtsDir, { recursive: true, force: true })
  execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.dts.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  const entry = join(dtsDir, 'index.d.ts')
  if (!existsSync(entry)) throw new Error('没生成 .dts/index.d.ts')
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/dts-bundle-generator/dist/bin/dts-bundle-generator.js'), '-o', 'lib/index.d.ts', '.dts/index.d.ts', '--no-check', '--no-banner'],
    { cwd: ROOT, stdio: 'inherit' },
  )
  rmSync(dtsDir, { recursive: true, force: true })
}

console.log('构建 dsh-magica-teamwork')
inlineMigrations()
mkdirSync(join(ROOT, 'lib'), { recursive: true })
await bundle()
await bundleClient()
clientDeclarations()
declarations()
console.log('产物：lib/index.js + lib/index.d.ts + lib/client.js + lib/client.d.ts')
