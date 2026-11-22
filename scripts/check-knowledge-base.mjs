#!/usr/bin/env node
/**
 * TraceMemo 知识库引用与断链自动化校验脚本
 *
 * 零第三方依赖纯 Node ESM：
 * 1. 遍历指定路径，或默认扫描根目录 AGENTS.md、README.md 及 docs/ 下全部 Markdown（默认排除 docs/skill/）。
 * 2. 校验所有 Markdown 相对链接 [text](path#anchor) 与 HTML <img src="..."> / <a href="...">：
 *    - 目标文件/目录在仓库中真实存在
 *    - 若含 #L123 / #L123-L456 行号锚点，校验目标文件存在且行号不越界
 *    - 若含 #heading-slug 标题锚点，按 GitHub GFM slug 规则校验目标 Markdown 标题存在
 * 3. 校验所有反引号包裹的仓库路径引用（10 个核心目录前缀）：
 *    - src/、packages/、scripts/、services/、examples/、tests/、docs/、resources/、build/、public/
 *    - 仅对经实证确认的 3 个 .gitignore 构建/运行时注入目录及显式占位符/通配符做受控处理，
 *      其余任何不存在的路径均直接判定为错误并返回非 0 退出码。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

const REPO_DIR_PREFIXES = [
  'src/',
  'packages/',
  'scripts/',
  'services/',
  'examples/',
  'tests/',
  'docs/',
  'resources/',
  'build/',
  'public/'
]

/**
 * 经实证确认的 .gitignore 构建产物 / 运行时注入目录（非仓库跟踪静态源码目录）。
 * 严禁在此处加入真实源码目录前缀。
 */
const GITIGNORED_RUNTIME_OR_BUILD_DIRS = [
  {
    prefix: 'resources/runtime/darwin-arm64',
    reason: '.gitignore:13 忽略的原生发送运行时注入目录（由 scripts/prepare-wechat-native-runtime.cjs 同步）'
  },
  {
    prefix: 'build/extension-templates',
    reason: '.gitignore:42 忽略的构建期扩展模板产物目录（由 scripts/build-extension-templates.cjs 生成）'
  },
  {
    prefix: 'build/mac-staging',
    reason: '.gitignore:34 忽略的 macOS 双版构建暂存目录（由 scripts/prepare-macos-edition.cjs 使用）'
  }
]

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function relFromRepo(absPath) {
  return toPosix(path.relative(REPO_ROOT, absPath)) || '.'
}

