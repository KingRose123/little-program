const express = require('express')
const routes = require('./routes.js')
const shadow = require('./shadow.js')
const BUILD = require('./build.js')

const app = express()

// 关掉 x-powered-by，少暴露一点实现细节
app.disable('x-powered-by')

// 快照上限在 routes.js 里是 5MB（见 MAX_PAYLOAD），body 解析要留出富余：
// 否则超过 1MB 的请求会在这一层就被 raw-body 拒掉，客户端拿到的是一句含糊的 500，
// 而不是我们那条明确的 413「数据过大」—— 那正是最难排查的一类失败。
app.use(express.json({ limit: '6mb' }))
// 虚拟支付的发货推送是 XML：用 text 解析器把它原样收成字符串，json 解析器不管 xml
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '1mb' }))

// 云托管调用进来时路径已经带了 /api 前缀，这里直接挂
app.use('/api', routes)

app.use((req, res) => {
  res.status(404).json({ ok: false, msg: 'Not Found: ' + req.method + ' ' + req.path })
})

// 兜底错误处理：任何未捕获异常都回统一结构，避免返回 HTML 让客户端解析失败
app.use((err, req, res, next) => {
  // body 超过解析上限：给一个明确的状态码，别混进一堆 500 里
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ ok: false, msg: '数据过大' })
  }
  console.error('[unhandled]', err)
  res.status(500).json({ ok: false, msg: '服务内部错误' })
})

const port = Number(process.env.PORT) || 80
app.listen(port, () => {
  // 打上构建标记：部署后一眼就能确认容器里跑的是哪份代码
  console.log('[xiji-api] build=' + BUILD + ' listening on ' + port)

  /**
   * 启动时把已有的历史快照补一份进影子表 ——
   * 这样部署完不用手动触发，老用户在后台也能看到。
   * 新数据在每次保存快照时已自动同步（见 routes.js 的 PUT /state）。
   * 放在 listen 之后异步跑，不拖慢启动；失败只记日志，不影响服务。
   */
  shadow
    .backfill(1000, 0)
    .then((r) => {
      if (r.scanned) {
        console.log(
          '[shadow] 启动回填：扫描 ' + r.scanned + ' 个账号，成功 ' + r.synced + '，失败 ' + r.failed
        )
      }
    })
    .catch((e) => console.warn('[shadow] 启动回填跳过：', (e && e.message) || e))
})
