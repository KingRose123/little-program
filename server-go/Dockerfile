# 多阶段构建：编译阶段带完整工具链，运行阶段只留一个静态二进制。
#
# 为什么值得这么折腾：Go 编出来的东西可以静态链接，
# 于是最终镜像里没有 Go 工具链、没有 C 库、没有包管理器 ——
# 镜像小一个数量级，攻击面也小一个数量级（这是对外提供服务的进程）。

# ---------- 编译 ----------
FROM golang:1.22-alpine AS build

WORKDIR /src

# 先只拷依赖清单再下载：只要 go.mod / go.sum 没变，
# 这一层就命中构建缓存，改业务代码不用重下依赖。
#
# ⚠️ go.sum 必须一起提交到版本库。它是依赖的校验和，
# 少了它构建会以 `missing go.sum entry` 或 `COPY failed: no source files` 收场 ——
# 而这两句报错都不提「你忘了提交 go.sum」。
# 重新生成：go mod tidy
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0 才能静态链接，最终镜像里不需要任何 C 库；
# -trimpath 去掉构建机绝对路径；
# -s -w 去掉符号表与调试信息，二进制小一圈。
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags "-s -w" \
      -o /out/xiji-api ./cmd/api

# ---------- 运行 ----------
FROM alpine:3.20

# tzdata 是必须的，不是可选的：
# 整套会员到期逻辑按 Asia/Shanghai 的自然日比较，
# 镜像里没有时区数据的话 LoadLocation 会失败，只能降级成固定 +8 兜底。
# ca-certificates 用于访问东方财富等 HTTPS 上游。
RUN apk add --no-cache tzdata ca-certificates wget && \
    adduser -D -u 1000 app

ENV TZ=Asia/Shanghai \
    APP_PORT=8080

WORKDIR /app
COPY --from=build /out/xiji-api /app/xiji-api

# 以非 root 运行：服务本身不需要任何特权
USER 1000

EXPOSE 8080

# 健康检查打的是 /api/health，它会真的取一次数据库连接，
# 所以「容器 healthy」意味着「数据库也通」。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["/app/xiji-api"]