function isInsideRepo(absPath) {
  const rel = path.relative(REPO_ROOT, absPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 将 Markdown 文本按行剥离 fenced code blocks（``` 或 ~~~），保留 1-based 行号。
 */
function stripFencedCodeLines(content) {
  const rawLines = content.split(/\r?\n/)
  const lines = []
  let activeFenceChar = null
  let activeFenceLen = 0

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]
    const trimmedStart = line.trimStart()

    if (!activeFenceChar) {
      const openMatch = trimmedStart.match(/^(`{3,}|~{3,})(.*)$/)
      if (openMatch) {
        const fence = openMatch[1]
        const info = openMatch[2]
        // 反引号围栏的 info string 不能包含反引号
        if (!(fence[0] === '`' && info.includes('`'))) {
          activeFenceChar = fence[0]
          activeFenceLen = fence.length
          lines.push({ lineNumber: i + 1, text: '', inFence: true })
          continue
        }
      }
      lines.push({ lineNumber: i + 1, text: line, inFence: false })
    } else {
      const closeMatch = trimmedStart.match(/^(`{3,}|~{3,})\s*$/)
      if (
        closeMatch &&
        closeMatch[1][0] === activeFenceChar &&
        closeMatch[1].length >= activeFenceLen
      ) {
        activeFenceChar = null
        activeFenceLen = 0
      }
      lines.push({ lineNumber: i + 1, text: '', inFence: true })
    }
  }

  return { rawLines, lines }
}

/**
 * 按 GitHub (github-slugger) 规则生成标题 slug：
 * - 去除 Markdown 链接/图片/常见内联格式标记
 * - 小写化
 * - 删除除字母、数字、空白、下划线、连字符外的字符
 * - 逐个空白字符替换为 '-'（不折叠连续空格，保证 `Agent / API` -> `agent--api`）
 */
function toGitHubHeadingSlug(rawHeading) {
  let text = rawHeading.trim()
  // 去掉可选尾部关闭井号 `## Title ##`
  text = text.replace(/\s+#+\s*$/, '').trim()
  // 图片 ![alt](url) -> alt，链接 [label](url) -> label
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 行内 HTML 标签
  text = text.replace(/<[^>]+>/g, '')
  // 行内代码反引号与常见强调符
  text = text.replace(/[`*~]/g, '')

  const lowered = text.toLowerCase()
  const cleaned = lowered.replace(/[^\p{L}\p{N}\s_-]/gu, '')
  return cleaned.replace(/\s/g, '-')
}

const markdownMetaCache = new Map()

function getFileLineCount(absPath) {
  const key = `lines:${absPath}`
  if (markdownMetaCache.has(key)) return markdownMetaCache.get(key)
  const content = fs.readFileSync(absPath, 'utf8')
  const count = content.split(/\r?\n/).length
  markdownMetaCache.set(key, count)
  return count
}

function getMarkdownHeadingSlugs(absPath) {
  const key = `slugs:${absPath}`
  if (markdownMetaCache.has(key)) return markdownMetaCache.get(key)

  const content = fs.readFileSync(absPath, 'utf8')
  const { lines } = stripFencedCodeLines(content)
  const slugs = new Set()
  const occurrences = new Map()

  for (const entry of lines) {
    if (entry.inFence) continue
    const headingMatch = entry.text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)
    if (!headingMatch) continue
    const baseSlug = toGitHubHeadingSlug(headingMatch[1])
    if (!baseSlug) continue
    const count = occurrences.get(baseSlug) ?? 0
    occurrences.set(baseSlug, count + 1)
    const finalSlug = count === 0 ? baseSlug : `${baseSlug}-${count}`
    slugs.add(finalSlug)
  }

  markdownMetaCache.set(key, slugs)
  return slugs
}

/**
 * 遮蔽行内反引号片段（用等长空格替代），避免把 `` `[文字](path)` `` 误识别为 Markdown 链接。
 */
function maskInlineCode(lineText) {
  let result = ''
  let i = 0
  while (i < lineText.length) {
    if (lineText[i] === '`') {
      let tickCount = 0
      while (i + tickCount < lineText.length && lineText[i + tickCount] === '`') {
        tickCount += 1
      }
      const fence = '`'.repeat(tickCount)
      const closeIndex = lineText.indexOf(fence, i + tickCount)
      if (closeIndex !== -1) {
        const spanLen = closeIndex + tickCount - i
        result += ' '.repeat(spanLen)
        i = closeIndex + tickCount
        continue
      }
      result += fence
      i += tickCount
      continue
    }
    result += lineText[i]
    i += 1
  }
  return result
}

/**
 * 从单行提取所有行内反引号片段内容（不跨换行，忽略多反引号空片段）。
 */
function extractInlineCodeSpans(lineText) {
  const spans = []
  let i = 0
  while (i < lineText.length) {
    if (lineText[i] === '`') {
      let tickCount = 0
      while (i + tickCount < lineText.length && lineText[i + tickCount] === '`') {
        tickCount += 1
      }
      const fence = '`'.repeat(tickCount)
      const closeIndex = lineText.indexOf(fence, i + tickCount)
      if (closeIndex !== -1) {
        const inner = lineText.slice(i + tickCount, closeIndex).trim()
        if (inner) spans.push(inner)
        i = closeIndex + tickCount
        continue
      }
      i += tickCount
      continue
    }
    i += 1
  }
  return spans
}

/**
 * 从非代码片段中提取 Markdown 链接 `[...](...)` / `![...](...)` 与 HTML `src="..."` / `href="..."`。
 */
function extractLinksFromLine(maskedLine) {
  const results = []

  // 1. Markdown 链接/图片：支持可选 <target> 与可选 "title" / 'title'，允许目标中一层平衡括号
  let idx = 0
  while (idx < maskedLine.length) {
    const openBracket = maskedLine.indexOf('[', idx)
    if (openBracket === -1) break

    // 跳过转义 \[
    if (openBracket > 0 && maskedLine[openBracket - 1] === '\\') {
      idx = openBracket + 1
      continue
    }

    const closeBracket = maskedLine.indexOf(']', openBracket + 1)
    if (closeBracket === -1) break

    if (maskedLine[closeBracket + 1] !== '(') {
      idx = closeBracket + 1
      continue
    }

    // 解析 (...)，支持一层平衡括号与 <...>
    let pos = closeBracket + 2
    let depth = 1
    let inQuotes = null
    while (pos < maskedLine.length && depth > 0) {
      const ch = maskedLine[pos]
      if (inQuotes) {
        if (ch === inQuotes && maskedLine[pos - 1] !== '\\') {
          inQuotes = null
        }
      } else if (ch === '"' || ch === "'") {
        inQuotes = ch
      } else if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
      pos += 1
    }

    if (depth === 0) {
      const rawInner = maskedLine.slice(closeBracket + 2, pos).trim()
      if (rawInner) {
        let target = rawInner
        if (target.startsWith('<')) {
          const endAngle = target.indexOf('>')
          if (endAngle !== -1) {
            target = target.slice(1, endAngle).trim()
          }
        } else {
          // 剥离尾部可选 title："..." 或 '...'
          const titleMatch = target.match(/^(\S+?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/)
          if (titleMatch) {
            target = titleMatch[1]
          }
        }
        if (target) {
          results.push({ kind: 'markdown', target })
        }
      }
      idx = pos + 1
    } else {
      idx = closeBracket + 2
    }
  }

  // 2. HTML <img src="..."> / <a href="...">
  const htmlAttrRegex = /<(?:img|a)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi
  let htmlMatch
  while ((htmlMatch = htmlAttrRegex.exec(maskedLine)) !== null) {
    const target = (htmlMatch[1] ?? htmlMatch[2] ?? '').trim()
    if (target) {
      results.push({ kind: 'html', target })
    }
  }

  return results
}

function isExternalUrl(target) {
  return /^(https?:|mailto:|tel:|data:|javascript:)/i.test(target)
}

/**
 * 展开一层或多层 `{a,b}` 花括号集合（仅当花括号内包含逗号时视为集合展开，否则保留给占位符逻辑）。
 */
function expandBraces(input) {
  const match = input.match(/\{([^{}]*,[^{}]*)\}/)
  if (!match) return [input]

  const full = match[0]
  const options = match[1].split(',').map((s) => s.trim())
  const before = input.slice(0, match.index)
  const after = input.slice(match.index + full.length)

  const expanded = []
  for (const opt of options) {
    for (const tail of expandBraces(after)) {
      expanded.push(`${before}${opt}${tail}`)
    }
  }
  return expanded
}

function findGitignoredWhitelistMatch(repoRelPath) {
  const normalized = repoRelPath.replace(/\/+$/, '')
  for (const item of GITIGNORED_RUNTIME_OR_BUILD_DIRS) {
    if (normalized === item.prefix || normalized.startsWith(`${item.prefix}/`)) {
      return item
    }
  }
  return null
}

function parseColonLineRanges(spec) {
  const ranges = []
  for (const part of spec.split(/[,:]/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)(?:[-–—](\d+))?$/)
    if (!match) return null
    const start = Number.parseInt(match[1], 10)
    const end = match[2] ? Number.parseInt(match[2], 10) : start
    ranges.push({ start, end, raw: `:${trimmed}` })
  }
  return ranges.length > 0 ? ranges : null
}

/**
 * 规范化并拆解反引号包裹的仓库路径引用，保留行号范围用于后续校验。
 */
function normalizeBacktickRepoCandidate(rawSpan) {
  let text = rawSpan.trim()

  // 去掉末尾误带入的中文/英文标点
  text = text.replace(/[,，。；;)\]】」』]+$/u, '').trim()

  // 若含空白（如 `scripts/build-extension-templates.cjs --check`），若整体不是真实路径则取首 token
  if (/\s/.test(text)) {
    const wholeAbs = path.resolve(REPO_ROOT, text)
    if (!fs.existsSync(wholeAbs)) {
      text = text.split(/\s+/)[0]
      text = text.replace(/[,，。；;)\]】」』]+$/u, '').trim()
    }
  }

  let lineRanges = []

  // 提取并剥离行号 / 锚点后缀：#L123、#L123-L456、:123、:123-456、:12–34、:10,20
  const hashLineMatch = text.match(/#L(\d+)(?:[-–—]L?(\d+))?$/i)
  if (hashLineMatch) {
    const start = Number.parseInt(hashLineMatch[1], 10)
    const end = hashLineMatch[2] ? Number.parseInt(hashLineMatch[2], 10) : start
    lineRanges = [{ start, end, raw: hashLineMatch[0] }]
    text = text.slice(0, hashLineMatch.index)
  } else {
    const colonLineMatch = text.match(/:(\d+(?:[-–—]\d+)?(?:[,:]\d+(?:[-–—]\d+)?)*)$/)
    if (colonLineMatch) {
      const parsed = parseColonLineRanges(colonLineMatch[1])
      if (parsed) {
        lineRanges = parsed
        text = text.slice(0, colonLineMatch.index)
      }
    }
  }

  return { path: text, lineRanges }
}

