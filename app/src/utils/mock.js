/**
 * 本地 Mock 数据源（只保留「产品内容与配置」，不含任何示例用户数据）
 *
 * 这里曾经内置过 5 只示例持仓、示例昵称 / 会员信息与分红日历事件，上线前已全部清空：
 * 用户的持仓、分红记录、资料一律来自「用户自己录入 + 行情接口 + 云端快照」，
 * 全新用户进来看到的是干净的空白状态，而不是别人的资产。
 *
 * 保留下来的都是与具体用户无关的内容：市场元数据、支出预设目录、发现页内容、
 * 排序 / 分组选项等。
 */

// 默认资料。昵称与头像在登录后按账号填入，这里只给中性默认值，不放任何示例身份信息。
// App 端是账号密码登录、不收集手机号，所以没有 phone / isPro 这类字段
// （会员档位的权威值在服务端 membership 表，不在这里）。
const user = {
  nickName: '收息佬用户',
  slogan: '让每一分红利，覆盖你的生活',
  avatar: '👤'
}

/* ---------------- 支出项（覆盖目标） ---------------- */
// sort 决定「我的支出」列表顺序，与参考图一致
const expenses = [
  { id: 'grocery', name: '买菜', icon: '🛒', amount: 2000, period: '月', sort: 1 },
  { id: 'property', name: '物业费', icon: '🏠', amount: 300, period: '月', sort: 2 },
  { id: 'fuel', name: '加油', icon: '⛽', amount: 1000, period: '月', sort: 3 },
  { id: 'phone', name: '话费', icon: '📱', amount: 100, period: '月', sort: 4 },
  { id: 'utility', name: '水电燃气', icon: '💡', amount: 400, period: '月', sort: 5 },
  { id: 'mortgage', name: '房贷/房租', icon: '🔑', amount: 8000, period: '月', sort: 6 },
  { id: 'tuition', name: '孩子学费', icon: '🏫', amount: 3000, period: '月', sort: 7 },
  { id: 'lunch', name: '午餐', icon: '🍱', amount: 1500, period: '月', sort: 8 },
  { id: 'coffee', name: '咖啡', icon: '☕', amount: 600, period: '月', sort: 9 },
  { id: 'music', name: '音乐会员', icon: '🎵', amount: 15, period: '月', sort: 10 }
]

/* ---------------- 自定义支出可选图标 ----------------
 *
 * life 覆盖「日常开销」的各个角落，按主题大致分组排布（居家 / 餐饮 / 健康 /
 * 学习娱乐 / 通讯订阅 / 人情），这样挑图标时是顺着类别扫，而不是在一堆
 * 随机 emoji 里找。数量给足是因为自定义支出的差异极大 —— 早教、宠物、
 * 健身、订阅服务都有人记，图标池太小会逼着人选一个不贴切的。
 *
 * 渲染端不截断（见 LifeExpense 的图标行），所以这里的长度直接决定可选数量。
 */
const expenseIcons = {
  life: [
    // 居家日用
    '📌', '🛏️', '🧹', '🧺', '🪑', '💡', '🧯', '🧻', '🪥', '🧽',
    // 衣帽洗护
    '👕', '👗', '👟', '🧴', '💄', '✂️', '🛁', '🚿',
    // 餐饮
    '🥢', '🍚', '☕', '🍎', '🥗', '🍼',
    // 健康
    '🏥', '💊', '🦷', '👓', '🏋️', '🧘',
    // 学习与娱乐
    '🎓', '📚', '🎨', '🎵', '🎬', '🎮', '🎲', '📺', '🧸',
    // 通讯与订阅
    '📱', '📶', '💻', '☁️',
    // 人情与其他
    '🎁', '🧧', '💐', '🐱', '🐶', '🐰', '🐟', '🌵', '🌷', '🌸', '🐝', '💰'
  ],
  travel: [
    '🚗', '🚕', '🚌', '🚇', '🚄', '🚲', '🛴',
    '✈️', '🚢', '⛽', '🅿️', '🚧', '🚏', '🛍️',
    '🗺️', '🚀', '🎫', '🏨', '🏕️', '🎡'
  ]
}

// 已选中的 8 项（年化合计 195600）
const selectedExpenseIds = [
  'phone', 'property', 'utility', 'fuel', 'lunch', 'grocery', 'tuition', 'mortgage'
]

// 覆盖状态不写死：由 utils/api.js 的 coverageSource() 按「金额从小到大依次覆盖」推导
// 成长阶段与节点：见 utils/api.js 的 STAGE_NAMES / STAGE_STEPS，按已覆盖金额占比递进
// 成长日志不写死：由 utils/api.js 的 growthLogsVM() 按覆盖进度推导

