# 네이버 블로그 AI 자동화 시스템

개인용 네이버 블로그 자동 작성/발행 시스템. 단계적으로 개발한다.

## 프로젝트 구조

```
naver_blog/
├── extension/   Chrome Extension (Manifest V3) — 네이버 에디터 자동 제어 + 데스크톱 앱 브리지
├── desktop/     Electron 데스크톱 앱(.exe) — 예약 자동발행 컨트롤 패널 (판매용, 현재 주력)
├── web/         Next.js 관리자 뼈대 (보류 — 데스크톱 앱으로 방향 전환)
└── README.md
```

> **방향 전환 (2026-09):** 웹 대신 **판매용 Windows 데스크톱 앱(.exe)** 으로 운영한다.
> exe(Electron)는 글 작성·예약·상태 관리 컨트롤 패널이고, 실제 발행은 기존 Chrome 확장이
> 사용자의 네이버 로그인 세션으로 수행한다. 둘은 로컬 WebSocket(`ws://127.0.0.1:8765`)으로 통신.
> 자세한 내용과 실행법은 `desktop/README.md` 참고.

## 현재 진행 상황

- ✅ **Phase 1 완료**: 에디터 감지 + 제목/본문 자동 입력 (빌드 #5)
- ✅ **Phase 2 완료**: 이미지 삽입 + 순서 배치 (빌드 #7~#8)
- ✅ **Phase 3 완료**: Block Engine — text/heading(소제목)/image/quote/divider(전체폭) 임의 순서 삽입 (빌드 #9~#15)
- ✅ **Phase 4a 완료**: Next.js 웹 관리자 뼈대 (보류)
- ✅ **확장 빌드 #35**: 데스크톱 앱 브리지 — 로컬 WebSocket으로 예약 발행 작업 수신 → RabbitWrite 발행
- ✅ **데스크톱 앱 v1**: Electron 앱 — 글 작성(소제목/본문/인용구/구분선) + 예약 큐 + 스케줄러 + 상태 대시보드
- ▶ **다음:** 이미지 발행 → 다계정 → 라이선스/자동업데이트 → AI 글 생성(Gemini) 연동

### Web Admin 실행 (Phase 4a)

```bash
cd web
npm install   # 최초 1회
npm run dev
```

- 브라우저에서 `http://localhost:3000` 접속
- 주제/키워드 입력 → [글 생성] → 미리보기 확인 → [JSON 복사]
- 복사한 JSON을 Extension 팝업의 "Block Engine JSON"에 붙여 발행 (자동 발행 연결은 Phase 6에서)
- AI 글 생성은 현재 로컬 스텁(`web/lib/blocks.ts`), Phase 7에서 무료 **Gemini API**로 교체 예정

> 핵심 기술: 스마트에디터 ONE은 `input_buffer` iframe으로 실제 키 입력만 받으므로,
> `chrome.debugger`(Input.insertText / DOM.setFileInputFiles)로 진짜 입력을 전달한다.
> 합성 이벤트/execCommand/DOM 조작은 무시된다.

---

## Phase 1 — Extension 설치 및 테스트 방법

> ⚠️ Phase 1은 빌드 도구 없이 바로 실행 가능하도록 순수 JavaScript로 작성했습니다.
> (TypeScript 전환은 POC 검증 완료 후 진행)

### 1. 확장 프로그램 로드

1. Chrome 주소창에 `chrome://extensions` 입력 후 이동
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `naver_blog/extension` 폴더 선택

### 2. 테스트

1. Chrome에서 **네이버 로그인** (기존 세션 사용)
2. 본인 블로그 **글쓰기 페이지** 열기
   - 예: `https://blog.naver.com/[본인아이디]?Redirect=Write`
   - 또는 블로그 관리 → 글쓰기
3. 에디터(스마트에디터 ONE)가 완전히 로딩될 때까지 대기
4. 브라우저 우측 상단 확장 프로그램 아이콘(퍼즐) → **네이버 블로그 자동 입력** 클릭
5. 팝업에서:
   - **DOM 진단** : 에디터 selector가 제대로 잡히는지 먼저 확인
   - **자동 입력** : 제목/본문 자동 입력 실행
6. 실행 결과는 팝업 하단과 페이지 콘솔(F12 → Console, `[네이버자동입력]` 로그)에서 확인

### ⚠️ 자동 입력 시 주의 (빌드 #5부터)

스마트에디터 ONE은 숨겨진 `input_buffer` iframe으로 **실제 키 입력만** 받으므로,
`chrome.debugger` API로 진짜 키 입력을 보낸다. 이 때문에:

- **F12 개발자도구를 닫은 상태**에서 [자동 입력]을 눌러야 한다. (열려 있으면 디버거 연결 실패)
- 실행 중 상단에 **"확장 프로그램이 브라우저를 디버깅하고 있습니다"** 노란 알림바가 뜨는 것은 정상이다. 입력이 끝나면 자동으로 사라진다.
- 입력 위치 지정을 위해 페이지에 포커스가 가면서 팝업이 닫힐 수 있다. → 팝업을 **다시 열면** 마지막 결과가 표시된다.

### 3. selector가 맞지 않을 때

네이버 에디터 DOM은 수시로 바뀝니다. **DOM 진단** 결과에서 `❌ 없음`이 나오면:

1. 글쓰기 페이지에서 F12 → 콘솔에 `[네이버자동입력]` 로그로 실제 프레임 확인
2. 제목/본문 영역을 우클릭 → 검사(Inspect)하여 실제 class 확인
3. `extension/content.js` 상단의 `SELECTORS` 객체에 후보 selector 추가
4. `chrome://extensions`에서 확장 프로그램 **새로고침(↻)** 후 재시도

### 테스트 데이터 (기본값)

```
제목: 자동화 테스트 글
본문: 이 글은 네이버 블로그 자동 입력 기능을 테스트하기 위한 글입니다.
```

---

## 설계 원칙 (요약)

- 에디터 로딩 완료 후 입력 (감지 → 대기 → 입력 → 검증). 무한 polling 금지, timeout/retry 사용.
- selector는 `content.js`의 `SELECTORS`에서 일괄 관리.
- Naver ID/비밀번호를 저장하지 않고, 기존 로그인 세션을 활용.
- CAPTCHA/봇 탐지 우회 기능은 구현하지 않음.
- 모든 자동화 단계에 로그를 남김.
