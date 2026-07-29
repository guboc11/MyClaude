# my-dot-claude 관리 대상 목록 — install.sh / update.sh 가 공유하는 단일 원천.
# 경로는 ~/.claude/ 기준 상대경로. 폴더는 통째로, 파일은 그 파일만.

TARGETS=(
  "CLAUDE.md"
  "settings.json"
  "skills"
  "tools"
)

# skills 중 수집하지 않는 것 — 외부에서 받은 사본과 codex 전용 심볼릭 링크.
# 자작이 아닌 스킬을 새로 설치하면 여기에 한 줄 추가한다.
SKILL_EXCLUDES=(
  "refactoring-ui"
  "supabase"
  "supabase-postgres-best-practices"
  "sui-dev-skills"
  "vercel-react-best-practices"
  "vercel-react-native-skills"
  "web-design-guidelines"
)