function startsWithRepoPrefix(text) {
  return REPO_DIR_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/**
 * 解析单段路径的通配 / 占位符语义：
 * - 支持 `*`、`?`、`**`、规范占位符 `<name>` 与模板变量 `${expr}`
 * - 拒绝未展开的独立 `{only-one}` 或残缺 `<` / `>`（按字面路径校验，不允许绕过）
 */
function parsePatternSegment(seg) {
  if (seg === '**') {
    return { isPattern: true, isGlobstar: true, regex: null }
  }

  // 先检查模板变量 `${...}` 与 `<...>` 占位符合法性
  const withoutTemplateVars = seg.replace(/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g, '')
  if (/[{}]/.test(withoutTemplateVars)) {
    // 含非 `${...}` 的 `{...}`（如单元素 `{only-one}`），按字面路径处理
    return { isPattern: false, isGlobstar: false, regex: null }
  }

  const withoutPlaceholders = withoutTemplateVars.replace(/<[A-Za-z0-9._-]+>/g, '')
  if (/[<>]/.test(withoutPlaceholders)) {
    // 残缺尖括号（如 `<id`、`id>`、`<>`），按字面路径处理
    return { isPattern: false, isGlobstar: false, regex: null }
  }

  const hasWildcardOrPlaceholder =
    seg !== withoutTemplateVars ||
    withoutTemplateVars !== withoutPlaceholders ||
    /[*?]/.test(seg)

  if (!hasWildcardOrPlaceholder) {
    return { isPattern: false, isGlobstar: false, regex: null }
  }

  // 构建整段匹配正则：先用占位标记替换合法占位符与通配符，再转义其余字面字符
  let tokenized = seg
  const tokens = []
  tokenized = tokenized.replace(/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g, () => {
    const idx = tokens.push('.+') - 1
    return `\u0000TOK${idx}\u0000`
  })
  tokenized = tokenized.replace(/<[A-Za-z0-9._-]+>/g, () => {
    const idx = tokens.push('.+') - 1
    return `\u0000TOK${idx}\u0000`
  })
  tokenized = tokenized.replace(/\*/g, () => {
    const idx = tokens.push('.*') - 1
    return `\u0000TOK${idx}\u0000`
  })
  tokenized = tokenized.replace(/\?/g, () => {
    const idx = tokens.push('.') - 1
    return `\u0000TOK${idx}\u0000`
  })

  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regexSrc =
    '^' + escaped.replace(/\u0000TOK(\d+)\u0000/g, (_, idx) => tokens[Number(idx)]) + '$'
  return { isPattern: true, isGlobstar: false, regex: new RegExp(regexSrc) }
}

function validatePatternSegments(absDir, relDir, segments, idx, requiresDir, repoRelPath) {
  if (idx >= segments.length) {
    if (requiresDir && !fs.statSync(absDir).isDirectory()) {
      return { status: 'error', reason: `路径以 / 结尾但目标不是目录: ${repoRelPath}` }
    }
    return { status: 'ok' }
  }

  const seg = segments[idx]
  const isLast = idx === segments.length - 1
  const parsed = parsePatternSegment(seg)
  const whitelisted = findGitignoredWhitelistMatch(relDir)

  if (!parsed.isPattern) {
    const nextRel = relDir ? `${relDir}/${seg}` : seg
    const nextAbs = path.join(absDir, seg)
    if (!isInsideRepo(nextAbs)) {
      return { status: 'error', reason: `路径越界出仓库根目录: ${repoRelPath}` }
    }
    if (!fs.existsSync(nextAbs)) {
      const nextWhitelisted = findGitignoredWhitelistMatch(nextRel) || whitelisted
      if (nextWhitelisted) {
        return {
          status: 'warning',
          reason: `匹配受控 .gitignore 运行时/构建目录（${nextWhitelisted.reason}）`
        }
      }
      return { status: 'error', reason: `仓库路径不存在: ${repoRelPath}` }
    }
    if (!isLast) {
      if (!fs.statSync(nextAbs).isDirectory()) {
        return { status: 'error', reason: `路径中间段不是目录 (${nextRel}): ${repoRelPath}` }
      }
      return validatePatternSegments(nextAbs, nextRel, segments, idx + 1, requiresDir, repoRelPath)
    }
    if (requiresDir && !fs.statSync(nextAbs).isDirectory()) {
      return { status: 'error', reason: `路径以 / 结尾但目标不是目录: ${repoRelPath}` }
    }
    return { status: 'ok' }
  }

  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    if (whitelisted) {
      return {
        status: 'warning',
        reason: `匹配受控 .gitignore 运行时/构建目录（${whitelisted.reason}）`
      }
    }
    return { status: 'error', reason: `模式路径的父目录不存在: ${relDir}/` }
  }

  if (parsed.isGlobstar) {
    if (isLast) {
      return { status: 'ok' }
    }
    // 深度遍历当前目录及所有子目录，至少有一条路径能匹配剩余段
    const stack = [{ abs: absDir, rel: relDir }]
    while (stack.length > 0) {
      const current = stack.pop()
      const directRes = validatePatternSegments(
        current.abs,
        current.rel,
        segments,
        idx + 1,
        requiresDir,
        repoRelPath
      )
      if (directRes.status === 'ok' || directRes.status === 'warning') {
        return directRes
      }
      const entries = fs.readdirSync(current.abs, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push({
          abs: path.join(current.abs, entry.name),
          rel: current.rel ? `${current.rel}/${entry.name}` : entry.name
        })
      }
    }
    if (whitelisted) {
      return {
        status: 'warning',
        reason: `匹配受控 .gitignore 运行时/构建目录（${whitelisted.reason}）`
      }
    }
    return { status: 'error', reason: `通配模式未匹配到任何真实文件或目录: ${repoRelPath}` }
  }

  const entries = fs.readdirSync(absDir, { withFileTypes: true })
  const matched = entries.filter((entry) => parsed.regex.test(entry.name))

  if (isLast) {
    const validHits = requiresDir ? matched.filter((entry) => entry.isDirectory()) : matched
    if (validHits.length > 0) {
      return { status: 'ok' }
    }
    if (whitelisted) {
      return {
        status: 'warning',
        reason: `匹配受控 .gitignore 运行时/构建目录（${whitelisted.reason}）`
      }
    }
    return { status: 'error', reason: `通配/占位模式未匹配到任何真实文件或目录: ${repoRelPath}` }
  }

  const matchedDirs = matched.filter((entry) => entry.isDirectory())
  for (const dirEntry of matchedDirs) {
    const nextRel = relDir ? `${relDir}/${dirEntry.name}` : dirEntry.name
    const nextAbs = path.join(absDir, dirEntry.name)
    const subRes = validatePatternSegments(
      nextAbs,
      nextRel,
      segments,
      idx + 1,
      requiresDir,
      repoRelPath
    )
    if (subRes.status === 'ok' || subRes.status === 'warning') {
      return subRes
    }
  }

  if (whitelisted) {
    return {
      status: 'warning',
      reason: `匹配受控 .gitignore 运行时/构建目录（${whitelisted.reason}）`
    }
  }
  return {
    status: 'error',
    reason: `通配/占位路径后续子段未匹配到任何真实目录或文件: ${repoRelPath}`
  }
}

