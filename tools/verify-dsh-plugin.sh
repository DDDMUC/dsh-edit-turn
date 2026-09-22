#!/usr/bin/env bash
#
# Live-verify dsh-edit-turn inside a throwaway DSH profile.
#
# Unit tests cannot prove three things that only a real boot can:
#   1. the package installs and its bundle patch composes into a profile tree;
#   2. the host half LOADS - its module-level imports resolve and its Config
#      schema is accepted - and both loopback routes actually get mounted;
#   3. the tool spec passes the real `ctx.tools.register()` contract check,
#      which under the identity fallback validates nothing at test time.
#
# Everything happens in a throwaway DSH_HOME on a free port. The caller's
# ~/.dsh is never touched, and the sandbox process is the only thing this
# script ever kills - by pid, never by pattern.
#
#   bash tools/verify-dsh-plugin.sh
#   DSH_BIN=/path/to/dsh/lib/bin.js PORT=4123 bash tools/verify-dsh-plugin.sh
#   DSH_HOME=/tmp/dsh-edit-turn-home bash tools/verify-dsh-plugin.sh
#   KEEP=1 bash tools/verify-dsh-plugin.sh        # leave the sandbox for inspection
#
# Never boot this against port 3080: that is the user's own live DSH.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
NODE_BIN="${NODE_BIN:-node}"
PROFILE="dsh-edit-turn-verify"
ROUTE="/dsh-edit-turn"

# Reserved: 3080 is the user's live DSH, 3099 is another session's sandbox.
RESERVED_PORTS="3080 3099"

fail() { echo "✗ $1" >&2; exit 1; }
ok()   { echo "✓ $1"; }
step() { echo; echo "── $1"; }

# Lock the sandbox home in for every DSH invocation, and launch a DSH_BIN that
# is a .js file through node.
DSH_RUN() {
  export DSH_HOME="$HOME_DIR"
  case "$DSH_BIN" in
    *.js|*.mjs|*.cjs) "$NODE_BIN" "$DSH_BIN" "$@" ;;
    *) "$DSH_BIN" "$@" ;;
  esac
}

command -v "$NODE_BIN" >/dev/null 2>&1 || fail "找不到 node（用 NODE_BIN=<路径> 指定）"

# --- sandbox home -----------------------------------------------------------
if [ -n "${DSH_HOME:-}" ]; then
  HOME_DIR="$DSH_HOME"
  CLEANUP_HOME=0
else
  HOME_DIR="/tmp/dsh-edit-turn-verify-$$"
  CLEANUP_HOME=1
fi
LOG_DIR="$(mktemp -d)"
mkdir -p "$HOME_DIR" || fail "无法创建沙箱 DSH_HOME: $HOME_DIR"

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -rf "$LOG_DIR"
  if [ "${KEEP:-0}" = "1" ]; then
    echo "沙箱保留在 $HOME_DIR"
  elif [ "$CLEANUP_HOME" = "1" ]; then
    rm -rf "$HOME_DIR"
  fi
}
trap cleanup EXIT

# --- port -------------------------------------------------------------------
if [ -z "${PORT:-}" ]; then
  PORT="$("$NODE_BIN" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')" \
    || fail "无法选择空闲端口"
fi
for reserved in $RESERVED_PORTS; do
  [ "$PORT" = "$reserved" ] && fail "端口 $PORT 是保留端口（用户主 DSH 或他人沙箱），请换一个"
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "端口 $PORT 已被占用"
fi

echo "沙箱 DSH_HOME: $HOME_DIR"
echo "沙箱端口:      $PORT"
echo "插件目录:      $HERE"

# --- 1. isolated profile ----------------------------------------------------
step "1/6 从 web 模板创建隔离 profile"
# `--from-default-profile` refuses to overwrite, so a reused DSH_HOME must skip
# creation. The profile name is this script's own, and step 2 re-links the
# plugin, so reuse is safe and makes the script idempotent.
if [ -f "$HOME_DIR/profiles/$PROFILE/package.json" ]; then
  ok "复用已存在的沙箱 profile（${PROFILE}）"