/* ---------------- 添加持仓：市场分类与可搜索股票池 ---------------- */
// 市场清单，同时是全项目市场元数据的唯一来源：
//   label 切换标签文案 / dot 标签前的圆点色 / tag + cls 持仓卡上的市场徽标
const stockMarkets = [
  { label: 'A股', key: 'A', dot: 'dot-a', tag: 'A', cls: 'tag-green' },
  { label: 'ETF', key: 'ETF', dot: 'dot-etf', tag: 'E', cls: 'tag-gold' },
  { label: '基金', key: 'FUND', dot: 'dot-fund', tag: '基', cls: 'tag-gold' },
  { label: '港股', key: 'HK', dot: 'dot-hk', tag: '港', cls: 'tag-blue' },
  { label: '美股', key: 'US', dot: 'dot-us', tag: '美', cls: 'tag-orange' }
]

// 标的池：本地已知的标的清单，只在「只拿到代码需要判断所属市场」这类辅助场景使用。
// 价格、涨跌、历史分红一律实时取自接口（utils/quote.js），本地不再保存任何行情数据。
//   dps = 近 1 年每股分红（元），仅作接口不可用时的兜底基数
const stockPool = [
  /* ---- A股 ---- */
  { code: '601398', name: '工商银行', market: 'A', dps: 0.346 },
  { code: '601288', name: '农业银行', market: 'A', dps: 0.2309 },
  { code: '601939', name: '建设银行', market: 'A', dps: 0.4 },
  { code: '600036', name: '招商银行', market: 'A', dps: 1.972 },
  { code: '601328', name: '交通银行', market: 'A', dps: 0.375 },
  { code: '601988', name: '中国银行', market: 'A', dps: 0.2364 },
  { code: '600398', name: '海澜之家', market: 'A', dps: 0.68 },
  { code: '600887', name: '伊利股份', market: 'A', dps: 1.2 },
  { code: '600519', name: '贵州茅台', market: 'A', dps: 30.876 },
  { code: '000858', name: '五粮液', market: 'A', dps: 4.67 },
  { code: '000895', name: '双汇发展', market: 'A', dps: 1.5 },
  { code: '601088', name: '中国神华', market: 'A', dps: 2.26 },
  { code: '600028', name: '中国石化', market: 'A', dps: 0.31 },
  { code: '601857', name: '中国石油', market: 'A', dps: 0.23 },
  { code: '600900', name: '长江电力', market: 'A', dps: 0.82 },
  { code: '601006', name: '大秦铁路', market: 'A', dps: 0.48 },
  { code: '600066', name: '宇通客车', market: 'A', dps: 1.5 },
  { code: '601668', name: '中国建筑', market: 'A', dps: 0.27 },

  /* ---- 港股 ---- */
  { code: '06049', name: '保利物业', market: 'HK', dps: 0.9923 },
  { code: '00506', name: '中国食品', market: 'HK', dps: 0.3279 },
  { code: '00941', name: '中国移动', market: 'HK', dps: 4.7139 },
  { code: '00700', name: '腾讯控股', market: 'HK', dps: 4.5 },
  { code: '09988', name: '阿里巴巴-W', market: 'HK', dps: 0 },
  { code: '00939', name: '建设银行', market: 'HK', dps: 0.44 },
  { code: '01398', name: '工商银行', market: 'HK', dps: 0.33 },
  { code: '03988', name: '中国银行', market: 'HK', dps: 0.24 },
  { code: '00762', name: '中国联通', market: 'HK', dps: 0.29 },
  { code: '00883', name: '中国海洋石油', market: 'HK', dps: 1.4 },
  { code: '01088', name: '中国神华', market: 'HK', dps: 2.26 },
  { code: '00386', name: '中国石油化工股份', market: 'HK', dps: 0.33 },
  { code: '01138', name: '中远海能', market: 'HK', dps: 0.35 },
  { code: '00902', name: '华能国际电力股份', market: 'HK', dps: 0.2 },

  /* ---- ETF ---- */
  { code: '510300', name: '沪深300ETF', market: 'ETF', dps: 0.085 },
  { code: '510880', name: '红利ETF', market: 'ETF', dps: 0.2 },
  { code: '515180', name: '红利ETF易方达', market: 'ETF', dps: 0.15 },
  { code: '563020', name: '红利低波ETF', market: 'ETF', dps: 0.12 },
  { code: '512880', name: '证券ETF', market: 'ETF', dps: 0.032 },
  { code: '513100', name: '纳指ETF', market: 'ETF', dps: 0 },

  /* ---- 基金 ---- */
  { code: '000756', name: '建信潜力新蓝筹股票-A', market: 'FUND', dps: 0 },
  { code: '001267', name: '宏利蓝筹价值混合', market: 'FUND', dps: 0 },
  { code: '002620', name: '中邮未来新蓝筹灵活配置混合', market: 'FUND', dps: 0 },
  { code: '000327', name: '南方潜力新蓝筹混合-A', market: 'FUND', dps: 0 },
  { code: '001162', name: '前海开源优势蓝筹股票-A', market: 'FUND', dps: 0 },
  { code: '001638', name: '前海开源优势蓝筹股票-C', market: 'FUND', dps: 0 },
  { code: '110022', name: '易方达消费行业', market: 'FUND', dps: 0 },
  { code: '161725', name: '招商中证白酒', market: 'FUND', dps: 0.15 },
  { code: '161723', name: '招商中证银行指数', market: 'FUND', dps: 0.08 },
  { code: '001594', name: '天弘中证银行ETF联接-A', market: 'FUND', dps: 0.06 },

  /* ---- 美股 ---- */
  { code: 'AAPL', name: '苹果', market: 'US', dps: 1.0 },
  { code: 'MSFT', name: '微软', market: 'US', dps: 3.0 },
  { code: 'KO', name: '可口可乐', market: 'US', dps: 1.94 },
  { code: 'JNJ', name: '强生', market: 'US', dps: 4.76 },
  { code: 'PG', name: '宝洁', market: 'US', dps: 4.03 },
  { code: 'XOM', name: '埃克森美孚', market: 'US', dps: 3.8 },
  { code: 'T', name: 'AT&T', market: 'US', dps: 1.11 },
  { code: 'VZ', name: '威瑞森', market: 'US', dps: 2.71 },
  { code: 'PEP', name: '百事可乐', market: 'US', dps: 5.42 }
]

