// Package config 集中读取运行期配置。
//
// 与旧 Node 版（跑在腾讯云托管上）的差别：
//   旧版只能靠平台注入 MYSQL_ADDRESS（host:port）等变量；
//   自建服务器上更常见的是给一条完整 DSN。
// 所以这里两种都认，但**优先 DSN**：
//
//	MYSQL_DSN      形如 user:pass@tcp(127.0.0.1:3306)/xiji?charset=utf8mb4&loc=Local
//	MYSQL_ADDRESS  host:port，配合下面三个变量使用（迁移期沿用旧变量名，少改东西）
//	MYSQL_USERNAME / MYSQL_PASSWORD / MYSQL_DATABASE
//
// 时区是个容易踩的坑：业务里「会员到期日」「今天」全部按**本地自然日**比较
// （旧版 membership.js 的 todayKey 就是本地时区），所以进程时区必须是
// Asia/Shanghai。容器里默认是 UTC，代码里显式 LoadLocation 兜住，
// 不依赖宿主机环境。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultPort 旧版监听 80（云托管要求），自建服务器上 8080 更常规，
	// 外部由 Caddy/Nginx 反代到 443。
	DefaultPort = 8080

	// DefaultTokenTTLDays 与旧版一致：30 天。
	DefaultTokenTTLDays = 30

	// DefaultMaxPayloadBytes 单份快照上限 5MB。
	// 旧版从 1MB 放宽到 5MB 的原因值得保留在这：重度用户 100 只持仓约 30KB，
	// 每只再挂 30 条交易/分红记录就要再 600KB+，一旦超限只是「一直 dirty 一直重试」，
	// 属于很隐蔽的数据丢失。
	DefaultMaxPayloadBytes = 5 * 1024 * 1024

	// DefaultPublicRateLimit 公开接口（行情）按客户端 IP 的限流额度：每分钟次数。
	//
	// 为什么是 120：一个用户打开持仓页是一次批量请求（十几只票在一个请求里），
	// 反复切页面也很难超过每分钟几十次；而刷子想借我们的出口去打东财的免费接口，
	// 这个额度几秒就耗尽了。
	//
	// 为什么不能更小：家用宽带和公司网络后面常常是**一整栋楼共用一个出口 IP**，
	// 十个人同时用就是十倍的请求量。卡得太死会误伤正常用户 ——
	// 而误伤的表现是「行情时好时坏」，比被刷还难查。
	DefaultPublicRateLimit = 120

	DefaultTimezone = "Asia/Shanghai"
)

// RedeemGuide 是给用户看的「怎么拿到兑换码」说明。
//
// 为什么由服务端下发、而不是写死在 App 里：卖码的渠道会变 ——
// 今天挂闲鱼，明天开个淘宝店，后天加个客服微信。写死意味着每改一句话
// 都要发版、等审核、再等用户升级，而这恰恰是最随时可能调的内容。
//
// 三项都允许留空。全空时 App 会退化成一句通用提示（「请联系我们获取」），
// 所以没配也不会出现一片空白。
type RedeemGuide struct {
	// Title 弹窗标题
	Title string `json:"title"`
	// Steps 分步说明，一条一行
	Steps []string `json:"steps"`
	// Contact 联系方式（微信 / 邮箱 / 群），原样展示
	Contact string `json:"contact"`
}

// Config 是进程启动所需的全部配置。
type Config struct {
	// Port 监听端口
	Port int

	// MySQL
	DSN      string // 直接可用的 DSN（由 DSN() 组装后回填）
	DBName   string // 库名，启动时要 CREATE DATABASE IF NOT EXISTS
	Addr     string // host:port，仅用于日志与缺失项提示
	User     string
	Password string

	// TokenTTLDays 登录凭证有效期
	TokenTTLDays int

	// MaxPayloadBytes 快照体积上限
	MaxPayloadBytes int

	// PublicRateLimit 公开接口（行情）按 IP 的限流：每分钟请求数。0 表示关闭。
	//
	// 它保护的是**可用性**而非资源：行情接口不校验登录，且背后是东财的
	// 免费接口（按出口 IP 限流）。被刷的后果不是「他一个人慢」，
	// 而是所有用户一起拿不到行情。
	PublicRateLimit int

	// RedeemGuide 是「去哪买兑换码」的说明，由 App 展示给用户。
	RedeemGuide RedeemGuide

	// CronToken 定时任务令牌；为空则拒绝所有 /api/cron/* 与 /api/admin/*
	// （fail closed：令牌没配时宁可任务不跑，也不要被外部反复触发白刷上游）
	CronToken string

	// Location 业务用的本地时区
	Location *time.Location

	// Build 构建标记，用于确认线上跑的是哪份代码
	Build string
}

