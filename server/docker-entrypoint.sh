#!/bin/sh
# 容器启动脚本：先把定时任务挂上，再把服务拉起来
#
# 云托管没有控制台级的定时调度，官方做法就是容器内跑 crond，所以这里：
#   1. 按 CRON_TOKEN 生成 crontab —— 令牌从环境变量注入，不会烤进镜像；
#   2. 没配令牌就整段跳过，避免出现「任务在跑但一直被 401」这种哑失败；
#   3. 到点用 curl 打本地接口，让预热发生在正在服务的那个进程里。
set -e

PORT_NUM="${PORT:-80}"

if [ -n "$CRON_TOKEN" ]; then
  # 注意：CRON_TOKEN 请只用字母 / 数字 / 下划线 / 短横线，
  # 因为令牌是直接拼进 JSON 和 crontab 的（crontab 里 % 是保留字符）。
  mkdir -p /etc/crontabs
  cat > /etc/crontabs/root <<EOF
# 工作日开盘前 / 收盘后各预热一次全部用户持仓标的的行情缓存
0 9 * * 1-5 curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"token":"$CRON_TOKEN"}' http://127.0.0.1:$PORT_NUM/api/cron/warm
5 16 * * 1-5 curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"token":"$CRON_TOKEN"}' http://127.0.0.1:$PORT_NUM/api/cron/warm
# 每天凌晨回收过期缓存
30 4 * * * curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"token":"$CRON_TOKEN"}' http://127.0.0.1:$PORT_NUM/api/cron/clean
EOF
  # busybox crond 要求 crontab 权限为 600
  chmod 600 /etc/crontabs/root
  # -b 后台运行，-c 明确指定目录；启动失败不能拖垮主服务
  crond -b -l 8 -c /etc/crontabs || echo '[entrypoint] crond 启动失败，定时任务不可用'
  echo '[entrypoint] 定时任务已启用（时区 Asia/Shanghai）'
else
  echo '[entrypoint] 未配置 CRON_TOKEN，已跳过定时任务'
fi

exec node src/index.js