/* ---------------- 持仓 ---------------- */
// 不再内置示例持仓：列表完全来自用户自己录入（存进云端快照 / 本地快照），
// 价格与每股派息由 utils/api.js 的 refreshHoldingQuotes 按实时接口回写。
const holdings = []

// 分红日历里待除权的预告
// ⚠️ 这两块（预告 + 下方的事件）目前没有真实数据源 —— 原先靠写死的示例事件撑着，
// 上线前已清空，因此日历页在接入真实除权除息日之前会一直是空的。
// 真实数据可以从分红档案里的 exDate / payDate 推出来（见 utils/api.js 的 getStockDetail）。
const dividendNotice = { count: 0, amount: 0 }

/* ---------------- 分红日历事件 ---------------- */
// 结构：{ 'yyyy-MM-dd': [{ code, name, type, amount }] }，type 取日历图例里的三种
const calendarEvents = {}

/* ---------------- 年度总览 ---------------- */
// months 需要按真实分红记录逐月汇总后填充，这里只提供当年年份 + 空图
const yearOverview = {
  year: new Date().getFullYear(),
  received: 0,
  months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}

/* ---------------- 发现页 ---------------- */
const discoverTools = [
  { id: 't1', name: '复利计算器', icon: '📈', desc: '算算 10 年后', bg: 'icon-soft-green' },
  { id: 't2', name: '分红日历', icon: '📅', desc: '下一笔到账', bg: 'icon-soft-gold' },
  { id: 't3', name: '息率对比', icon: '⚖️', desc: '挑高股息', bg: 'icon-soft-orange' },
  { id: 't4', name: '定投回测', icon: '🔁', desc: '历史收益', bg: 'icon-soft-gray' }
]

const discoverRanks = [
  { id: 'r1', name: '高股息榜', desc: '按最新股价息率排序', icon: '🏆', badge: '实时更新' },
  { id: 'r2', name: '连续分红榜', desc: '连续分红年数由真实记录统计', icon: '🎖️', badge: '长期主义' },
  { id: 'r3', name: '红利指数', desc: '一篮子高息资产', icon: '🧺', badge: '组合' }
]

const discoverArticles = [
  {
    id: 'a1',
    title: '为什么说分红才是长线投资者真正的现金流',
    tag: '理念',
    read: '3 分钟',
    icon: '💡'
  },
  {
    id: 'a2',
    title: '港股分红要扣 28% 的税，还值得买吗？',
    tag: '税务',
    read: '4 分钟',
    icon: '🧾'
  },
  {
    id: 'a3',
    title: '把分红再投入，你的资产会滚多大一颗雪球',
    tag: '复利',
    read: '5 分钟',
    icon: '⛄'
  }
]

/* ---------------- 引导页示例数据 ---------------- */
// 引导流演示数据：金额一律存人民币基准数值，文案由 api 层按当前显示货币产出
const onboardingDemo = {
  slogan: '不盯股价涨跌，只关心分红到账多少钱',
  preview: {
    name: '工商银行',
    icon: '工',
    market: 'A',
    shares: 10000,
    cost: 5.12,
    yield: 6.8,
    dividend: 3460
  },
  predictCard: {
    total: 18720,
    received: 6240,
    yield: 5.8,
    nextPay: '7月15日'
  },
  litChips: ['☕ 咖啡', '📱 话费', '🎵 音乐会员'],
  unlitChips: ['🍱 午餐', '🏠 物业'],
  litCount: 3,
  chipTotal: 5,
  nextChip: '午餐',
  compound: {
    now: 18000,
    future: 180000,
    years: 10,
    multiple: 10
  },
  tip: '你的第一笔分红，可能只够买杯奶茶，但那是起点',
  planFooter: { principal: 150000, monthly: 3500, rate: 5 }
}

