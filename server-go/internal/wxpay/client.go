package wxpay

import (
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"xiji/api/internal/payment"
	"xiji/api/internal/store"
)

/*
微信支付 APIv3 · App 支付的真实实现。

签名这件事只有三处，但**每一处的换行位置都不一样**，抄错一个就全是 401：

  1. 调接口（下单、拉证书）：
        方法\nURL\n时间戳\n随机串\n请求体\n
     URL 是带 query 的路径（例如 /v3/pay/transactions/out-trade-no/M123?mchid=x），
     请求体为空（GET）时该行就是个空行，但**换行仍要保留**。

  2. 调起支付（给 App SDK 的参数）：
        appid\n时间戳\n随机串\nprepayid\n

  3. 回调验签：
        时间戳\n随机串\n原始报文\n

三处的共同点是**最后都带一个换行**。少这个换行，签出来的东西微信不认，
而且报错信息只会说「签名错误」，不会告诉你少了什么。

另外回调必须用**未解析的原始报文**验签：JSON 解析再序列化会改变
键顺序与空白，签名立刻对不上。所以 api 层是用 io.ReadAll 直接读 body 的。
*/

const (
	apiHost = "https://api.mch.weixin.qq.com"

	certCacheTTL = 12 * time.Hour
	httpTimeout  = 15 * time.Second
)

// Client 是微信支付渠道。
type Client struct {
	cfg  *Config
	key  *rsa.PrivateKey
	http *http.Client

	// 平台证书缓存：按序列号索引，回调验签时按请求头里的 serial 取。
	mu      sync.Mutex
	certs   map[string]*x509.Certificate
	certsAt time.Time
}

// NewClient 构造渠道。私钥解析失败会返回错误 —— 这是配置问题，
// 与其等到用户点了支付才失败，不如在启动时就说清楚。
func NewClient(cfg *Config) (*Client, error) {
	key, err := parsePrivateKey(cfg.PrivateKey)
	if err != nil {
		return nil, err
	}
	return &Client{
		cfg:   cfg,
		key:   key,
		http:  &http.Client{Timeout: httpTimeout},
		certs: make(map[string]*x509.Certificate),
	}, nil
}

// Name 是渠道标识，会写进订单的 channel 列和回调路径。
func (c *Client) Name() string { return "wxpay" }

// Ready / Missing：能构造出 Client 就说明配置齐了（NewClient 只在
// Config.Ready() 为真时被调用），所以这里恒定可用。
func (c *Client) Ready() bool       { return true }
func (c *Client) Missing() []string { return nil }

/* ---------------- 下单 ---------------- */

