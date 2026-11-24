/**
 * JSON 小工具：让工具返回值一定是 lossless JSON，并给写盘提供原子写与备份。
 *
 * 宿主对工具结果做严格序列化：带 `undefined` 的自有属性会让整包结果被拒
 * （`returned invalid output: value is not lossless JSON`）。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 深拷贝并丢掉 undefined / 函数 / 符号，把非有限数变成 null。
 * @param value - 待净化的值。
 * @param seen - 环检测。
 */
export function jsonSafe(value, seen = new Set()) {
  if (value === undefined || value === null) return value
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return type === 'number' && !Number.isFinite(value) ? null : value
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') return undefined
  if (type !== 'object') return value
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen))
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) return { name: value.name, message: value.message }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonSafe(item, seen)
      if (converted !== undefined) out[key] = converted
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * 读一个 JSON 文件；文件不存在返回 fallback，内容坏掉抛可读错误。
 * @param file - 绝对路径。
 * @param fallback - 不存在时的默认值。
 */
export async function readJson(file, fallback = undefined) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`读取失败：${file}（${error?.code ?? error?.message ?? String(error)}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败：${file}（${error?.message ?? String(error)}）`)
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename，避免中途失败留下半个文件。
 * @param file - 绝对路径。
 * @param value - 要写入的值。
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * 覆盖前先备份到 backupsDir（保留原文件名 + 时间戳后缀）。
 * @param file - 要备份的文件。
 * @param backupsDir - 备份目录。
 * @param stamp - 时间戳（默认当前时间的安全格式）。
 * @returns 备份文件路径；源文件不存在时返回 undefined。
 */
export async function backupBeforeWrite(file, backupsDir, stamp = safeStamp()) {
  const name = file.split(/[\\/]/u).pop()
  const target = join(backupsDir, `${name}.${stamp}.bak`)
  try {
    await mkdir(backupsDir, { recursive: true })
    await copyFile(file, target)
    return target
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`备份失败：${file}（${error?.code ?? error?.message ?? String(error)}）`)
  }
}

/** 文件名安全的时间戳：2026-11-19T15-20-31-123Z。 */
export function safeStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-')
}
