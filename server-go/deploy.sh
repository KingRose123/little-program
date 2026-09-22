#!/usr/bin/env bash
#
# 收息佬后端部署脚本：编译 → 替换 → 重启 → 健康检查，任一步失败自动回滚。
#
# 放在源码目录里，和 go.mod 同级：
#   /opt/xiji-src/server-go/deploy.sh
#
# 用法：
#   ./deploy.sh                # 编译并发布
#   ./deploy.sh --build-only   # 只编译，不碰线上服务
#   ./deploy.sh --help
#
# 为什么值得有这么一个脚本 —— 这条链路上每一步的失败后果都不一样：
#   1) 编译失败：**绝不能重启**。重启会把正在正常服务的进程换成半成品，
#      本来只是"这次改动没生效"，会变成"服务挂了"。
#   2) 重启后不健康：说明新二进制有问题，必须能自动退回上一版 ——
#      靠人盯着 curl 结果再手动回滚，半夜发版时基本做不到。
#   3) 健康检查偶尔只是慢：容器起进程要几秒，所以必须重试而不是一次就判死。
# 把这些判断固化下来，比每次手敲一长串命令可靠得多。

set -euo pipefail

# ---------- 可配置项（用环境变量覆盖，不必改脚本）----------
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_PATH="${BIN_PATH:-/opt/xiji/xiji-api}"
CONTAINER="${CONTAINER:-xiji-api}"
# 健康检查地址。默认**留空**，运行前从容器实际的端口映射里探（见 resolve_health_url）。
#
# 这里曾经写死过一个端口，教训是：写 8080 的人在映射到 18080 的机器上必失败，
# 反过来也一样。而本脚本失败即回滚 —— 于是现象变成「部署说回滚了，可服务
# 明明一直是好的」，一个完全误导人的结果。端口是部署时定的，不该由脚本猜。
HEALTH_URL="${HEALTH_URL:-}"
GOPROXY_HOST="${GOPROXY_HOST:-https://goproxy.cn,direct}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"    # 最多探 15 次
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"   # 每次间隔 2 秒 → 最多等 30 秒
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"         # 保留最近几份备份

BUILD_ONLY=0

# ---------- 输出 ----------
c_reset='\033[0m'; c_red='\033[31m'; c_green='\033[32m'; c_yellow='\033[33m'; c_blue='\033[36m'
info()  { printf "${c_blue}[deploy]${c_reset} %s\n" "$*"; }
ok()    { printf "${c_green}[ ok ]${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yellow}[warn]${c_reset} %s\n" "$*"; }
die()   { printf "${c_red}[fail]${c_reset} %s\n" "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    -h|--help)    usage ;;
    *) die "未知参数：$arg（用 --help 看用法）" ;;
  esac
done

# ---------- 前置检查 ----------
# 宁可在这里就退出，也不要跑到一半发现缺东西 —— 那时二进制可能已经动过了。
check_prereqs() {
  command -v go >/dev/null 2>&1 || die "找不到 go，先装 Go 工具链"
  command -v docker >/dev/null 2>&1 || die "找不到 docker"

  [ -f "$SRC_DIR/go.mod" ] || die "$SRC_DIR 里没有 go.mod，脚本要放在源码目录中"

  if [ "$BUILD_ONLY" -eq 0 ]; then
    docker inspect "$CONTAINER" >/dev/null 2>&1 \
      || die "容器 $CONTAINER 不存在（用 CONTAINER=名字 ./deploy.sh 指定）"
  fi

  # 国内直连 proxy.golang.org 基本拉不动依赖，这里兜一下底。
  # 只在当前进程生效，不改用户的全局 go env。
  export GOPROXY="$GOPROXY_HOST"
  export GOFLAGS="${GOFLAGS:-}"
  ok "前置检查通过（GOPROXY=$GOPROXY）"
}

# ---------- 健康检查地址 ----------
# 从容器实际的端口映射里探出宿主端口；探不到才退回默认值。
#
# 为什么值得自动探：容器映射到哪个宿主端口是部署时定的（compose 里改一行、
# 或直接 docker run -p），脚本无从知道。写死一个值就一定会在某些机器上错，
# 而错的代价是「健康检查失败 → 自动回滚」—— 用户看到的是「部署回滚了，
# 但服务其实好好的」，比直接报错更难排查。
resolve_health_url() {
  if [ -n "$HEALTH_URL" ]; then
    ok "健康检查地址（外部指定）：$HEALTH_URL"
    return 0
  fi

  # docker port 的输出形如：8080/tcp -> 127.0.0.1:18080
  local mapped
  # 末尾的 || true 不能省：脚本开着 pipefail，docker port 失败、或 head
  # 提前关掉管道（SIGPIPE）都会让整条 pipeline 返回非 0 —— 那样脚本会
  # 直接退出，而且是死在「部署之前」，现象上完全看不出跟端口有关。
  mapped=$(docker port "$CONTAINER" 2>/dev/null | head -n1 | sed 's/.*-> //' || true)
  # 绑定在全零地址上的换成回环，curl 才连得稳
  mapped=$(printf '%s' "$mapped" | sed 's/^0\.0\.0\.0:/127.0.0.1:/; s/^\[::\]:/127.0.0.1:/')

  if [ -n "$mapped" ]; then
    HEALTH_URL="http://${mapped}/api/health"
    ok "健康检查地址（自动探测）：$HEALTH_URL"
    return 0
  fi

  HEALTH_URL="http://127.0.0.1:8080/api/health"
  warn "读不到容器的端口映射，按默认值检查：$HEALTH_URL（可用 HEALTH_URL=… 覆盖）"
}