func (c *Client) Prepay(ctx context.Context, order *store.Order) (*payment.PrepayResult, error) {
	if order == nil || order.OrderID == "" {
		return nil, errors.New("下单失败：没拿到订单号")
	}

	amountFen := int64(order.Amount*100 + 0.5)

	body := map[string]interface{}{
		"appid":       c.cfg.AppID,
		"mchid":       c.cfg.MchID,
		"description": truncate("收息佬 "+order.PlanName, 120),
		"out_trade_no": order.OrderID,
		// 不传 time_expire，用微信默认的 7 天。
		// 会员是长期服务，订单早关晚关无所谓，留长一点对用户更宽容。
		"notify_url": c.cfg.NotifyURL,
		// attach 会原样回到回调里，是我们自己的对账辅助信息
		"attach": order.Plan,
		"amount": map[string]interface{}{
			"total":    amountFen, // 单位：分
			"currency": "CNY",
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	path := "/v3/pay/transactions/app"
	res, err := c.call(ctx, http.MethodPost, path, payload)
	if err != nil {
		return nil, err
	}

	var resBody struct {
		PrepayID string `json:"prepay_id"`
		Code     string `json:"code"`
		Message  string `json:"message"`
	}
	if err := json.Unmarshal(res, &resBody); err != nil {
		return nil, errors.New("微信下单返回的不是合法 JSON")
	}
	if resBody.PrepayID == "" {
		msg := resBody.Message
		if msg == "" {
			msg = resBody.Code
		}
		if msg == "" {
			msg = "下单失败，请稍后重试"
		}
		return nil, errors.New("微信下单失败：" + msg)
	}

	params, err := c.appPayParams(resBody.PrepayID)
	if err != nil {
		return nil, err
	}

	return &payment.PrepayResult{PrepayID: resBody.PrepayID, ClientParams: params}, nil
}

// appPayParams 拼「调起支付参数」。
// 字段名由微信 SDK 约定（注意是 partnerid / prepayid 这种全小写），
// 少一个字母或者大小写不对，SDK 会直接报参数错误。
func (c *Client) appPayParams(prepayID string) (map[string]string, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	n, err := nonce()
	if err != nil {
		return nil, err
	}

	// 末尾换行不能省
	message := c.cfg.AppID + "\n" + ts + "\n" + n + "\n" + prepayID + "\n"
	sig, err := c.sign(message)
	if err != nil {
		return nil, err
	}

	return map[string]string{
		"appid":     c.cfg.AppID,
		"partnerid": c.cfg.MchID,
		"prepayid":  prepayID,
		"package":   "Sign=WXPay",
		"noncestr":  n,
		"timestamp": ts,
		"sign":      sig,
	}, nil
}

/* ---------------- 回调 ---------------- */

func (c *Client) ParseNotify(header http.Header, rawBody []byte) (*payment.NotifyEvent, error) {
	var body struct {
		Resource struct {
			Algorithm      string `json:"algorithm"`
			Ciphertext     string `json:"ciphertext"`
			Nonce          string `json:"nonce"`
			AssociatedData string `json:"associated_data"`
		} `json:"resource"`
	}
	if err := json.Unmarshal(rawBody, &body); err != nil {
		return nil, errors.New("回调不是合法 JSON")
	}

	certs, err := c.platformCerts(context.Background())
	if err != nil {
		return nil, err
	}
	if err := verifyNotify(header, rawBody, certs); err != nil {
		return nil, err
	}

	plain, err := c.aesGcmDecrypt(body.Resource.Ciphertext, body.Resource.Nonce, body.Resource.AssociatedData)
	if err != nil {
		return nil, errors.New("回调解密失败：" + err.Error())
	}

	var data struct {
		OutTradeNo    string `json:"out_trade_no"`
		TradeState    string `json:"trade_state"`
		TransactionID string `json:"transaction_id"`
		Attach        string `json:"attach"`
	}
	if err := json.Unmarshal(plain, &data); err != nil {
		return nil, errors.New("回调解密后不是合法 JSON")
	}

	// 微信的状态词在这里消化掉：上层只关心「这笔付成了没有」。
	// SUCCESS 之外还有 NOTPAY / CLOSED / REFUND / PAYERROR 等状态，
	// 它们同样是有效信息（用户付款失败时会来问），所以原样放进 State 留痕。
	state := strings.TrimSpace(data.TradeState)
	return &payment.NotifyEvent{
		OutTradeNo:    strings.TrimSpace(data.OutTradeNo),
		Paid:          state == "SUCCESS",
		State:         state,
		TransactionID: strings.TrimSpace(data.TransactionID),
		Attach:        strings.TrimSpace(data.Attach),
	}, nil
}

// NotifyReply 按微信 APIv3 要求的格式应答：成功 2xx + {"code":"SUCCESS"}，
// 失败 5xx + {"code":"FAIL"}。
//
// 形状不能随手改：微信判成败看的是 HTTP 状态码，但排障时看的是这个 body，
// 而且格式不对它会一直重推同一条通知。
func (c *Client) NotifyReply(w http.ResponseWriter, ok bool, message string) {
	status := http.StatusOK
	code := "SUCCESS"
	if !ok {
		status = http.StatusInternalServerError
		code = "FAIL"
	}
	if message == "" {
		message = code
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}

// verifyNotify 验签。构造串是「时间戳\n随机串\n报文\n」。
func verifyNotify(header http.Header, rawBody []byte, certs map[string]*x509.Certificate) error {
	ts := header.Get("Wechatpay-Timestamp")
	n := header.Get("Wechatpay-Nonce")
	sig := header.Get("Wechatpay-Signature")
	serial := header.Get("Wechatpay-Serial")

	if ts == "" || n == "" || sig == "" || serial == "" {
		return errors.New("回调缺少验签头")
	}

	cert := certs[serial]
	if cert == nil {
		return errors.New("平台证书序列号不匹配：" + serial)
	}

	sigBytes, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		return errors.New("回调签名不是合法 Base64")
	}

	message := ts + "\n" + n + "\n" + string(rawBody) + "\n"
	h := sha256.New()
	h.Write([]byte(message))

	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return errors.New("平台证书不是 RSA 公钥")
	}
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, h.Sum(nil), sigBytes); err != nil {
		return errors.New("回调验签不通过")
	}
	return nil
}

