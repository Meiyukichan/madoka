/** teamwork 打包修正：补 client 产物（组件库），让发布包的 `./client` 真的可用。 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

// 1) 构建脚本加 client bundle（ESM + 只保留 react 外部依赖）
{
  const file = 'scripts/build.mjs'
  let text = readFileSync(file, 'utf8')
  if (!text.includes('async function bundleClient()')) {
    text = text.replace('function declarations() {', `/**
 * 组件库产物：\`lib/client.js\`（ESM）+ 声明。
 *
 * 为什么必须单独产：\`exports["./client"]\` 指向它；只发 \`src/client\` 源码时，
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
    // react 由宿主提供（peerDependencies），不打进产物
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    logLevel: 'info',
  })
  if (result.errors.length) throw new Error('esbuild 打包 client 失败')
}

function declarations() {`)
    text = text.replace('await bundle()\ndeclarations()', 'await bundle()\nawait bundleClient()\nclientDeclarations()\ndeclarations()')
    text = text.replace("console.log('产物：lib/index.js（压缩） + lib/index.d.ts')", "console.log('产物：lib/index.js + lib/index.d.ts + lib/client.js + lib/client.d.ts')")
    // client 声明：单独 tsc（复用 client 配置，只出声明）
    if (!text.includes('function clientDeclarations()')) {
      text = text.replace('function declarations() {', `function clientDeclarations() {
  const out = join(ROOT, '.dts-client')
  rmSync(out, { recursive: true, force: true })
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    '-p', 'tsconfig.client.json',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir', out,
  ], { cwd: ROOT, stdio: 'inherit' })
  const built = join(out, 'index.d.ts')
  if (existsSync(built)) {
    writeFileSync(join(ROOT, 'lib/client.d.ts'), readFileSync(built, 'utf8'), 'utf8')
  }
  rmSync(out, { recursive: true, force: true })
}

function declarations() {`)
    }
    writeFileSync(file, text)
  }
}

// 2) exports 指向产物
{
  const file = 'package.json'
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.exports['./client'] = {
    types: './lib/client.d.ts',
    default: './lib/client.js',
  }
  pkg.files = ['lib', 'docs', 'README.md']
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log('exports["./client"] →', JSON.stringify(pkg.exports['./client']))
}
console.log('patched teamwork build')