/* ---------------- 会员：收息佬会员 ----------------
 * 权益矩阵与额度的「单一数据源」：会员中心的对比表、各功能的门禁都读这里，
 * 调档位权限只需要改这一个文件。
 *
 * ready: false 表示该功能还没上线 —— 对比表会标注「即将上线」，
 * 避免出现「卖了会员却用不了功能」这种投诉。
 */
const membershipTiers = [
  { key: 'free', name: '免费' },
  { key: 'lite', name: 'Lite' },
  { key: 'pro', name: 'Pro' }
]

const membershipFeatures = [
  { name: '分红预测 / 日历', free: '✓', lite: '✓', pro: '✓' },
  { name: '分红到账记录', free: '✓', lite: '✓', pro: '✓' },
  { name: '交易 / 分红记录', free: '无限', lite: '无限', pro: '无限' },
  { name: '个股分红档案', free: '✓', lite: '✓', pro: '✓' },
  { name: '息愿生活 / 展望未来', free: '✓', lite: '✓', pro: '✓' },
  { name: 'A股、ETF、基金持仓', free: '≤ 3 只', lite: '无限', pro: '无限' },
  { name: '港股、美股持仓', free: '不支持', lite: '不支持', pro: '✓' },
  { name: '截图导入', free: '5次/月', lite: '5次/月', pro: '无限', ready: false },
  { name: '基金定投计划', free: '≤ 3 个', lite: '≤ 3 个', pro: '无限', ready: false },
  { name: '股票基本面', free: '5次/月', lite: '5次/月', pro: '无限', ready: false },
  { name: '账户分析', free: '不支持', lite: '不支持', pro: '✓', ready: false },
  { name: '自选盯盘', free: '≤ 5只', lite: '≤ 5只', pro: '无限', ready: false },
  { name: '多投资账户', free: '1个', lite: '1个', pro: '10个' },
  { name: '股票筛选器', free: '5次/月', lite: '5次/月', pro: '无限', ready: false, soon: true }
]

// 各档位的额度。值为 -1 表示不限
//
// ⚠️ 改这里的数字时，**必须同步改上面 membershipFeatures 里对应那行的展示文案**
// （free/lite/pro 三列是写死的字符串，不会跟着这里变）。两处不一致的后果是
// 「权益表说 ≤ 3 只、实际却拦在 6 只」——用户会认为是 bug，而排查时容易只
// 盯着其中一处看。
const membershipLimits = {
  free: {
    // 免费体验额度：3 只（曾为 6）。这是免费与付费最主要的差别，
    // 定稿时要同时确认：拦截文案、权益表、我的页的 freeText 三处口径一致。
    holdings: 3,
    overseas: false,
    accounts: 1,
    ocr: 5,
    plans: 3,
    fundamental: 5,
    watch: 5,
    analysis: false,
    screener: 5
  },
  lite: {
    holdings: -1,
    overseas: false,
    accounts: 1,
    ocr: 5,
    plans: 3,
    fundamental: 5,
    watch: 5,
    analysis: false,
    screener: 5
  },
  pro: {
    holdings: -1,
    overseas: true,
    accounts: 10,
    ocr: -1,
    plans: -1,
    fundamental: -1,
    watch: -1,
    analysis: true,
    screener: -1
  }
}

// 方案只写「时长 + 实付」两个事实值，划线价 / 省多少 / 每天多少 / 几折
// 全部由 api 层按 ORIGIN_PER_YEAR 现算 —— 手写的那几个数字很容易互相矛盾。
const membershipOriginPerYear = 138

const membershipPlans = [
  {
    key: 'lite-1m',
    tier: 'lite',
    name: 'Lite 月卡',
    months: 1,
    price: 5.5,
    badge: '轻量体验',
    note: '仅解锁无限持仓（不含港股美股）'
  },
  { key: 'pro-1y', tier: 'pro', name: 'Pro · 1年', months: 12, price: 98 },
  { key: 'pro-2y', tier: 'pro', name: 'Pro · 2年', months: 24, price: 168 },
  {
    key: 'pro-3y',
    tier: 'pro',
    name: 'Pro · 3年',
    months: 36,
    price: 198,
    badge: '热门',
    hot: true,
    tip: '每年只要 2 杯星巴克的钱，管好你一整年的分红'
  },
  {
    key: 'pro-5y',
    tier: 'pro',
    name: 'Pro · 5年',
    months: 60,
    price: 298,
    badge: '最超值',
    best: true
  }
]

const membershipNotes = ['永远没有广告', '到期后数据不丢失', '已有会员会自动顺延时长']

