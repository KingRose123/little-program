// Package wxpay 实现微信支付（APIv3 · App 支付），是 payment.Channel
// 的一个具体实现。
//
// 渠道之间真正不同的只有三件事：签名怎么签、回调怎么验、应答怎么写。
// 订单落库、幂等发货、按渠道对账全在 api 与 store 两层，与本包无关 ——
// 所以再接一个渠道（支付宝、银联、Apple 内购）不需要动它们。
//
// 签名只有三处，但**每一处的换行位置都不一样**，详见 client.go 的包注释。
package wxpay

import (
	"os"
	"strings"
)

// 环境变量清单。缺哪个，Missing() 就报哪个的名字 ——
// 只报变量名不报内容，所以可以安全地出现在 /api/health 里。
const (
	EnvAppID        = "WXPAY_APPID"         // 开放平台「移动应用」的 AppID，不是小程序的
	EnvMchID        = "WXPAY_MCHID"         // 商户号
	EnvSerialNo     = "WXPAY_SERIAL_NO"     // 商户 API 证书序列号
	EnvAPIv3Key     = "WXPAY_API_V3_KEY"    // APIv3 密钥，必须 32 字节
	EnvNotifyURL    = "WXPAY_NOTIFY_URL"    // 支付结果通知地址，必须是公网 HTTPS
	EnvPrivateKey   = "WXPAY_PRIVATE_KEY"   // 商户私钥 PEM 全文（环境变量里的 \n 会被还原）
	EnvPrivateKeyID = "WXPAY_PRIVATE_KEY_PATH" // 或者给一个 PEM 文件路径
)

// PrepayResult / NotifyEvent / Channel 这些通用类型定义在 internal/payment。
// 放在那里而不是这里，是为了让 api 层只依赖 payment 包 ——
// 否则它就得 import wxpay，等于把「微信」写进了公共代码。

/* ---------------- 配置 ---------------- */

// Config 是微信支付所需的全部凭证。
type Config struct {
	AppID      string
	MchID      string
	SerialNo   string
	APIv3Key   string
	NotifyURL  string
	PrivateKey string // PEM 全文
}

// Load 从环境变量读取配置（缺什么不影响启动，Missing 会报出来）。
func Load() *Config {
	return &Config{
		AppID:      env(EnvAppID),
		MchID:      env(EnvMchID),
		SerialNo:   env(EnvSerialNo),
		APIv3Key:   env(EnvAPIv3Key),
		NotifyURL:  env(EnvNotifyURL),
		PrivateKey: privateKeyPEM(),
	}
}

// Missing 列出缺失项。
//
// 私钥两种给法都支持：环境变量里塞 PEM 全文（部署脚本友好），
// 或者指一个文件路径（K8s Secret 挂载友好）。两者都没有才算缺。
func (c *Config) Missing() []string {
	var lack []string
	if c.AppID == "" {
		lack = append(lack, EnvAppID)
	}
	if c.MchID == "" {
		lack = append(lack, EnvMchID)
	}
	if c.SerialNo == "" {
		lack = append(lack, EnvSerialNo)
	}
	if c.APIv3Key == "" {
		lack = append(lack, EnvAPIv3Key)
	} else if len(c.APIv3Key) != 32 {
		lack = append(lack, EnvAPIv3Key+"(必须是 32 字节)")
	}
	if c.NotifyURL == "" {
		lack = append(lack, EnvNotifyURL)
	}
	if c.PrivateKey == "" {
		lack = append(lack, EnvPrivateKey)
	}
	return lack
}

func (c *Config) Ready() bool { return len(c.Missing()) == 0 }

func privateKeyPEM() string {
	// 环境变量里的换行常常被转义成字面量 \n（尤其是从 docker-compose 的
	// env_file 或 k8s 里读进来时），这里还原回去。
	if inline := env(EnvPrivateKey); inline != "" {
		pem := strings.ReplaceAll(inline, `\n`, "\n")
		if strings.Contains(pem, "PRIVATE KEY") {
			return pem
		}
	}

	if path := env(EnvPrivateKeyID); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			return string(b)
		}
	}
	return ""
}

func env(name string) string { return strings.TrimSpace(os.Getenv(name)) }

/* ---------------- 未配置时的兜底 ---------------- */

// 未开通的占位实现放在 payment 包里（payment.Unconfigured），
// 那里带 ChannelName 与 Lack 两个字段，所有渠道共用一份，
// 不必每家都照抄一遍。装配处这样写：
//
//	payment.Unconfigured{ChannelName: "wxpay", Lack: cfg.Missing()}

// MissingLack 是微信支付缺配置时给的提示清单。
//
// 报出全部变量名（只报名字不报内容），运维看一眼就知道要配哪些。
// 私钥那项把两种给法都写出来，免得只看到 WXPAY_PRIVATE_KEY
// 而不知道还有 WXPAY_PRIVATE_KEY_PATH 这条路。
func MissingLack() []string {
	return []string{
		EnvAppID, EnvMchID, EnvSerialNo, EnvAPIv3Key, EnvNotifyURL,
		EnvPrivateKey + " 或 " + EnvPrivateKeyID,
	}
}
