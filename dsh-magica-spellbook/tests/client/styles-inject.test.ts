import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { INTERACTION_STYLE_ID, injectInteractionStyles } from '../../src/client/panel/styles.ts'

/**
 * 最小 DOM 桩：只实现 `injectInteractionStyles` 用到的部分。
 * Node 里没有 DOM，但这段逻辑（引用计数 + HMR 摘标签后重挂）值得单测。
 */
interface StubStyle {
  id: string
  textContent: string
  dataset: Record<string, string>
  removed: boolean
  remove(): void
}

function installDom() {
  const children: StubStyle[] = []
  const make = (): StubStyle => ({
    id: '',
    textContent: '',
    dataset: {},
    removed: false,
    remove() {
      this.removed = true
      const index = children.indexOf(this)
      if (index >= 0) children.splice(index, 1)
    },
  })
  const documentStub = {
    head: {
      appendChild(node: StubStyle) {
        children.push(node)
        return node
      },
    },
    createElement() {
      return make()
    },
    getElementById(id: string) {
      return children.find((node) => node.id === id) ?? null
    },
  }
  ;(globalThis as Record<string, unknown>)['document'] = documentStub
  return { children, document: documentStub, removeAll: () => { for (const node of [...children]) node.remove() } }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['document']
})

describe('injectInteractionStyles', () => {
  it('首次注入建一个标签，写 data-plugin 与 data-plugin-css', () => {
    const dom = installDom()
    const release = injectInteractionStyles('@acme/panel')
    assert.equal(dom.children.length, 1)
    const tag = dom.children[0]
    assert.equal(tag?.id, INTERACTION_STYLE_ID)
    assert.equal(tag?.dataset['plugin'], '@acme/panel')
    // 0.2 的 HMR 按这个属性回收样式产物（diff D11-3）：必须是样式 id，不能是空串
    assert.equal(tag?.dataset['pluginCss'], INTERACTION_STYLE_ID)
    release()
  })

  it('引用计数：两次注入一次释放后标签仍在、插件标记为后者', () => {
    const dom = installDom()
    const a = injectInteractionStyles('a')
    const b = injectInteractionStyles('b')
    assert.equal(dom.children.length, 1)
    assert.equal(dom.children[0]?.dataset['plugin'], 'b')
    a()
    assert.equal(dom.children.length, 1, '还有一个持有者，不能摘')
    b()
    assert.equal(dom.children.length, 0)
  })

  it('HMR 摘掉标签后再注入会重新挂上（不信任缓存句柄）', () => {
    const dom = installDom()
    const a = injectInteractionStyles('a')
    // 模拟外部 HMR 把标签摘走
    dom.removeAll()
    assert.equal(dom.children.length, 0)
    const b = injectInteractionStyles('b')
    assert.equal(dom.children.length, 1, '必须重新建出来')
    assert.equal(dom.children[0]?.dataset['plugin'], 'b')
    b()
    a()
    assert.equal(dom.children.length, 0)
  })

  it('重复释放幂等', () => {
    const dom = installDom()
    const release = injectInteractionStyles('once')
    release()
    release()
    assert.equal(dom.children.length, 0)
  })
})
