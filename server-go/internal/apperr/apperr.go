// Package apperr 区分「可以告诉用户的错误」和「只能记日志的错误」。
//
// 旧 Node 版靠「抛出的对象上有没有 msg 字段」来做这个区分（见 routes.js 的 handle，
// 该文件已随 Node 版后端一起移除），
// 于是每个 catch 里都要写 `e.msg || e.message || '兜底文案'`，
// 一旦有人抛了字符串或抛了非 Error 对象，用户看到的就是一句没用的兜底。
//
// 换成显式类型后，判断只有一处：errors.As(err, &apperr.Biz)。
package apperr

import "errors"

// Biz 是业务错误：它的 Msg 可以直接展示给用户。
// 典型场景是「用户名已被注册」「配对码无效」这类用户自己能纠正的情况。
type Biz struct {
	Msg string
}

func (e *Biz) Error() string { return e.Msg }

// New 构造一个业务错误。
func New(msg string) error { return &Biz{Msg: msg} }

// IsBiz 判断错误是不是业务错误。
func IsBiz(err error) bool {
	var b *Biz
	return errors.As(err, &b)
}

// Message 取出给用户看的话。
//
// 是业务错误就用它的原文（那些文案是仔细写过的，能指导用户下一步怎么做）；
// 否则一律用 fallback —— 把数据库错误、网络超时的原文抛给用户，
// 既看不懂，又泄露了实现细节。
func Message(err error, fallback string) string {
	var b *Biz
	if errors.As(err, &b) && b.Msg != "" {
		return b.Msg
	}
	return fallback
}
