/**
 * 测试沙盒：被每个 test/*.mjs **最先** import，保证 lib/mark.js 在计算 STATE_ROOT 之前
 * 就拿到临时目录——否则自检会往插件真实的 state/load.log 里写诊断行。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wsm-test-home-'))
process.env.WSM_HOME_DIR = root
process.env.WSM_STATE_DIR = join(root, 'state')
process.env.WSM_TEST_HOME = root