// Load 读取环境变量并校验。
//
// 缺 MySQL 配置直接返回错误让进程起不来 —— 这是有意的：
// 接口层几乎所有请求都要落库，带着坏配置启动只会让每个用户请求都失败一次，
// 不如启动时就明确报出来。
func Load() (*Config, error) {
	c := &Config{
		Port:            envInt("APP_PORT", envInt("PORT", DefaultPort)),
		TokenTTLDays:    envInt("TOKEN_TTL_DAYS", DefaultTokenTTLDays),
		MaxPayloadBytes: envInt("MAX_PAYLOAD_BYTES", DefaultMaxPayloadBytes),
		PublicRateLimit: envInt("PUBLIC_RATE_LIMIT", DefaultPublicRateLimit),
		CronToken:       env("CRON_TOKEN"),
		Build:           envDefault("BUILD", "dev"),
	}

	// 购买指引：卖码渠道变了只改环境变量，不用发版
	c.RedeemGuide = RedeemGuide{
		Title:   envDefault("REDEEM_GUIDE_TITLE", "如何获取兑换码"),
		Steps:   splitList(env("REDEEM_GUIDE_STEPS")),
		Contact: env("REDEEM_GUIDE_CONTACT"),
	}

	// 时区：LoadLocation 失败只可能是镜像里缺 tzdata，这种情况降级为固定 +8，
	// 保证「今天」仍然是北京时间 —— 否则会员到期判定会整体偏差一天。
	loc, err := time.LoadLocation(envDefault("TZ", DefaultTimezone))
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	c.Location = loc

	c.DBName = envDefault("MYSQL_DATABASE", "xiji")

	if dsn := env("MYSQL_DSN"); dsn != "" {
		c.DSN = dsn
		c.Addr = "via MYSQL_DSN"
		return c, nil
	}

	addr := env("MYSQL_ADDRESS")
	if addr == "" {
		return nil, fmt.Errorf("缺少 MYSQL_DSN 或 MYSQL_ADDRESS，无法确定数据库地址")
	}
	c.Addr = addr
	c.User = envDefault("MYSQL_USERNAME", "root")
	c.Password = env("MYSQL_PASSWORD")

	// parseTime=false + loc：MySQL 的 DATE/DATETIME 直接以字符串读出来。
	// 这是我们特意要的 —— 会员到期日要跟 'yyyy-MM-dd' 字符串比大小，
	// 一旦被驱动转成 time.Time，就会在「数据库时区 / 进程时区」之间来回换算，
	// 出现「明明今天到期却显示已过期」这类问题。
	c.DSN = fmt.Sprintf(
		"%s:%s@tcp(%s)/%s?charset=utf8mb4&parseTime=false&loc=%s&timeout=5s&readTimeout=15s&writeTimeout=15s",
		c.User, c.Password, addr, c.DBName, "Local",
	)

	return c, nil
}

// DSNWithoutDatabase 连到「不指定库」的 DSN，用于首次建库。
// 建库必须走这一步：第一次部署时 xiji 这个库还不存在。
func (c *Config) DSNWithoutDatabase() string {
	if d := env("MYSQL_DSN"); d != "" {
		return stripDatabase(d)
	}
	return fmt.Sprintf(
		"%s:%s@tcp(%s)/?charset=utf8mb4&parseTime=false&timeout=5s",
		c.User, c.Password, c.Addr,
	)
}

// stripDatabase 把 DSN 里 `/dbname` 这段去掉，保留后面的查询参数。
func stripDatabase(dsn string) string {
	slash := strings.LastIndex(dsn, "/")
	if slash < 0 {
		return dsn
	}
	rest := dsn[slash+1:]
	if q := strings.Index(rest, "?"); q >= 0 {
		return dsn[:slash+1] + rest[q:]
	}
	return dsn[:slash+1]
}

// Missing 列出还没配置的可选集成项，用于 /api/health 的自检输出。
// 只回变量名，不回任何密钥内容，所以打印出来是安全的。
func (c *Config) Missing() []string {
	var lack []string
	if c.CronToken == "" {
		lack = append(lack, "CRON_TOKEN")
	}
	return lack
}

/* ---------------- 小工具 ---------------- */

func env(name string) string {
	return strings.TrimSpace(os.Getenv(name))
}

func envDefault(name, def string) string {
	if v := env(name); v != "" {
		return v
	}
	return def
}

// splitList 把「a|b|c」拆成列表，顺带丢掉空项。
//
// 用 `|` 而不是逗号：文案里出现顿号、逗号太常见了
// （「淘宝搜索『收息佬』，下单后联系客服」），拿逗号当分隔符迟早出错。
func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, "|") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func envInt(name string, def int) int {
	v := env(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