/**
 * 校验单个展开后的仓库路径（支持精确路径、行号范围与安全通配/占位段递归校验）。
 */
function validateSingleRepoPath(repoRelPath, lineRanges = []) {
  const normalized = toPosix(repoRelPath).replace(/^\.\//, '')
  const cleanNoTrailingSlash = normalized.replace(/\/+$/, '')
  const requiresDir = normalized.endsWith('/')

  if (!startsWithRepoPrefix(`${cleanNoTrailingSlash}/`) && !startsWithRepoPrefix(normalized)) {
    return { status: 'error', reason: '路径未落在受控仓库目录前缀下' }
  }

  const segments = cleanNoTrailingSlash.split('/').filter(Boolean)
  const hasAnyPattern = segments.some((seg) => parsePatternSegment(seg).isPattern)

  if (hasAnyPattern) {
    if (lineRanges.length > 0) {
      return { status: 'error', reason: `通配或占位路径不支持行号后缀: ${repoRelPath}` }
    }
    const firstPatternIdx = segments.findIndex((seg) => parsePatternSegment(seg).isPattern)
    if (firstPatternIdx < 1) {
      return { status: 'error', reason: `模式路径缺少有效目录前缀: ${repoRelPath}` }
    }
    const staticDir = segments.slice(0, firstPatternIdx).join('/')
    if (!staticDir || !startsWithRepoPrefix(`${staticDir}/`)) {
      return { status: 'error', reason: `模式路径静态父目录无效: ${repoRelPath}` }
    }
    return validatePatternSegments(REPO_ROOT, '', segments, 0, requiresDir, repoRelPath)
  }

  const absTarget = path.resolve(REPO_ROOT, cleanNoTrailingSlash)
  if (!isInsideRepo(absTarget)) {
    return { status: 'error', reason: `路径越界出仓库根目录: ${repoRelPath}` }
  }

  if (fs.existsSync(absTarget)) {
    const targetStat = fs.statSync(absTarget)
    // 若原文显式以 `/` 结尾，确认目标是目录
    if (requiresDir && !targetStat.isDirectory()) {
      return { status: 'error', reason: `路径以 / 结尾但目标不是目录: ${repoRelPath}` }
    }
    if (lineRanges.length > 0) {
      if (!targetStat.isFile()) {
        return {
          status: 'error',
          reason: `目录路径不支持行号后缀 (${lineRanges[0].raw}): ${repoRelPath}`
        }
      }
      const totalLines = getFileLineCount(absTarget)
      for (const range of lineRanges) {
        if (range.start < 1 || range.end < range.start || range.end > totalLines) {
          return {
            status: 'error',
            reason: `行号后缀 ${range.raw} 超出目标文件总行数 (${totalLines}): ${repoRelPath}`
          }
        }
      }
    }
    return { status: 'ok' }
  }

  const whitelisted = findGitignoredWhitelistMatch(cleanNoTrailingSlash)
  if (whitelisted) {
    return {
      status: 'warning',
      reason: `目标当前未存在于磁盘，属于受控 .gitignore 目录（${whitelisted.reason}）`
    }
  }

  return { status: 'error', reason: `仓库路径不存在: ${repoRelPath}` }
}

function collectMarkdownFiles(cliPaths, includeSkills) {
  const collected = new Set()

  function walkDir(absDir) {
    if (!fs.existsSync(absDir)) return
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(absDir, entry.name)
      const rel = relFromRepo(fullPath)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        if (!includeSkills && (rel === 'docs/skill' || rel.startsWith('docs/skill/'))) continue
        walkDir(fullPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (!includeSkills && rel.startsWith('docs/skill/')) continue
        collected.add(fullPath)
      }
    }
  }

  if (cliPaths.length === 0) {
    for (const rootDoc of ['AGENTS.md', 'README.md']) {
      const abs = path.join(REPO_ROOT, rootDoc)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        collected.add(abs)
      }
    }
    walkDir(path.join(REPO_ROOT, 'docs'))
  } else {
    for (const rawArg of cliPaths) {
      let abs
      if (path.isAbsolute(rawArg)) {
        abs = rawArg
      } else {
        const repoCandidate = path.resolve(REPO_ROOT, rawArg)
        const cwdCandidate = path.resolve(process.cwd(), rawArg)
        abs = fs.existsSync(repoCandidate) ? repoCandidate : cwdCandidate
      }
      if (!fs.existsSync(abs)) {
        throw new Error(`指定的检查路径不存在: ${rawArg}`)
      }
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) {
        walkDir(abs)
      } else if (stat.isFile()) {
        collected.add(abs)
      }
    }
  }

  return Array.from(collected).sort((a, b) => relFromRepo(a).localeCompare(relFromRepo(b)))
}

