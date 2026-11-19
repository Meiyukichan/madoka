/**
 * 类型垫片：0.2.1 起 client 包（store / ui-primitives / ui-slots）不再作为独立包
 * 出现在 dsh 的安装树里（被打进 shell 的 client bundle），registry 上也没有对应版本。
 *
 * 运行时它们由 shell 的模块表注入（基座 external），所以这里只需要**类型形状**。
 * 声明刻意宽松：只保证本包用到的符号存在，细节以 shell 为准；
 * 行为一致性由 E2E（真开浏览器）保证，而不是靠这份声明。
 */
declare module '@deepseek-ai/dsh-client-store' {
  export interface Store<T> {
    getSnapshot(): T
    update(mutator: (draft: T) => void): void
    subscribe(listener: () => void): () => void
  }

  /** 工厂形式：`defineStore({ init, actions })`。 */
  export function defineStore<T, A extends Record<string, (draft: T, ...args: never[]) => void>>(options: {
    init: () => T
    actions: A
  }): Store<T>

  /** controller 用的快照 store 工厂。 */
  export function createSnapshotStore<T>(init: T, ...rest: unknown[]): Store<T> & { set(next: T): void }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
  export interface PropsLocale {
    t(key: string, params?: Record<string, string>): string
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export type IconComponent = (props: any) => any
  export const Button: (props: any) => any
  export const Input: (props: any) => any
  export const Menu: (props: any) => any
  export const Modal: (props: any) => any
  export const Tooltip: (props: any) => any
  export const IconChevronUpOutlineRegular: (props: any) => any
  export const IconChevronDownOutlineRegular: (props: any) => any
}