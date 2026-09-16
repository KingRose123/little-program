# 微信云托管按这个 Dockerfile 构建镜像，监听哪个端口由 PORT 环境变量决定
FROM node:20-alpine

WORKDIR /app

# 先装依赖，源码改动时能命中这一层缓存
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# curl 供容器内的定时任务触发本地接口（crond 是 busybox 自带的）；
# tzdata 是为了让 cron 按北京时间跑 —— 容器默认是 UTC，会差 8 小时
RUN apk add --no-cache curl tzdata
ENV TZ=Asia/Shanghai

COPY . .

ENV NODE_ENV=production
# 云托管的容器默认监听 80
ENV PORT=80
EXPOSE 80

# 统一换行并在镜像里修一次 CRLF：Windows 下编辑过的脚本带上 \r 会让
# sh 把「\r」当成命令的一部分，启动直接失败
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
