#!/bin/bash
# Lambda Web Adapter가 실행하는 시작 스크립트. Next standalone 서버를 8080에서 띄운다.
# (레이어가 /opt/bootstrap으로 감싸고, 8080으로 들어오는 HTTP를 Lambda 이벤트와 바꿔 준다)
export PORT="${AWS_LWA_PORT:-8080}"
export HOSTNAME=127.0.0.1
export NODE_ENV=production
cd "$(dirname "$0")"
exec node apps/web/server.js
