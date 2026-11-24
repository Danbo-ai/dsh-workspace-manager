/**
 * 诊断通道与状态目录。
 *
 * 宿主没有可读的插件日志：装载失败、工具注册失败都只会静默。
 * 所以插件自己往包里写一行行痕迹，排查时直接看 state/load.log。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包根目录（lib/ 的上一层）。 */
export const PACKAGE_ROOT = dirname(HERE)

/**
 * 状态目录：默认在包内 state/；测试用 WSM_STATE_DIR 覆盖，避免污染真实痕迹。
 */
export const STATE_ROOT = (() => {
  const override = process.env.WSM_STATE_DIR
  if (typeof override === 'string' && override.trim() !== '') {
    return isAbsolute(override) ? override : resolve(override)
  }
  return join(PACKAGE_ROOT, 'state')
})()

/**
 * 拼一个状态文件路径。
 * @param parts - 相对状态目录的路径片段。
 */
export function statePath(...parts) {
  return join(STATE_ROOT, ...parts)
}

/**
 * 追加一行装载痕迹。单行、失败静默——诊断通道坏了也不能拖累插件本体。
 * @param line - 要记录的内容。
 */
export function mark(line) {
  try {
    mkdirSync(STATE_ROOT, { recursive: true })
  } catch {
    /* 建不出来就继续试写 */
  }
  try {
    appendFileSync(join(STATE_ROOT, 'load.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 诊断通道不可用 */
  }
}
