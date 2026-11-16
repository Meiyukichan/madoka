/**
 * 冒烟脚本入口：先跑迁移断言，再验证单文件产物能自举。
 *
 *   pnpm smoke
 */
import '../src/server/db/smoke.js'
