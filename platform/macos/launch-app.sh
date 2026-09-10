#!/bin/sh
set -eu
RESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
HOME_ROOT="$HOME/Library/Application Support/TeamDevSpace"
ROOT="$HOME_ROOT/distribution"
LOG_DIR="$HOME_ROOT/logs"
LOG="$LOG_DIR/setup.log"
/bin/mkdir -p "$LOG_DIR"
/bin/chmod 700 "$LOG_DIR" 2>/dev/null || true
: > "$LOG"
/bin/chmod 600 "$LOG" 2>/dev/null || true
if ! "$RESOURCES/bootstrap.sh" --root "$ROOT" --manifest "$RESOURCES/release-manifest.json" --setup gui >> "$LOG" 2>&1; then
  /usr/bin/osascript -e 'display alert "Team DevSpace 启动失败" message "本地程序启动失败。详情见 ~/Library/Application Support/TeamDevSpace/logs/setup.log。" as critical' >/dev/null 2>&1 || true
  exit 1
fi
if [ -f "$HOME_ROOT/state.json" ] && /usr/bin/grep -q '"bindingId"[[:space:]]*:' "$HOME_ROOT/state.json"; then
  /usr/bin/osascript -e 'display notification "Enrollment 和登录启动项已配置完成。" with title "Team DevSpace"' >/dev/null 2>&1 || true
else
  /usr/bin/osascript -e 'display alert "Team DevSpace 设置未完成" message "程序已安装并保留在菜单栏。请点击 Team DevSpace 图标，选择“完成设置…”重新输入 Access Key；项目目录会继续保留。" as warning' >/dev/null 2>&1 || true
fi
