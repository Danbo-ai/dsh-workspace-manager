/**
 * dsh-workspace-manager — 客户端半体。
 *
 * 职责有三块，都挂在宿主官方侧栏上（不重绘侧栏）：
 *   1. 在工作区行的右键菜单里追加「新建子工作区…」「新建同级工作区…」，
 *      弹一个自绘小对话框收目录名，再通过宿主命令 `/mkws` 落到磁盘与注册表。
 *   2. 在工作区行和会话行的右键菜单里追加标题整理：工作区行整理全部候选，
 *      会话行只整理这一条；两者都直接调宿主后台，由插件自己调模型，不占用会话。
 *   3. 接管「会话拖到工作区行」的跨区移动（官方侧栏只允许同工作区内排序）。
 *
 * 为什么不直接调 RPC：本机 directory-picker 是 native 形态（没有 createDirectory 能力），
 * 客户端也没有「建目录」的远程命名空间；能复用的只有 `commands.execute`（按 sessionId 寻址）。
 * 所以这里把动作编成 `/mkws <名字> "<父目录>"` 交给某个已加载会话执行——与手打命令等价。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 单段目录名：与宿主侧 lib/workspace.js 的 DIRECTORY_NAME 保持一致。 */
    const DIRECTORY_NAME = /^[^\u0000/\\:*?"<>|]{1,80}$/u

    /** 去掉尾部分隔符，并统一成正斜杠（只用于展示与拼路径）。 */
    const trimPath = (value) => String(value ?? '').replace(/[\\/]+$/u, '')

    /** 取父目录（同级工作区用）。 */
    const parentOf = (value) => {
      const text = trimPath(value)
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut <= 0 ? text : text.slice(0, cut)
    }

    /** 拼接子目录路径。 */
    const childOf = (parent, name) => `${trimPath(parent)}/${name}`

    /** 命令参数里的引号包裹：路径可能带空格，一律用双引号。 */
    const quote = (value) => `"${String(value).replace(/"/gu, '')}"`

    // —— 对话框状态：模块级小 store，够用就行 ——
    let state = { open: false, mode: 'child', parent: '', name: '', session: '', targetWorkspaceId: '', targetTitle: '', busy: false, error: '', note: '' }
    const listeners = new Set()
    const publish = (patch) => {
      state = { ...state, ...patch }
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[dsh-workspace-manager] dialog listener failed', error)
        }
      }
    }
    /** 对话框代数：每次开/关都 +1，异步回调用它判断自己是不是还属于当前这一次。 */
    let dialogToken = 0
    const reset = () => {
      dialogToken += 1
      publish({ open: false, parent: '', name: '', session: '', targetWorkspaceId: '', targetTitle: '', busy: false, error: '', note: '' })
    }

    /** 打开对话框。 */
    function openDialog(options) {
      dialogToken += 1
      const mode = options.mode === 'sibling'
        ? 'sibling'
        : (options.mode === 'move' ? 'move' : 'child')
      publish({
        open: true,
        mode,
        parent: trimPath(options.parent),
        name: '',
        session: String(options.session ?? ''),
        targetWorkspaceId: String(options.targetWorkspaceId ?? ''),
        targetTitle: String(options.targetTitle ?? ''),
        busy: false,
        error: '',
        note: '',
      })
    }

    /**
     * 直接调宿主半体的后台入口。
     *
     * 页面没有文件权限，而建目录、搬家、收尾都是纯文件操作；宿主半体注册了
     * /wsm/* 路由，POST 一下就在宿主进程里做完，全程不借会话、不产生对话。
     * 自定义头是为了挡住跨站请求：带自定义头的跨域请求要先过预检，而我们不回应预检。
     */
    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-manager': '1' },
        body: JSON.stringify(payload ?? {}),
      })
      if (!response.ok) throw new Error(`后台入口返回 ${response.status}`)
      const body = await response.json()
      if (body?.ok !== true) throw new Error(String(body?.error ?? '后台没有返回结果'))
      return body.result
    }

    /**
     * 提交建子工作区：校验名字 → 后台建目录、写骨架、注册工作区。
     * 成功后**立刻关窗**（不留成功态、不留进度），失败就把原因留在框里让用户改。
     */
    async function submit(ctx) {
      const name = String(state.name ?? '').trim()
      const parent = trimPath(state.parent)
      if (name === '' || name === '.' || name === '..' || !DIRECTORY_NAME.test(name)) {
        publish({ error: '目录名只能是单段文本，不能含 / \\ : * ? " < > |，也不能是 . 或 ..' })
        return
      }
      if (parent === '') {
        publish({ error: '父目录为空，无法创建' })
        return
      }
      const token = dialogToken
      publish({ busy: true, error: '', note: '' })
      try {
        await postJson('/workspace-manager/child', { name, parent })
        if (token !== dialogToken) return
        reset()
      } catch (error) {
        if (token === dialogToken) publish({ busy: false, error: `创建失败：${error?.message ?? String(error)}` })
      }
    }


    /**
     * 确认搬家：交给后台把会话连同它的文件一起挪过去。
     *
     * 宿主在自己的进程里同步做完（改日志 header、换桶、同步投影、改归属），
     * 页面只等这一次回执，不借任何会话、不轮询、不忙等；成功直接收窗。
     */
    async function submitMove(ctx) {
      const token = dialogToken
      const pending = state
      if (pending.session === '' || pending.targetWorkspaceId === '') {
        publish({ error: '没有识别到要移动的会话或目标工作区，请重新拖动一次。' })
        return
      }
      publish({ busy: true, error: '', note: '' })
      try {
        await postJson('/workspace-manager/move', {
          sessionId: pending.session,
          target: pending.targetWorkspaceId,
        })
        if (token !== dialogToken) return
        reset()
      } catch (error) {
        if (token === dialogToken) publish({ busy: false, error: `移动失败：${error?.message ?? String(error)}` })
      }
    }

    /** 按钮样式（跟随系统配色，不依赖具体主题变量）。 */
    function buttonStyle(primary) {
      return {
        padding: '6px 14px',
        borderRadius: 8,
        fontSize: 14,
        cursor: 'pointer',
        border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
        background: primary ? '#2563eb' : 'transparent',
        color: primary ? '#fff' : 'inherit',
      }
    }

    /**
     * 会话跨工作区拖拽。
     *
     * 官方侧栏只允许「同工作区内排序」：工作区行没有 dragover/drop，
     * 所以插件在 document 捕获阶段接管——拖的是会话行、压住的是工作区行时放行 drop 并高亮，
     * 松手后弹一个确认框（只弹一个，文案一句话）。
     */
    const DRAG_STYLE_ID = 'workspace-manager-drag-style'
    const DROP_CLASS = 'wsm-drop-target'

    function mountDragStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(DRAG_STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = DRAG_STYLE_ID
      style.textContent = [
        '[data-row-key^="workspace:"]' + '.' + DROP_CLASS + '{',
        'background-color:rgba(59,130,246,0.16)!important;',
        'box-shadow:inset 0 0 0 1px rgba(59,130,246,0.42);',
        'border-radius:8px;',
        'transition:background-color 120ms ease,box-shadow 120ms ease;',
        '}',
        '[data-row-key^="workspace:"]' + '.' + DROP_CLASS + ' *{color:#1d4ed8;}',
      ].join('')
      document.head.append(style)
    }

    /** 挂上四个捕获阶段监听，返回卸载函数。 */
    function mountSessionDrag() {
      if (typeof document === 'undefined') return undefined
      mountDragStyle()
      let dragging = false
      let activeRow = null
      // 同一次拖拽偶尔会连发两个 drop（官方行也在监听），挡掉 600ms 内的重复。
      const lastDrop = { sessionId: '', at: 0 }
      const rowOf = (target) => (typeof target?.closest === 'function' ? target.closest('[data-row-key]') : null)
      const keyOf = (row) => String(row?.getAttribute?.('data-row-key') ?? '')
      const clearTarget = () => {
        if (activeRow !== null) activeRow.classList?.remove(DROP_CLASS)
        activeRow = null
      }
      const setTarget = (row) => {
        if (row === activeRow) return
        clearTarget()
        if (row !== null) {
          row.classList?.add(DROP_CLASS)
          activeRow = row
        }
      }
      const onDragStart = (event) => {
        // 工作区行自己也是 draggable 的；只有拖的不是工作区行，才由我们接管。
        dragging = !keyOf(rowOf(event.target)).startsWith('workspace:')
        if (!dragging) clearTarget()
      }
      const onDragOver = (event) => {
        if (!dragging) return
        const row = rowOf(event.target)
        if (!keyOf(row).startsWith('workspace:')) {
          clearTarget()
          return
        }
        event.preventDefault()
        setTarget(row)
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
      }
      const onDrop = (event) => {
        if (!dragging) return
        const row = rowOf(event.target)
        const key = keyOf(row)
        if (!key.startsWith('workspace:')) {
          clearTarget()
          return
        }
        const sessionId = String(event.dataTransfer?.getData('text/plain') ?? '')
        if (!/^session-/u.test(sessionId)) return
        event.preventDefault()
        event.stopPropagation()
        dragging = false
        clearTarget()
        const now = Date.now()
        if (lastDrop.sessionId === sessionId && now - lastDrop.at < 600) return
        lastDrop.sessionId = sessionId
        lastDrop.at = now
        const label = String(row.getAttribute('aria-label') ?? row.textContent ?? '').trim().slice(0, 80)
        openDialog({
          mode: 'move',
          session: sessionId,
          targetWorkspaceId: key.slice('workspace:'.length),
          targetTitle: label,
        })
      }
      const onDragEnd = () => {
        dragging = false
        clearTarget()
      }
      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', onDragEnd, true)
      return () => {
        clearTarget()
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragover', onDragOver, true)
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('dragend', onDragEnd, true)
      }
    }

    /** 调宿主后台直接整理标题；不向会话投递指令，也不新建会话。 */
    async function runTitleRefresh(ctx, payload = {}) {
      const notify = (text, success) => {
        try {
          ctx.contextMenus?.notify?.(text, success)
        } catch {
          /* 提示失败不影响主流程 */
        }
      }
      try {
        const result = await postJson('/workspace-manager/retitle', payload ?? {})
        if (result?.error !== undefined && result?.error !== null) {
          notify(String(result.error), false)
          return
        }
        const ok = result?.status === 'applied' || result?.status === 'dry-run' || result?.status === 'empty'
        notify(String(result?.receipt ?? result?.message ?? '整理完成'), ok)
      } catch (error) {
        notify(`整理标题失败：${error?.message ?? String(error)}`, false)
      }
    }

    /** 菜单项：只在右键工作区行时出现。 */
    function menuActions(target, ctx) {
      const path = String(target?.path ?? '')
      if (trimPath(path) === '') return []
      return [
        {
          id: 'new-child',
          label: '新建子工作区…',
          run: () => openDialog({ mode: 'child', parent: path }),
        },
        {
          id: 'new-sibling',
          label: '新建同级工作区…',
          run: () => openDialog({ mode: 'sibling', parent: parentOf(path) }),
        },
        {
          id: 'titles',
          label: '整理全部对话标题…',
          run: () => void runTitleRefresh(ctx, {}),
        },
      ]
    }

    /** 对话框组件：全屏遮罩 + 简单表单。 */
    function Dialog(props) {
      const [snapshot, setSnapshot] = React.useState(state)
      React.useEffect(() => {
        const listener = () => setSnapshot(state)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      const { ctx } = props
      if (!snapshot.open) return null
      const isSibling = snapshot.mode === 'sibling'
      const isMove = snapshot.mode === 'move'
      const heading = isMove ? '移动会话' : (isSibling ? '新建同级工作区' : '新建子工作区')
      const run = () => {
        if (isMove) void submitMove(ctx)
        else void submit(ctx)
      }
      const onKeyDown = (event) => {
        // Esc 永远能退出：卡住时这是唯一的出口。
        if (event.key === 'Escape') reset()
        if (event.key === 'Enter' && !snapshot.busy) {
          event.preventDefault()
          run()
        }
      }
      return h(
        'div',
        {
          onKeyDown,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) reset()
          },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15, 23, 42, 0.32)',
            colorScheme: 'light dark',
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': heading,
            style: {
              width: 'min(420px, calc(100vw - 32px))',
              padding: '18px 20px 16px',
              borderRadius: 12,
              background: 'Canvas',
              color: 'CanvasText',
              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.28)',
              font: '14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, heading),
          isMove
            ? h(
                'div',
                { style: { fontSize: 13, marginBottom: 12, wordBreak: 'break-word' } },
                `把这条会话连同它的文件一起移到「${snapshot.targetTitle || '目标工作区'}」？`,
              )
            : h(
                'div',
                { style: { fontSize: 12, opacity: 0.62, marginBottom: 12, wordBreak: 'break-all' } },
                `${isSibling ? '同级目录' : '父目录'}：${snapshot.parent || '（未识别）'}`,
              ),
          isMove ? null : h('input', {
            autoFocus: true,
            value: snapshot.name,
            disabled: snapshot.busy,
            placeholder: '文件夹名（单段，如 backend）',
            onChange: (event) => publish({ name: event.target.value, error: '' }),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 14,
              border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
              background: 'Field',
              color: 'FieldText',
            },
          }),
          isMove
            ? null
            : h(
                'div',
                { style: { fontSize: 12, opacity: 0.62, marginTop: 8, wordBreak: 'break-all' } },
                snapshot.name.trim() === '' ? '会建出同名文件夹，并生成 AGENTS.md 与 .dsh/memory.md' : `将创建：${childOf(snapshot.parent, snapshot.name.trim())}`,
              ),
          snapshot.error === ''
            ? null
            : h('div', { role: 'alert', style: { marginTop: 10, fontSize: 13, color: '#b42318' } }, snapshot.error),
          snapshot.note === ''
            ? null
            : h('div', { role: 'status', style: { marginTop: 10, fontSize: 13, color: '#1d4ed8' } }, snapshot.note),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
            h('button', { type: 'button', onClick: () => reset(), style: buttonStyle(false) }, '取消'),
            h(
              'button',
              {
                type: 'button',
                disabled: snapshot.busy,
                onClick: snapshot.note === '' ? run : () => reset(),
                style: buttonStyle(true),
              },
              isMove
                ? (snapshot.busy ? '移动中…' : (snapshot.note === '' ? '移动' : '关闭'))
                : (snapshot.busy ? '创建中…' : '创建'),
            ),
          ),
        ),
      )
    }

    return {
      // `remote.commands` 必须单独声明：宿主把每个 Remote 命名空间挂成一个可注入服务，
      // 只声明 `remote` 时访问 `ctx.remote.commands` 会被 Cordis 拒绝。
      inject: ['slots', 'contextMenus'],
      apply(ctx) {
        // 同一页面只允许一份遮罩：热重载或重复注入时先卸掉上一份，
        // 否则会叠出两个对话框，点「取消」只关掉上面那个，看起来像按钮失灵。
        const held = globalThis.__wsmOverlay
        if (held !== undefined) {
          try {
            held()
          } catch {
            /* 旧的一份已经没了，忽略 */
          }
          globalThis.__wsmOverlay = undefined
        }
        const mounted = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-manager.new-child',
          order: 60,
        }, (props) => h(Dialog, { ...props, ctx })))
        globalThis.__wsmOverlay = () => {
          try {
            mounted?.()
          } catch {
            /* 卸载失败不影响新的一份 */
          }
        }

        ctx.effect(() => mountSessionDrag(), 'workspace-manager: 会话拖拽搬家')

        ctx.effect(() => ctx.contextMenus.register({
          id: 'workspace-manager.new-workspace',
          target: 'workspace',
          order: 200,
          resolve: (target) => menuActions(target, ctx),
        }), 'workspace-manager: 新建子工作区菜单')

        // 会话行只追加一条；宿主自身的 pin/rename/fork/id/archive 菜单顺序不变。
        ctx.effect(() => ctx.contextMenus.register({
          id: 'workspace-manager.titles',
          target: 'session',
          order: 250,
          resolve: (target) => [{
            id: 'titles',
            label: '整理本会话标题…',
            run: () => void runTitleRefresh(ctx, { sessionId: target?.sessionId, force: true }),
          }],
        }), 'workspace-manager: 整理对话标题菜单')
      },
    }
  },
})