else
  DSH_RUN "$PROFILE" --from-default-profile web --dump-config >"$LOG_DIR/profile.txt" 2>&1 \
    || { tail -20 "$LOG_DIR/profile.txt" >&2; fail "无法从 web 模板创建隔离 profile"; }
  ok "隔离 profile 已创建（${PROFILE}）"
fi

# --- 2. install -------------------------------------------------------------
step "2/6 安装本插件"
DSH_RUN plugin --profile "$PROFILE" add "$HERE" >"$LOG_DIR/install.txt" 2>&1 \
  || { tail -20 "$LOG_DIR/install.txt" >&2; fail "插件安装失败"; }
ok "插件已安装"

# --- 3. the patch composes --------------------------------------------------
step "3/6 bundle patch 必须插进 profile 树"
DSH_RUN --profile "$PROFILE" --dump-config >"$LOG_DIR/dump.txt" 2>&1 \
  || { tail -20 "$LOG_DIR/dump.txt" >&2; fail "profile 配置无法生成"; }
grep -q "dsh-edit-turn" "$LOG_DIR/dump.txt" || fail "bundle patch 没有把插件插进 profile 树"
ok "bundle patch 已生效"

# --- 4. boot ----------------------------------------------------------------
step "4/6 启动沙箱实例（不会碰 3080）"
DSH_RUN --profile "$PROFILE" --port "$PORT" >"$LOG_DIR/boot.log" 2>&1 &
PID=$!
STATUS="died"
for _ in $(seq 1 45); do
  sleep 2
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then STATUS="up"; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
done
if [ "$STATUS" != "up" ]; then
  echo "--- 启动日志 ---" >&2
  tail -30 "$LOG_DIR/boot.log" >&2
  fail "profile 启动失败"
fi
ok "沙箱实例已启动（HTTP 401 = 需要 token，属预期）"

# Any of these means a real plugin defect, not a test artefact.
if grep -qE "must declare output|unsupported JSON schema|failed to apply loader entry dsh-edit-turn|ClientPackageCompositionError" "$LOG_DIR/boot.log"; then
  echo "--- 启动日志 ---" >&2
  grep -E "must declare output|unsupported JSON schema|failed to apply|ClientPackageCompositionError" "$LOG_DIR/boot.log" >&2
  fail "插件加载/注册失败"
fi
ok "无工具契约错误、无客户端包合成错误"

# --- 5. routes --------------------------------------------------------------
step "5/6 宿主路由行为"

# expect <label> <expected status> <curl args...>
expect() {
  local label="$1" want="$2"
  shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$@" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    ok "$label → $got"
  else
    fail "$label：期望 $want，实际 $got"
  fi
}

BASE="http://127.0.0.1:$PORT"
UNKNOWN="session-00000000-0000-4000-8000-00000000ffff"

# The sample session id must be well formed or the route answers 400 first.
expect "GET $ROUTE/state 缺 sessionId"        400 "$BASE$ROUTE/state"
expect "GET $ROUTE/state 会话不存在"          404 "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "GET $ROUTE/state 合法但未知的 id"     404 "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "POST $ROUTE/apply 方法错误(GET)"      405 "$BASE$ROUTE/apply"
expect "POST $ROUTE/apply 坏 JSON"            400 -X POST -H 'content-type: application/json' --data '{nope' "$BASE$ROUTE/apply"
expect "POST $ROUTE/apply 空文本"             400 -X POST -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$UNKNOWN\",\"seq\":2,\"text\":\"  \"}" "$BASE$ROUTE/apply"
expect "跨源 Origin 被拒"                     403 -H "Origin: http://evil.test" "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "伪造 Host 被拒"                       403 -H "Host: evil.test" "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "回环 Host 通过守卫"                   404 -H "Host: 127.0.0.1" "$BASE$ROUTE/state?sessionId=$UNKNOWN"

# The 404 above is the point: the route answered through this plugin's own code
# path rather than 404-ing at the server, which proves the handler is mounted.
ok "宿主半部已挂载并走通自己的会话查询与守卫"

# --- 6. teardown ------------------------------------------------------------
step "6/6 清理"
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
PID=""
ok "沙箱实例已停止（只按 pid，未使用任何宽泛匹配）"

echo
echo "插件已在真实 DSH profile 中通过加载与路由验证。"