// aesGcmDecrypt 解密回调里的 resource。
//
// 微信的密文是 AES-256-GCM：Base64 解码后的字节序列是「密文 || 16 字节认证标签」，
// 而这**正好就是 Go 的 cipher.AEAD.Open 期望的格式** —— 它也不拆标签。
// 所以不要手工把最后 16 字节切出来再拼回去：切了反而容易因为切片复用出错，
// 直接整段传进去即可。
//
// 解密失败最常见的原因是 APIv3 密钥填错（不是商户号的 API 密钥，
// 而是商户平台里单独设置的 32 位 APIv3 密钥），所以错误提示往这上面引。
func (c *Client) aesGcmDecrypt(ciphertextB64, nonce, associatedData string) ([]byte, error) {
	key := []byte(c.cfg.APIv3Key)
	if len(key) != 32 {
		return nil, errors.New("APIv3 密钥必须是 32 字节")
	}

	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return nil, errors.New("密文不是合法 Base64")
	}
	if len(raw) <= 16 {
		return nil, errors.New("密文长度异常")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	plain, err := gcm.Open(nil, []byte(nonce), raw, []byte(associatedData))
	if err != nil {
		return nil, errors.New("解密失败（请检查 WXPAY_API_V3_KEY 是否正确）")
	}
	return plain, nil
}

/* ---------------- 平台证书 ---------------- */

type certListResp struct {
	Data []struct {
		SerialNo           string `json:"serial_no"`
		EncryptCertificate struct {
			Ciphertext     string `json:"ciphertext"`
			Nonce          string `json:"nonce"`
			AssociatedData string `json:"associated_data"`
		} `json:"encrypt_certificate"`
	} `json:"data"`
}

// platformCerts 拉平台证书（12 小时缓存）。
//
// 回调验签必须用微信的平台证书，而它会轮换，所以不能写死 ——
// 缓存 12 小时是官方建议的量级：既能应付轮换，又不会每个回调都去拉一次。
func (c *Client) platformCerts(ctx context.Context) (map[string]*x509.Certificate, error) {
	c.mu.Lock()
	if len(c.certs) > 0 && time.Since(c.certsAt) < certCacheTTL {
		out := c.certs
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	res, err := c.call(ctx, http.MethodGet, "/v3/certificates", nil)
	if err != nil {
		return nil, err
	}

	var list certListResp
	if err := json.Unmarshal(res, &list); err != nil {
		return nil, errors.New("证书接口返回的不是合法 JSON")
	}

	certs := make(map[string]*x509.Certificate, len(list.Data))
	for _, item := range list.Data {
		plain, err := c.aesGcmDecrypt(
			item.EncryptCertificate.Ciphertext,
			item.EncryptCertificate.Nonce,
			item.EncryptCertificate.AssociatedData,
		)
		if err != nil {
			// 单张证书解不开就跳过：可能正好在轮换中，
			// 下一张能用就够了，不必让整个验签失败。
			continue
		}

		block, _ := pem.Decode(plain)
		if block == nil {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		certs[item.SerialNo] = cert
	}

	if len(certs) == 0 {
		return nil, errors.New("没有拿到任何可用的平台证书")
	}

	c.mu.Lock()
	c.certs = certs
	c.certsAt = time.Now()
	c.mu.Unlock()

	return certs, nil
}

/* ---------------- 请求与签名 ---------------- */

// call 发一个带签名的 APIv3 请求，返回响应体。
func (c *Client) call(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	auth, err := c.authHeader(method, path, body)
	if err != nil {
		return nil, err
	}

	var reader io.Reader
	if len(body) > 0 {
		reader = strings.NewReader(string(body))
	}

	req, err := http.NewRequestWithContext(ctx, method, apiHost+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "xiji-app/1.0")
	req.Header.Set("Authorization", auth)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, errors.New("微信支付接口超时，请稍后重试")
		}
		return nil, errors.New("微信支付接口请求失败")
	}
	defer resp.Body.Close()

	res, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, errors.New("读取微信支付响应失败")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 把微信的错误码与描述带出来：401 是签名/证书问题，
		// 400 多半是参数（金额、单号），运维看到能立刻判断方向。
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(res, &e)
		if e.Message != "" {
			return nil, fmt.Errorf("微信支付返回 %d：%s %s", resp.StatusCode, e.Code, e.Message)
		}
		return nil, fmt.Errorf("微信支付返回 %d", resp.StatusCode)
	}

	return res, nil
}

