/** CSS Modules 的形状（本包不引入 bundler 类型，自带一份最小声明）。 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/** shell 注入的启动信息（目录选择器只用到平台推断所需的部分）。 */
interface Window {
  __DSH_BOOT__?: {
    locale?: string
    [key: string]: unknown
  }
}
