import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSkillSource, SKILL_CATALOG_DESCRIPTION_MAX_LENGTH } from '../src/builtin-skill.ts'

const wrap = (frontmatter: string, body = '# Title\n\n正文。'): string => `---\n${frontmatter}\n---\n\n${body}\n`

describe('parseSkillSource', () => {
  it('解析出 name / description / 正文', () => {
    const parsed = parseSkillSource(wrap('name: demo-skill\ndescription: 一句话说明'), 'demo-skill')
    assert.equal(parsed.name, 'demo-skill')
    assert.equal(parsed.description, '一句话说明')
    assert.equal(parsed.body.trim(), '# Title\n\n正文。')
    assert.equal(parsed.modelInvocable, true)
    assert.equal(parsed.userInvocable, true)
  })

  it('容忍 UTF-8 BOM 与 CRLF', () => {
    const raw = `\uFEFF---\r\nname: demo-skill\r\ndescription: d\r\n---\r\n\r\nbody\r\n`
    const parsed = parseSkillSource(raw, 'demo-skill')
    assert.equal(parsed.name, 'demo-skill')
    assert.equal(parsed.body.trim(), 'body')
  })

  it('去引号', () => {
    const parsed = parseSkillSource(wrap(`name: 'demo-skill'\ndescription: "带引号"`), 'demo-skill')
    assert.equal(parsed.description, '带引号')
  })

  it('缺 frontmatter 围栏 → 抛', () => {
    assert.throws(() => parseSkillSource('# 没有 frontmatter\n', 'demo-skill'), /missing YAML frontmatter/)
  })

  it('缺闭合围栏 → 抛', () => {
    assert.throws(() => parseSkillSource('---\nname: demo-skill\n', 'demo-skill'), /closing/)
  })

  it('name 与目录名不符 → 抛', () => {
    assert.throws(
      () => parseSkillSource(wrap('name: other-name\ndescription: d'), 'demo-skill'),
      /must match its directory name/,
    )
  })

  it('name 非 kebab-case → 抛', () => {
    assert.throws(
      () => parseSkillSource(wrap('name: Demo_Skill\ndescription: d'), 'Demo_Skill'),
      /kebab-case/,
    )
  })

  it('缺 description → 抛', () => {
    assert.throws(() => parseSkillSource(wrap('name: demo-skill'), 'demo-skill'), /"description"/)
  })

  it('whenToUse 非空才算', () => {
    assert.equal(parseSkillSource(wrap('name: a-b\ndescription: d\nwhenToUse: 用在 X'), 'a-b').whenToUse, '用在 X')
    assert.equal(parseSkillSource(wrap('name: a-b\ndescription: d\nwhenToUse:'), 'a-b').whenToUse, undefined)
  })

  it('disable-model-invocation → modelInvocable:false', () => {
    const parsed = parseSkillSource(wrap('name: a-b\ndescription: d\ndisable-model-invocation: true'), 'a-b')
    assert.equal(parsed.modelInvocable, false)
    assert.equal(parsed.userInvocable, true)
  })

  it('disable-user-invocation 与 user-invocable 都认，前者优先', () => {
    assert.equal(parseSkillSource(wrap('name: a-b\ndescription: d\ndisable-user-invocation: true'), 'a-b').userInvocable, false)
    assert.equal(parseSkillSource(wrap('name: a-b\ndescription: d\nuser-invocable: false'), 'a-b').userInvocable, false)
    const both = parseSkillSource(wrap('name: a-b\ndescription: d\ndisable-user-invocation: false\nuser-invocable: false'), 'a-b')
    assert.equal(both.userInvocable, true, 'disable-user-invocation 优先')
  })
})

describe('内置资源（随包分发）', () => {
  const dir = fileURLToPath(new URL('../resources/dsh-plugins-principles/', import.meta.url))
  const file = `${dir}SKILL.md`

  it('SKILL.md 存在且能被解析', () => {
    assert.equal(existsSync(file), true, 'resources/dsh-plugins-principles/SKILL.md 必须存在')
    const parsed = parseSkillSource(readFileSync(file, 'utf8'), 'dsh-plugins-principles')
    assert.equal(parsed.name, 'dsh-plugins-principles')
    assert.ok(parsed.description.length > 0, 'description 不能为空')
    assert.ok(parsed.body.trim().length > 0, '正文不能为空')
  })

  it('description 未超过 catalog 自截断阈值（否则目录里会被截）', () => {
    const parsed = parseSkillSource(readFileSync(file, 'utf8'), 'dsh-plugins-principles')
    assert.ok(
      parsed.description.length <= SKILL_CATALOG_DESCRIPTION_MAX_LENGTH,
      `description 有 ${parsed.description.length} 字符，超过 ${SKILL_CATALOG_DESCRIPTION_MAX_LENGTH}`,
    )
  })
})
