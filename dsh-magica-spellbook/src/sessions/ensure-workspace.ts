/**
 * dsh 工作区查找 / 创建。
 *
 * 降级 vs 抛错的刻意不对称：
 * - `ensureWorkspace` / `findWorkspace` 缺 registry → `undefined`（软降级：headless / 测试部署也能跑）；
 * - `createWorkspace` 缺 registry → 抛错（硬失败：调用方明确要"建"）。
 *
 * 路径只做**纯字符串归一**，不自己做 realpath —— dsh 的 `create()` / `resolveByPath()` 内部才是唯一 canon。
 *
 * @module dsh-magica-spellbook/sessions/ensure-workspace
 */

import { normalize } from 'node:path'
import {
  asSessionId,
  serviceOf,
  type DshWorkspaceLike,
  type DshWorkspaceRegistryLike,
} from '../shared/dsh.ts'

/** 登记选项。 */
export interface EnsureWorkspaceOptions {
  /** 新建时的显示标题（默认 `basename(path)`，由 dsh 决定）。已存在时忽略。 */
  title?: string
  /** 找到 / 新建后把该会话挂进成员表。 */
  attachSessionId?: string
}

/** 取 registry（不做形状校验，缺失返回 `undefined`）。 */
export function getWorkspaceRegistry(ctx: unknown): DshWorkspaceRegistryLike | undefined {
  return serviceOf<DshWorkspaceRegistryLike>(ctx, 'workspaceRegistry')
}

/**
 * 纯字符串路径归一：`normalize` + 剥尾部分隔符（保留盘符根）。
 * @param input - 任意拼写的项目路径。
 */
export function normalizeProjectPath(input: string): string {
  if (input === '') return input
  let result = normalize(input)
  while (result.length > 1 && (result.endsWith('\\') || result.endsWith('/'))) {
    const stripped = result.slice(0, -1)
    if (/^[A-Za-z]:$/.test(stripped)) break
    result = stripped
  }
  return result
}

/** 仅查找（不创建）。 */
export async function findWorkspace(ctx: unknown, projectPath: string): Promise<DshWorkspaceLike | undefined> {
  if (projectPath === '') throw new Error('findWorkspace: projectPath must not be empty')
  const registry = getWorkspaceRegistry(ctx)
  if (registry === undefined) return undefined
  return registry.resolveByPath(normalizeProjectPath(projectPath))
}

/** 查找或创建，并可选 attach 一个会话。 */
export async function ensureWorkspace(
  ctx: unknown,
  projectPath: string,
  options: EnsureWorkspaceOptions = {},
): Promise<DshWorkspaceLike | undefined> {
  if (projectPath === '') throw new Error('ensureWorkspace: projectPath must not be empty')
  const registry = getWorkspaceRegistry(ctx)
  if (registry === undefined) return undefined
  const normalized = normalizeProjectPath(projectPath)
  const existing = await registry.resolveByPath(normalized)
  const workspace = existing ?? (await registry.create(normalized, options.title))
  if (options.attachSessionId !== undefined && typeof workspace.attachSession === 'function') {
    await workspace.attachSession(asSessionId(options.attachSessionId))
  }
  return workspace
}

/** 强制创建（registry 不可用时抛错）。 */
export async function createWorkspace(
  ctx: unknown,
  projectPath: string,
  title?: string,
): Promise<DshWorkspaceLike> {
  if (projectPath === '') throw new Error('createWorkspace: projectPath must not be empty')
  const registry = getWorkspaceRegistry(ctx)
  if (registry === undefined) {
    throw new Error(
      'createWorkspace: ctx.workspaceRegistry is not available '
        + '(headless/test deployment without dsh-workspace package)',
    )
  }
  return registry.create(normalizeProjectPath(projectPath), title)
}