/* ---------------- 菜单配置 ---------------- */
const profileMenus = {
  group1: [
    // value 由 api.getProfile() 按当前档位实时回填，不写死
    { key: 'member', icon: '👑', name: '收息佬会员', value: '' },
    // value 由 api.getProfile() 按当前显示货币实时回填，不写死
    { key: 'currency', icon: '💱', name: '显示货币', value: '' },
    // value 由 api.getProfile() 回填当前登录用户名（App 端不收集手机号）
    { key: 'username', icon: '🆔', name: '登录账号', value: '' },
    { key: 'account', icon: '💼', name: '多账户管理', value: '' },
    // 已清仓标的的复盘台：卖出至今的涨跌 + 每笔决策的想法
    { key: 'archive', icon: '📦', name: '投资档案', value: '' },
    { key: 'standard', icon: '📋', name: '数据口径说明', value: '' },
    { key: 'contact', icon: '❤️', name: '联系我们', value: '' }
  ],
  group2: [
    { key: 'disclaimer', icon: '⚠️', name: '免责声明' },
    { key: 'agreement', icon: '📄', name: '用户协议' },
    { key: 'privacy', icon: '🔒', name: '隐私政策' }
  ]
}

const holdingMenus = [
  { key: 'trade', icon: '📋', name: '交易明细', desc: '支持记录买入、卖出、送股、分红复投', action: '添加' },
  { key: 'dividend', icon: '💰', name: '分红记录', desc: '累计已获分红', action: '添加' },
  { key: 'edit', icon: '⚙️', name: '编辑持仓', desc: '修改股数、成本与持股天数', action: '' },
  { key: 'file', icon: '📊', name: '分红档案', desc: '该持仓的历史分红方案与到账记录', action: '' },
  // 手动改过股数、又记过交易时用它把当前持仓定为新起点，避免重算时重复叠加
  { key: 'reseed', icon: '🎯', name: '校准持仓起点', desc: '把当前持仓当作新起点，已有交易只作流水', action: '' },
  // 与「删除」刻意分开：归档是留下记录，删除是抹掉记录
  { key: 'archive', icon: '📦', name: '清仓归档', desc: '移到投资档案，流水与当时的想法都保留', action: '' },
  { key: 'del', icon: '🗑', name: '删除持仓', desc: '删除后不可恢复', action: '', danger: true }
]

/* ---------------- 汇总指标（持仓页顶部汇总区） ---------------- */
// def: true 表示"恢复默认"时选中的 6 项
const metricCatalog = [
  { key: 'received', name: '今年已收', desc: '当年已入账分红总额', def: true },
  { key: 'cost', name: '总成本', desc: '各股买入成本 × 数量之和', def: true },
  { key: 'marketValue', name: '总市值', desc: '最新价 × 数量之和', def: true },
  { key: 'costYield', name: '成本息率', desc: '预测年分红 ÷ 总成本', def: true },
  { key: 'marketYield', name: '市值息率', desc: '预测年分红 ÷ 总市值', def: true },
  { key: 'monthly', name: '月均预测分红', desc: '预测年分红 ÷ 12', def: true },
  { key: 'daily', name: '日均预测分红', desc: '预测年分红 ÷ 365', def: false },
  { key: 'floatPnl', name: '浮动盈亏', desc: '总市值 - 总成本', def: false, tone: 'up' },
  { key: 'floatRate', name: '盈亏率', desc: '浮动盈亏 ÷ 总成本', def: false, tone: 'up' },
  { key: 'totalReceived', name: '累计收息', desc: '历史已收分红总额（不限当年）', def: false },
  { key: 'netInvest', name: '净投入', desc: '买入总额 - 卖出总额', def: false },
  { key: 'holdCount', name: '持仓只数', desc: '当前持有标的数量', def: false }
]

const METRIC_MAX = 6

/* ---------------- 我的持仓：排序 / 分组 ---------------- */
// default 保持录入顺序，与参考图一致；其余按对应数值降序
const holdingSorts = [
  { key: 'default', desc: '默认排序（录入顺序）' },
  { key: 'dividend', desc: '按预测分红：高 → 低' },
  { key: 'priceYield', desc: '按股价息率：高 → 低' },
  { key: 'costYield', desc: '按成本息率：高 → 低' },
  { key: 'marketValue', desc: '按持仓市值：高 → 低' }
]

const holdingGroups = [
  { key: 'none', desc: '不分组' },
  { key: 'yield', desc: '按息率档位：高息 / 中息 / 低息' },
  { key: 'contribution', desc: '按分红贡献：主力仓 / 次要仓 / 小额仓' },
  { key: 'position', desc: '按仓位大小：重仓 / 中仓 / 轻仓' }
]

/* ---------------- 日历图例 / 月份 ---------------- */
const calendarLegend = [
  { key: 'reg', label: '股权登记', color: 'blue' },
  { key: 'ex', label: '除权除息', color: 'orange' },
  { key: 'pay', label: '派息日', color: 'green' }
]