// authHeader 拼 Authorization 头。签名串为「方法\nURL\n时间戳\n随机串\n报文\n」。
func (c *Client) authHeader(method, path string, body []byte) (string, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	n, err := nonce()
	if err != nil {
		return "", err
	}

	// 注意最后这个换行：body 为空时这一行是空的，但换行必须在
	message := method + "\n" + path + "\n" + ts + "\n" + n + "\n" + string(body) + "\n"
	sig, err := c.sign(message)
	if err != nil {
		return "", err
	}

	parts := []string{
		`mchid="` + c.cfg.MchID + `"`,
		`nonce_str="` + n + `"`,
		`signature="` + sig + `"`,
		`timestamp="` + ts + `"`,
		`serial_no="` + c.cfg.SerialNo + `"`,
	}
	return "WECHATPAY2-SHA256-RSA2048 " + strings.Join(parts, ","), nil
}

// sign 做 RSA-SHA256 签名并 base64 编码。
func (c *Client) sign(message string) (string, error) {
	h := sha256.New()
	h.Write([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, h.Sum(nil))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// nonce 是 32 位大写十六进制随机串（微信要求）。
func nonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToUpper(hexEncode(buf)), nil
}

func hexEncode(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, digits[v>>4], digits[v&0x0f])
	}
	return string(out)
}

// QueryOrder 主动查单。
//
// 用在哪：用户付完钱回到 App，但回调还没到（或丢了）时，
// 客户端轮询的是我们自己的订单表；如果订单还是 pending，
// 运维可以用这个函数去微信那边核实到底付没付。
func (c *Client) QueryOrder(ctx context.Context, outTradeNo string) ([]byte, error) {
	path := "/v3/pay/transactions/out-trade-no/" + url.PathEscape(outTradeNo) +
		"?mchid=" + url.QueryEscape(c.cfg.MchID)
	return c.call(ctx, http.MethodGet, path, nil)
}

/* ---------------- 工具 ---------------- */

// parsePrivateKey 解析商户私钥。
// 同时支持 PKCS#8（微信商户平台下载下来的就是这个）和老的 PKCS#1。
func parsePrivateKey(pemStr string) (*rsa.PrivateKey, error) {
	s := strings.TrimSpace(pemStr)
	if s == "" {
		return nil, errors.New("商户私钥为空")
	}

	block, _ := pem.Decode([]byte(s))
	if block == nil {
		return nil, errors.New("商户私钥不是合法的 PEM（检查换行有没有被正确还原）")
	}

	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("商户私钥不是 RSA 类型")
		}
		return rk, nil
	}

	if rk, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return rk, nil
	}

	return nil, errors.New("无法解析商户私钥")
}

// truncate 按**字符**截断（微信的长度限制是按字符算的，
// 而描述里的中文一个字占三字节，按字节截会截出半个汉字）。
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