function checkFile(absFilePath, stats, errors, warnings) {
  const sourceRel = relFromRepo(absFilePath)
  const sourceDir = path.dirname(absFilePath)
  const content = fs.readFileSync(absFilePath, 'utf8')
  const { lines } = stripFencedCodeLines(content)

  for (const entry of lines) {
    if (entry.inFence) continue

    // 检查 (a)：Markdown 相对链接与 HTML 资源链接（先遮蔽行内代码防止误报）
    const masked = maskInlineCode(entry.text)
    const links = extractLinksFromLine(masked)

    for (const link of links) {
      stats.linksChecked += 1
      const rawTarget = link.target
      if (isExternalUrl(rawTarget)) continue

      const hashIndex = rawTarget.indexOf('#')
      const rawFilePart = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex)
      const rawAnchorPart = hashIndex === -1 ? '' : rawTarget.slice(hashIndex + 1)

      const filePart = safeDecodeURIComponent(rawFilePart.trim())
      const anchorPart = safeDecodeURIComponent(rawAnchorPart.trim())

      let targetAbs
      if (!filePart) {
        targetAbs = absFilePath
      } else if (filePart.startsWith('/')) {
        targetAbs = path.resolve(REPO_ROOT, filePart.slice(1))
      } else {
        targetAbs = path.resolve(sourceDir, filePart)
      }

      if (!isInsideRepo(targetAbs)) {
        errors.push({
          type: 'broken_link',
          file: sourceRel,
          line: entry.lineNumber,
          reference: rawTarget,
          message: `链接目标越界出仓库根目录: ${rawTarget}`
        })
        continue
      }

      if (!fs.existsSync(targetAbs)) {
        errors.push({
          type: 'broken_link',
          file: sourceRel,
          line: entry.lineNumber,
          reference: rawTarget,
          message: `链接目标文件或目录不存在: ${rawTarget}（解析路径: ${relFromRepo(targetAbs)}）`
        })
        continue
      }

      if (anchorPart) {
        const targetStat = fs.statSync(targetAbs)
        const lineAnchorMatch = anchorPart.match(/^L(\d+)(?:-L?(\d+))?$/)

        if (lineAnchorMatch) {
          if (!targetStat.isFile()) {
            errors.push({
              type: 'broken_anchor',
              file: sourceRel,
              line: entry.lineNumber,
              reference: rawTarget,
              message: `目录链接不支持行号锚点 #${anchorPart}`
            })
            continue
          }
          const startLine = Number.parseInt(lineAnchorMatch[1], 10)
          const endLine = lineAnchorMatch[2] ? Number.parseInt(lineAnchorMatch[2], 10) : startLine
          const totalLines = getFileLineCount(targetAbs)
          if (startLine < 1 || endLine < startLine || endLine > totalLines) {
            errors.push({
              type: 'broken_anchor',
              file: sourceRel,
              line: entry.lineNumber,
              reference: rawTarget,
              message: `行号锚点 #${anchorPart} 超出目标文件总行数 (${totalLines}): ${relFromRepo(targetAbs)}`
            })
          }
        } else if (targetStat.isFile() && targetAbs.toLowerCase().endsWith('.md')) {
          const slugs = getMarkdownHeadingSlugs(targetAbs)
          const normalizedAnchor = anchorPart.toLowerCase()
          if (!slugs.has(normalizedAnchor)) {
            errors.push({
              type: 'broken_anchor',
              file: sourceRel,
              line: entry.lineNumber,
              reference: rawTarget,
              message: `Markdown 标题锚点 #${anchorPart} 在 ${relFromRepo(targetAbs)} 中不存在`
            })
          }
        }
      }
    }

    // 检查 (b)：反引号包裹的仓库路径引用
    const spans = extractInlineCodeSpans(entry.text)
    for (const span of spans) {
      if (!startsWithRepoPrefix(span)) continue
      stats.repoPathsChecked += 1

      const { path: normalizedCandidate, lineRanges } = normalizeBacktickRepoCandidate(span)
      if (!startsWithRepoPrefix(normalizedCandidate)) continue

      const expandedList = expandBraces(normalizedCandidate)
      for (const expandedPath of expandedList) {
        const res = validateSingleRepoPath(expandedPath, lineRanges)
        if (res.status === 'error') {
          errors.push({
            type: 'invalid_repo_path',
            file: sourceRel,
            line: entry.lineNumber,
            reference: span,
            message: res.reason
          })
        } else if (res.status === 'warning') {
          warnings.push({
            type: 'gitignored_runtime_path',
            file: sourceRel,
            line: entry.lineNumber,
            reference: span,
            message: res.reason
          })
        }
      }
    }
  }
}