const yearMonths = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/* ---------------- 币种 ---------------- */
/* rate = 「1 元人民币 = rate 个该币种」，两个方向的换算都从它推：
 *   人民币  -> 显示货币：v * rate   （api.js 的 conv，用于资产类金额展示）
 *   股票本币 -> 人民币：  v / rate   （api.js 的 cnyPerUnit / toCny，录入时统一折成人民币存）
 *
 * 注意 USD 曾经填成 7.25 —— 那是「1 美元 ≈ 7.25 元」的写法，方向正好相反，
 * 会让选美元展示时金额被放大 7 倍多，同时在按本币折算时把美元算成 1/7。
 */
const currencyOptions = [
  { code: 'CNY', name: '人民币', symbol: '¥', rate: 1 },
  { code: 'HKD', name: '港币', symbol: 'HK$', rate: 1.08 },
  { code: 'USD', name: '美元', symbol: '$', rate: 0.1379 }
]

/* ---------------- 多账户 ---------------- */
// holder 是账户归属人，用中性占位 —— 不写任何示例身份信息
const accounts = [
  { id: 'acc-main', name: '主账户', broker: 'A股 / 港股 通用', holder: '本人', active: true },
  { id: 'acc-etf', name: 'ETF 账户', broker: '场内基金专用', holder: '本人', active: false },
  { id: 'acc-kid', name: '孩子教育金', broker: '独立记账', holder: '本人', active: false }
]

/* ---------------- 我的：数据口径说明 ---------------- */
const standardRows = [
  { name: '分红口径', desc: '默认取最近 1 年的每股派息；可在添加持仓时改为近 3 年 / 近 5 年平均或手填' },
  { name: '成本口径', desc: '支持分红摊薄、摊薄成本、加权平均三种；负成本表示本金已通过卖出全部收回' },
  { name: '息率口径', desc: '成本息率 = 预测年分红 ÷ 持仓成本；股价息率 = 预测年分红 ÷ 最新市值' },
  { name: '税率处理', desc: '港股分红按 28% 预扣，A股 / ETF / 基金按 0% 计，预测分红均为税后金额' },
  { name: '行情时效', desc: '价格、涨跌与分红记录实时取自东方财富公开接口，进入页面时自动刷新' },
  { name: '分红预测', desc: '基于历史派息记录推算，不构成任何投资建议' }
]

const contactInfo = {
  title: '联系我们',
  rows: [
    { label: '邮箱', value: 'hi@xiji.app' },
    { label: '微信公众号', value: '收息佬' },
    { label: '用户反馈', value: '我的 → 联系我们 → 提交问题' },
    { label: '服务时间', value: '工作日 10:00 - 19:00' }
  ]
}

/* ---------------- 应用信息 ---------------- */
/**
 * ICP 备案号。
 * 这里之前放的是模板里的示例备案号（不是本项目的），已经清空 ——
 * 自己的小程序备案下来后填在这里（形如「浙ICP备2026xxxxxx号-1X」），
 * 「我的」页底部会自动显示；留空则整行不渲染。
 *
 * 别填别人的备案号：备案主体要和小程序主体一致，填错审核过不了。
 */
const appInfo = {
  icpNo: ''
}

/* ---------------- 我的：协议 / 隐私 / 免责声明 ---------------- */
// 三类文档共用一套结构：标题 + 段落数组
const legalDocs = {
  disclaimer: {
    title: '免责声明',
    updated: '2026-08-01',
    paras: [
      '本应用提供的所有数据、图表与预测结果，均基于公开信息与历史分红记录推算，仅供个人记账与学习参考。',
      '预测年分红不等于实际到手分红。上市公司可能调整、取消分红方案，也可能因汇率、税率变化导致到账金额与预测不一致。',
      '成本息率、股价息率等指标是数学计算结果，不代表未来收益，也不构成任何买入、卖出或持有建议。',
      '本应用为本地记账工具，不提供证券开户、交易代理、投资顾问等任何持牌服务，也不接入任何券商交易通道。',
      '因使用或依赖本应用内容而做出的任何投资决策，风险与后果由用户自行承担。'
    ]
  },
  agreement: {
    title: '用户协议',
    updated: '2026-09-16',
    paras: [
      '欢迎使用收息佬。在使用本应用前，请阅读并同意本协议的全部条款。',
      '一、服务内容。本应用提供持仓记录、分红预测、分红日历、覆盖进度统计等个人记账功能。所有数值仅作个人参考，不构成任何投资建议，据此操作的风险由你自行承担。',
      '二、账号与数据。你注册账号后，持仓、分红记录、支出偏好等数据会同步到服务器，以便换设备或重装后恢复。数据按账号隔离，其他用户无法看到。你可以在「我的 → 注销账号」中随时删除全部数据。',
      '三、使用规范。你应保证录入信息的真实性，不得利用本应用从事任何违法违规活动，不得批量抓取或转售本应用展示的行情数据。',
      '四、服务变更。我们可能对功能进行升级、调整或下线，重大变更会提前在应用内提示。',
      '五、协议更新。本协议更新后继续使用本应用，即视为接受更新后的条款。'
    ]
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-09-16',
    paras: [
      '我们非常重视你的隐私。本政策说明本应用会收集什么、怎么使用，以及你如何删除。',
      '一、不采集的部分。本应用不收集手机号，也不读取通讯录、短信、相册、地理位置，不做通讯记录分析。',
      '二、登录账号。你注册时设置的用户名用于登录与区分账号；密码只保存加密后的哈希值（不可逆），我们看不到也无法还原你的明文密码。',
      '三、登录状态。登录成功后会在服务器生成一个有效期 30 天的登录凭证，保存在你的设备上用于免登录；你可以在「我的 → 退出登录」中随时让它失效。',
      '四、业务数据。你录入的持仓、分红记录、支出与设置等数据，会同步保存在我们部署于腾讯云（上海）的服务器上，用于换设备恢复与数据统计。',
      '五、行情数据。为展示实时行情与分红信息，服务端会向公开行情接口查询你所关注标的的代码，查询内容不包含你的个人信息。',
      '六、第三方。本应用不嵌入第三方广告或数据分析 SDK。',
      '七、你的权利。你可以随时在「我的 → 注销账号」中删除服务器与本机的全部数据，删除后不可恢复。'
    ]
  }
}

