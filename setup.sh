#!/bin/bash
# macOS 팝업 번역기 — 설치 스크립트

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.user.translator"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "🌐 macOS 팝업 번역기 설치"
echo "========================="

# 1. Python 의존성 설치
echo ""
echo "[1/3] pynput 설치 중…"
pip3 install pynput --quiet

# 2. Claude CLI 확인
echo "[2/3] Claude CLI 확인…"
if ! command -v claude &> /dev/null; then
    echo "❌ Claude CLI가 설치되어 있지 않습니다."
    echo "   npm install -g @anthropic-ai/claude-code 으로 설치하세요."
    exit 1
fi
echo "   ✓ Claude CLI 확인됨: $(which claude)"

# 3. LaunchAgent 등록 (로그인 시 자동 실행)
echo "[3/3] LaunchAgent 등록…"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which python3)</string>
        <string>${SCRIPT_DIR}/translator.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/translator.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/translator.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.local/bin</string>
    </dict>
</dict>
</plist>
EOF

echo "   ✓ ${PLIST_PATH}"

echo ""
echo "========================="
echo "✅ 설치 완료!"
echo ""
echo "▶ 지금 실행:     python3 ${SCRIPT_DIR}/translator.py"
echo "▶ 자동실행 등록: launchctl load ${PLIST_PATH}"
echo "▶ 자동실행 해제: launchctl unload ${PLIST_PATH}"
echo ""
echo "⚠️  처음 실행 시 macOS 접근성 권한을 허용해 주세요."
echo "   시스템 설정 → 개인정보 보호 및 보안 → 접근성 → 터미널 체크"