# ---------- 1. 编译 ----------
# 先编译到临时文件：编译失败时生产环境的二进制一个字都没被碰过。
build() {
  local out
  out="$(mktemp "${TMPDIR:-/tmp}/xiji-build.XXXXXX")"

  info "编译中（Linux/amd64，静态链接）…"
  local start
  start=$(date +%s)

  if ! (cd "$SRC_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -trimpath -ldflags "-s -w" -o "$out" ./cmd/api); then
    rm -f "$out"
    die "编译失败，线上服务未被改动"
  fi

  chmod +x "$out"
  local size
  size=$(stat -c %s "$out")
  ok "编译完成：$((size/1024/1024))MB，耗时 $(( $(date +%s) - start ))s"

  BUILT_BIN="$out"
}

# ---------- 2. 备份 + 替换 ----------
# 备份不是走过场：健康检查失败时要靠它退回去。
install_binary() {
  if [ -f "$BIN_PATH" ]; then
    BACKUP="${BIN_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$BIN_PATH" "$BACKUP"
    ok "已备份：$BACKUP"
  else
    BACKUP=""
    warn "$BIN_PATH 原本不存在，没有可备份的旧版本"
  fi

  # mv 在同一文件系统内是原子的。正在运行的进程持有的是旧 inode，
  # 所以替换它对已启动的服务没有影响 —— 真正让它换代码的是后面的重启。
  mv "$BUILT_BIN" "$BIN_PATH"
  chmod +x "$BIN_PATH"
  ok "已替换：$BIN_PATH（$(stat -c %s "$BIN_PATH") 字节）"

  # 只保留最近几份，免得 /opt 被备份撑满
  ls -1t "${BIN_PATH}".bak.* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
}

# ---------- 3. 重启 ----------
restart_container() {
  local mounts workdir
  mounts=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null || true)
  workdir=$(docker inspect "$CONTAINER" --format '{{.Config.WorkingDir}}' 2>/dev/null || true)

  # 两种情况要分开处理：二进制是挂载进容器的（改宿主文件就生效），
  # 还是 docker build 时 COPY 进镜像的（得 docker cp 进容器内部）。
  if printf '%s' "$mounts" | grep -q "$(dirname "$BIN_PATH")"; then
    info "容器为挂载运行，直接重启即可"
  else
    local dest="${workdir:-/app}/$(basename "$BIN_PATH")"
    warn "未在容器的挂载里找到 $(dirname "$BIN_PATH")，按「二进制打进镜像」处理"
    docker cp "$BIN_PATH" "${CONTAINER}:${dest}"
    ok "已复制进容器：$dest"
  fi

  docker restart "$CONTAINER" >/dev/null
  ok "容器已重启"
}

# ---------- 4. 健康检查 ----------
# 重试的原因：容器 restart 返回时进程往往还没开始监听端口，
# 这时候探一次必然失败 —— 一次就判死会把正常发布误判成故障。
health_check() {
  info "健康检查（最多 $((HEALTH_RETRIES * HEALTH_INTERVAL))s）…"
  local i body
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    body=$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null || true)
    if printf '%s' "$body" | grep -q '"ok":true'; then
      ok "服务健康：$body"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done

  warn "健康检查失败。最近一次响应：${body:-（无响应）}"
  return 1
}

# ---------- 5. 回滚 ----------
rollback() {
  warn "开始回滚…"
  if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
    die "没有可用备份，无法自动回滚。请手动检查：docker logs $CONTAINER"
  fi

  cp -p "$BACKUP" "$BIN_PATH"
  chmod +x "$BIN_PATH"

  local mounts workdir
  mounts=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null || true)
  if ! printf '%s' "$mounts" | grep -q "$(dirname "$BIN_PATH")"; then
    workdir=$(docker inspect "$CONTAINER" --format '{{.Config.WorkingDir}}' 2>/dev/null || true)
    docker cp "$BIN_PATH" "${CONTAINER}:${workdir:-/app}/$(basename "$BIN_PATH")" || true
  fi

  docker restart "$CONTAINER" >/dev/null || true

  if health_check; then
    ok "已回滚到：$BACKUP"
    warn "新版本有问题，请检查 docker logs $CONTAINER 后修复再发"
    exit 1
  fi

  die "回滚后依然不健康，需要人工介入：docker logs --tail 100 $CONTAINER"
}

# ---------- 主流程 ----------
main() {
  info "源码目录：$SRC_DIR"
  check_prereqs
  build

  if [ "$BUILD_ONLY" -eq 1 ]; then
    cp "$BUILT_BIN" "${BIN_PATH}.built"
    ok "只编译模式：产物在 ${BIN_PATH}.built"
    exit 0
  fi

  resolve_health_url
  install_binary
  restart_container

  if ! health_check; then
    rollback
  fi

  ok "发布完成 ✔"
  info "查看日志：docker logs -f --tail 50 $CONTAINER"
}

main