/* ---------------- 发现：榜单详情 ---------------- */
// 榜单的「成员」是编辑侧决定的精选清单；「数值」一律不落本地，
// 由 utils/api.js 按 codes 拉实时行情 + 真实分红记录现算：
//   metric: 'yield'    税后股价息率（%）
//   metric: 'years'    连续分红年数（年）
//   metric: 'weight'   自由流通市值加权占比（%）
const rankBoards = {
  r1: {
    id: 'r1',
    name: '高股息榜',
    icon: '🏆',
    badge: '实时更新',
    unit: '%',
    metric: 'yield',
    note: '股价息率 = 上一个完整年度的每股派息 ÷ 最新股价，港股按默认 20% 红利税折算（持仓里可逐只调整）。数值随行情实时计算。',
    codes: ['00883', '00941', '01138', '601006', '601398', '601088', '600028', '01398', '600900']
  },
  r2: {
    id: 'r2',
    name: '连续分红榜',
    icon: '🎖️',
    badge: '长期主义',
    unit: '年',
    metric: 'years',
    note: '统计样本为公司连续实施现金分红的完整会计年度数，中断一年即重新计数，按真实历史分红记录统计。',
    codes: ['600900', '601398', '601939', '601006', '601988', '601088', '600028', '00941']
  },
  r3: {
    id: 'r3',
    name: '红利指数',
    icon: '🧺',
    badge: '组合',
    unit: '%',
    metric: 'weight',
    note: '以「一篮子高息资产」的方式分散持有，按自由流通市值加权（港股按汇率折算人民币）。',
    codes: ['601398', '601088', '600028', '601006', '600900', '00941', '600036', '00883']
  }
}

