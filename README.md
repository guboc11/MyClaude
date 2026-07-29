# my-dot-claude

`~/.claude/` 글로벌 영역에서 **내가 만든 것만** 골라 버전 관리하는 레포.
Claude Code 행동 규칙(CLAUDE.md), 자작 스킬, 자작 MCP 서버 6종, 설정(훅 포함)을 담는다.
대화 기록·시크릿·캐시 같은 머신 상태는 처음부터 범위 밖이다.

## 구조

```
claude/          ~/.claude/ 의 미러 (관리 대상만)
  CLAUDE.md      글로벌 행동 규칙
  settings.json  권한·환경·글로벌 훅 배선 (소유자 취향 포함)
  skills/        자작 스킬
  tools/         자작 MCP 서버 — {이름}-mcp/ 폴더 하나가 서버 하나
manifest.sh      관리 대상 목록 (두 스크립트의 단일 원천)
install.sh       레포 → 홈 설치
update.sh        홈 → 레포 수집
LEGACY/          은퇴한 스킬·자료 보관
```

## 설치 (새 기기 · 타인)

```sh
git clone https://github.com/guboc11/my-dot-claude
cd my-dot-claude
./install.sh --dry-run   # 무엇이 복사·등록되는지 먼저 확인
./install.sh
```

- 홈의 다른 파일은 지우지 않고, 덮어쓰는 파일은 `~/.claude/.install-backup/`에 백업된다.
- MCP 등록은 `claude/tools/`의 `{이름}-mcp` 폴더에서 자동 유도해 user 스코프로 추가한다.
- `settings.json`에는 소유자 취향(모델·음성 등)이 들어 있다 — 원치 않으면
  `manifest.sh`의 `TARGETS`에서 빼고 설치하면 된다.
- 설치 후 Claude Code 재시작 필요.

## 평소 흐름 (소유자)

1. `~/.claude/`에서 그냥 작업한다 (스킬 추가, 도구 수정, 규칙 갱신).
2. `./update.sh` — 관리 대상만 레포로 수집된다 (`--dry-run`으로 미리보기 가능).
3. `git diff`로 확인하고 커밋·푸시한다. 스크립트는 절대 커밋하지 않는다.

- 홈에서 지운 파일은 수집 때 레포에서도 지워진다(미러). 삭제 확정은 커밋이 한다.
- 외부에서 받은 스킬은 수집하지 않는다 — 새로 받으면 `manifest.sh`의
  `SKILL_EXCLUDES`에 이름을 추가한다.

## 자작 MCP 6종

| 이름 | 역할 |
|---|---|
| task | 태스크 장부 (TUI에서 쓰는 할 일 관리) |
| server | 로컬 개발 서버 세트 오케스트레이션 |
| onboarding | 규칙 문서 조항 조회 (규칙 리모컨) |
| prototype | 프로토타입 시안 생명주기 |
| notepad | 사람용 메모장 — 적을 때 해석하지 않는다 |
| reminder | 세션별 리마인드 주입 (글로벌 UserPromptSubmit 훅과 한 쌍) |

서버는 전부 무의존성 Node 단일 파일이고, 저장은 실행 시점의 프로젝트
`.claude/` 아래에 한다 — 코드 한 벌로 모든 프로젝트에서 동작한다.
