// Package auth 收拢与身份相关的密码学细节：密码哈希与登录凭证。
//
// 这个包里所有参数的取值都**不能随便调**：
// 密码哈希的参数一变，已有用户的密码就再也验不过；
// 凭证的生成方式一变，已发出的 token 全部失效。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/scrypt"
)

/*
密码哈希：必须与旧 Node 版逐位兼容。

旧版（server/src/account.js，该文件已随 Node 版后端一起移除）用的是：
    salt = crypto.randomBytes(16).toString('hex')        // 32 个 hex 字符
    crypto.scrypt(password, salt, 32)                    // 只显式给了 keylen
    'scrypt$' + salt + '$' + key.toString('hex')

Node 的 crypto.scrypt 默认值就是 N=16384, r=8, p=1，所以等价于
scrypt.Key(password, []byte(salt), 16384, 8, 1, 32)。

两个极易搞错的点：
 1) 盐传的是 **32 个 ASCII 字符**（那串 hex 文本本身），不是把它解成 16 字节。
    下面传 []byte(salt) 正是这个意思。
 2) 存的是派生 key 的 hex（64 个字符），不是 base64。
*/
const (
	scryptN       = 16384
	scryptR       = 8
	scryptP       = 1
	scryptKeyLen  = 32
	saltHexLength = 32 // 16 字节的 hex 表示

	// PasswordMin / Max 与旧版一致；上限存在是为了挡住「超长密码拖慢 scrypt」
	// 这种廉价的拒绝服务（scrypt 的成本与输入长度无关，但超大输入仍会占内存）。
	PasswordMin = 6
	PasswordMax = 64

	// UsernameMin / Max 见 CheckUsername 的正则说明
	UsernameMin = 4
	UsernameMax = 20

	// tokenBytes 24 字节 → base64url 编码后恰好 32 个字符（无填充）
	tokenBytes = 24
	// TokenLength 原始 token 的字符数，用于校验客户端传来的形状
	TokenLength = 32
)

// HashPassword 生成存储串，格式 `scrypt$<salt-hex>$<key-hex>`。
func HashPassword(plain string) (string, error) {
	saltRaw := make([]byte, 16)
	if _, err := rand.Read(saltRaw); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(saltRaw)

	key, err := scrypt.Key([]byte(plain), []byte(salt), scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}

	return "scrypt$" + salt + "$" + hex.EncodeToString(key), nil
}

// VerifyPassword 校验密码。
//
// 用 ConstantTimeCompare 而不是 == ：后者会在第一个不同的字节处提前返回，
// 理论上能通过计时差异逐字节猜出哈希。这里校验的是本地算出的 key，
// 被远程精确测时的难度极高，但恒定时间比较是零成本的，没有理由不用。
func VerifyPassword(plain, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "scrypt" {
		return false
	}
	salt, wantHex := parts[1], parts[2]
	if len(salt) != saltHexLength {
		return false
	}

	want, err := hex.DecodeString(wantHex)
	if err != nil {
		return false
	}

	got, err := scrypt.Key([]byte(plain), []byte(salt), scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return false
	}
	if len(got) != len(want) {
		return false
	}

	return subtle.ConstantTimeCompare(got, want) == 1
}

/* ---------------- 用户名与密码的规则 ---------------- */

// NormalizeUsername 统一转小写并去空白。
// 不做这一步的话 Tom 和 tom 会注册成两个账号，而用户以为自己只有一个。
func NormalizeUsername(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// CheckUsername 返回空串表示合法，否则返回可直接展示给用户的提示。
// 规则与旧版一致：4-20 位，只允许小写字母、数字、下划线。
func CheckUsername(username string) string {
	if len(username) < UsernameMin || len(username) > UsernameMax {
		return "用户名只能是 4-20 位小写字母、数字或下划线"
	}
	for _, r := range username {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
		default:
			return "用户名只能是 4-20 位小写字母、数字或下划线"
		}
	}
	return ""
}

// CheckPassword 只校验长度，不强制复杂度 —— 与旧版一致。
// 强制大小写数字混合的实际效果是让用户写成 Passw0rd! 这种可预测的组合，
// 长度才是真正起作用的那个变量。
func CheckPassword(password string) string {
	n := utf8.RuneCountInString(password)
	if n < PasswordMin {
		return "密码至少 6 位"
	}
	if n > PasswordMax {
		return "密码最多 64 位"
	}
	return ""
}

/* ---------------- 登录凭证 ---------------- */

// NewToken 生成原始 token（发给客户端的那串）。
//
// 用 crypto/rand 而不是 math/rand：后者在同类种子下可预测，
// 拿着它等于拿到别人的账号。
func NewToken() (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	// base64url：URL 安全、无 +/ 与 =，可以放心放进 Authorization 头
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashToken 把原始 token 变成入库用的哈希。
//
// 库里只存哈希，明文只在签发那一刻回给客户端一次：
// 这样即使数据库被拖走，攻击者也无法直接伪造登录态。
// 这里用裸 sha256 而不是 scrypt —— token 本身已是 192 位随机数，
// 不存在被字典攻击的可能，加盐反而是纯粹的浪费。
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// LooksLikeToken 粗略校验形状，挡掉明显不是 token 的输入，
// 免得每个乱来的 Authorization 头都去查一次库。
func LooksLikeToken(token string) bool {
	if len(token) != TokenLength {
		return false
	}
	for _, r := range token {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// NewUID 生成账号主键：u_ + 24 位 hex（共 26 字符）。
//
// 与旧版 newUid 完全一致，所以已有的 u_xxx 账号 id 格式不变。
// 96 位随机在这个体量下不会撞，真撞了也会被主键挡下来（调用方按重复处理）。
func NewUID() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "u_" + hex.EncodeToString(buf), nil
}