/* ---------------- 发现：文章正文 ---------------- */
// body 为块数组：h=小标题，p=段落，q=引用
const articleBodies = {
  a1: {
    tag: '理念',
    read: '3 分钟',
    body: [
      { t: 'p', v: '很多人看账户只看一个数字：总市值。涨了开心，跌了焦虑，一天要打开十几次行情。' },
      {
        t: 'p',
        v: '但如果你买的是高息资产，真正决定你能不能安稳拿住的，其实是另一件事——每年有多少现金真的进了你的银行卡。'
      },
      { t: 'h', v: '股价是别人的报价，分红是公司的付账' },
      {
        t: 'p',
        v: '股价每秒钟都在变，它反映的是市场情绪、资金流向、短期预期，和你持有的公司今年赚没赚钱没有直接关系。'
      },
      {
        t: 'p',
        v: '分红不一样。它是公司从真实利润里拿出来、按持股比例打到你账户上的现金。这笔钱到账后不会因为明天股价跌了 3% 就缩水。'
      },
      { t: 'h', v: '为什么现金流更适合长线' },
      {
        t: 'p',
        v: '假设你持有的组合每年能稳定派出 6 万元分红，那么无论股价怎么波动，这 6 万元都能覆盖你一年的开销。股价跌了，你反而可以用同样的分红买到更多股数。'
      },
      { t: 'q', v: '真正让你拿不住的，从来不是下跌，而是没有现金流还要硬扛下跌。' },
      {
        t: 'p',
        v: '所以与其每天盯着总市值涨跌，不如把注意力放在两件事上：每股派息有没有稳定增长，以及你的持仓成本有没有被历年分红逐步摊薄。'
      },
      {
        t: 'p',
        v: '收息佬的「分红覆盖」就是把这两个数字翻译成一句人话——你的分红，已经能替你付掉几项生活账单。'
      }
    ]
  },
  a2: {
    tag: '税务',
    read: '4 分钟',
    body: [
      { t: 'p', v: '港股通分红的 28% 扣税，是很多人在港股和 A股 之间反复纠结的原因。这笔税到底吃掉多少收益？' },
      { t: 'h', v: '先算清楚这笔账' },
      {
        t: 'p',
        v: '假设某只港股每10股派 10 港元，你持有 10000 股，名义分红 10000 港元。按 28% 预扣后，实际到手是 7200 港元。'
      },
      {
        t: 'p',
        v: '如果同一家公司在 A股 也上市，A股 的股息红利税按持股期限计：持有满 1 年免征，1 个月至 1 年按 10%，1 个月以内按 20%。'
      },
      { t: 'h', v: 'A/H 溢价的抵消作用' },
      {
        t: 'p',
        v: '同一家公司 A股 与 H股 的价格通常不同。多数情况下 H股 相对 A股 存在折价，也就是同样的分红，港股买入成本更低。'
      },
      {
        t: 'p',
        v: '这个折价是长期存在的。只要折价幅度大于税负差距，港股在「同样的每股派息」下其实能拿到更高的实际息率。'
      },
      { t: 'q', v: '不要只看 28% 这个数字，要看你买入价的折价有没有把这 28% 赚回来。' },
      { t: 'h', v: '几个实操上的判断' },
      {
        t: 'p',
        v: '一、把「税后息率」算出来再对比，而不是拿税前息率比。收息佬的预测分红默认就是税后口径。'
      },
      { t: 'p', v: '二、A/H 同时上市且折价长期偏低的标的，优先考虑 A股，税负和汇率都更省心。' },
      { t: 'p', v: '三、港股持仓要额外算汇率波动，人民币升值会侵蚀以人民币计价的实际收益。' }
    ]
  },
  a3: {
    tag: '复利',
    read: '5 分钟',
    body: [
      { t: 'p', v: '分红有两种用法：花掉，或者再买回去。两种用法在头几年差别很小，但拉到 20 年，差距会大到不像同一笔钱。' },
      { t: 'h', v: '一个具体的例子' },
      {
        t: 'p',
        v: '初始 10 万元买入一组平均息率 6% 的资产，每月再定投 3000 元，分红全部再投入。'
      },
      { t: 'p', v: '第 1 年：分红约 6000 元，本金投入 3.6 万元。' },
      { t: 'p', v: '第 5 年：分红约 1.4 万元，累计投入 28 万元，账户市值约 34 万元。' },
      { t: 'p', v: '第 10 年：分红约 3.2 万元，累计投入 46 万元，账户市值约 72 万元。' },
      {
        t: 'p',
        v: '第 20 年：分红约 8.6 万元，累计投入 82 万元，账户市值约 210 万元。'
      },
      { t: 'h', v: '雪球是从哪一年开始变大的' },
      {
        t: 'p',
        v: '前 5 年，分红贡献只占新增资金的三分之一左右，你会觉得复利没什么用。第 8 到第 10 年，分红开始接近你每年的定投额。'
      },
      { t: 'p', v: '到第 15 年之后，分红再投入的金额会超过你的定投额——从这一刻起，滚雪球的主力就变成了雪球本身。' },
      { t: 'q', v: '复利的门槛从来不是收益率，而是你愿不愿意在前 5 年做那件看起来没什么用的事。' },
      {
        t: 'p',
        v: '这也是「分红覆盖」这个功能想表达的：先把一小项账单覆盖掉，再让覆盖的部分继续滚下去。'
      }
    ]
  }
}

/* ---------------- 发现：息率对比（工具 t3） / 定投回测候选池（工具 t4） ---------------- */
// 只保存成员代码；税后股价息率由 api 层按实时行情 + 真实分红现算
const yieldCompareCodes = [
  '00883', '00941', '01138', '601006', '601398',
  '601088', '600028', '510880', '600900', '510300'
]

/* ---------------- 复利 / 定投回测默认参数 ---------------- */
const compoundDefaults = {
  principal: 100000,
  monthly: 3000,
  rate: 6,
  years: 20,
  maxYears: 40
}

// 息率不写死：由 api.previewDca 从实时行情 + 真实分红算出
const dcaDefaults = {
  code: '601398',
  monthly: 3000,
  years: 10,
  priceGrowth: 3
}

module.exports = {
  user,
  expenses,
  selectedExpenseIds,
  holdings,
  dividendNotice,
  calendarEvents,
  yearOverview,
  discoverTools,
  discoverRanks,
  discoverArticles,
  onboardingDemo,
  profileMenus,
  // 会员
  membershipTiers,
  membershipOriginPerYear,
  membershipFeatures,
  membershipLimits,
  membershipPlans,
  membershipNotes,
  holdingMenus,
  holdingSorts,
  holdingGroups,
  calendarLegend,
  yearMonths,
  metricCatalog,
  METRIC_MAX,
  expenseIcons,
  stockMarkets,
  stockPool,
  // 我的 / 发现 / 工具
  currencyOptions,
  accounts,
  standardRows,
  contactInfo,
  legalDocs,
  appInfo,
  rankBoards,
  articleBodies,
  yieldCompareCodes,
  compoundDefaults,
  dcaDefaults
}