function parseCliArgs(argv) {
  let json = false
  let includeSkills = false
  const paths = []

  for (const arg of argv) {
    if (arg === '--json') {
      json = true
    } else if (arg === '--include-skills') {
      includeSkills = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: node scripts/check-knowledge-base.mjs [选项] [文件或目录...]',
          '',
          '选项:',
          '  --json            以 JSON 格式输出校验结果',
          '  --include-skills  同时纳入 docs/skill/ 目录校验',
          '  -h, --help        显示帮助信息',
          '',
          '默认扫描范围: AGENTS.md、README.md 以及 docs/**/*.md（排除 docs/skill/）'
        ].join('\n')
      )
      process.exit(0)
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}`)
    } else {
      paths.push(arg)
    }
  }

  return { json, includeSkills, paths }
}

function main() {
  let parsed
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[check-knowledge-base] 参数错误: ${err.message}`)
    process.exit(2)
  }

  let files
  try {
    files = collectMarkdownFiles(parsed.paths, parsed.includeSkills)
  } catch (err) {
    if (parsed.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            repoRoot: REPO_ROOT,
            checkedFiles: [],
            stats: { filesChecked: 0, linksChecked: 0, repoPathsChecked: 0, errorCount: 1, warningCount: 0 },
            errors: [{ type: 'cli_error', file: null, line: null, reference: null, message: err.message }],
            warnings: []
          },
          null,
          2
        )
      )
    } else {
      console.error(`[check-knowledge-base] 错误: ${err.message}`)
    }
    process.exit(1)
  }

  const stats = {
    filesChecked: files.length,
    linksChecked: 0,
    repoPathsChecked: 0
  }
  const errors = []
  const warnings = []

  for (const absFile of files) {
    checkFile(absFile, stats, errors, warnings)
  }

  const ok = errors.length === 0
  const result = {
    ok,
    repoRoot: REPO_ROOT,
    checkedFiles: files.map(relFromRepo),
    stats: {
      ...stats,
      errorCount: errors.length,
      warningCount: warnings.length
    },
    errors,
    warnings
  }

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`[知识库校验] 已检查文件数: ${stats.filesChecked}`)
    console.log(`[知识库校验] 已检查链接数: ${stats.linksChecked}`)
    console.log(`[知识库校验] 已检查仓库路径数: ${stats.repoPathsChecked}`)
    if (warnings.length > 0) {
      console.log(`[知识库校验] 受控提醒 (${warnings.length}):`)
      for (const w of warnings) {
        console.log(`  - [WARN] ${w.file}:${w.line} (${w.reference}) -> ${w.message}`)
      }
    }
    if (errors.length > 0) {
      console.error(`[知识库校验] 发现 ${errors.length} 处错误:`)
      for (const e of errors) {
        console.error(`  - [ERR:${e.type}] ${e.file}:${e.line} (${e.reference}) -> ${e.message}`)
      }
    } else {
      console.log('[知识库校验] 结果: 0 错误，全部引用真实存在且无断链。')
    }
  }

  process.exit(ok ? 0 : 1)
}

main()
