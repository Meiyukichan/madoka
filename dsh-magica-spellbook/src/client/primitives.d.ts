/**
 * 这里**没有**任何类型声明了（保留文件名只是为了不改动 `tsconfig` 的 include 与历史引用）。
 *
 * 为什么：
 * - `@deepseek-ai/dsh-client-ui-primitives` 从 `0.2.0-rc.2` 起就在 `devDependencies` /
 *   `peerDependencies` 里（运行期由 dsh shell 的**模块表**注入，构建时依旧当 external），
 *   所以 `Button` / `Modal` / `MarkdownText` 的签名直接来自真实包的
 *   `lib/types/*.d.ts`，不需要、也不允许在这里再手写一份"最小类型面"。
 * - 早前本文件用 `declare module '@deepseek-ai/dsh-client-ui-primitives'` 手写了三个组件
 *   与一串 `Icon*` 形状；那是按 0.1.6 命名猜出来的（`IconCheckOutline14` 之类根本不存在），
 *   而且和真实签名会静默漂移。全部删除。
 *
 * 消费方式（不变）：
 * ```ts
 * import { Button, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
 * ```
 *
 * 图标见 `client/panel/icons.tsx` 头部注释（上游 d.ts 漏发布 `icons/index.d.ts`，
 * 那是那一个文件里的局部说明，不是这里的模块声明）。
 *
 * @module dsh-magica-spellbook/client/primitives
 */

export {}
