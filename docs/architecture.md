# 아키텍처

## 실행 경계

`@codestepteam/next-dev-feedback`는 한 가지 공개 컴포넌트 뒤에서 브라우저와
서버 책임을 분리합니다.

```text
RootLayout (Server Component)
  └─ DevFeedbackCapture (`development` 조건부 export)
      └─ DevFeedbackCaptureClient (DOM 선택과 캡처)
          └─ saveFeedbackAction (검증과 로컬 파일 저장)
```

- Next.js 개발 빌드는 `development` export로 실제 Server Component를 해석합니다.
- 운영 빌드와 기본 모듈 해석은 의존성이 없는 `noop.js`를 선택합니다.
- 개발 엔트리는 `server-only`로 표시해 Client Component의 잘못된 import를 빌드 시점에 막습니다.
- Client Component만 DOM, pointer, keyboard, canvas API에 접근합니다.
- Server Action은 신뢰하지 않는 입력을 다시 검증하고 `.feedback/`만 씁니다.
- 소비 프로젝트에는 Route Handler가 필요하지 않습니다.

Server Action도 Next.js가 생성하는 POST 진입점을 통해 호출됩니다. 따라서
"route 없음"은 소비 앱이 별도 API 파일과 응답 프로토콜을 유지할 필요가 없다는
뜻이지 네트워크 요청이나 공격 표면이 사라진다는 뜻은 아닙니다.

## 패키지 출력

소스는 번들링하지 않고 NodeNext ESM으로 컴파일합니다. 파일 경계를 유지해야
Next.js가 `"use client"`와 `"use server"`를 올바르게 해석할 수 있고,
`html2canvas-pro`도 캡처 기능이 실제로 활성화될 때만 로드할 수 있습니다.

```text
src/                         dist/
  index.ts                     index.js + index.d.ts (개발 전용)
  noop.tsx                     noop.js (운영/기본 엔트리)
  client/*.tsx                 client/*.js + *.d.ts
  client/*.css        ->       client/*.css
  shared/*.ts                  shared/*.js + *.d.ts
  server/*.ts                  server/*.js + *.d.ts
  cli/*.ts                     cli/*.js + *.d.ts
```

`scripts/verify-directives.mjs`는 소스에서 client/server 지시어를 가진 모든
파일을 찾아 컴파일 결과의 첫 문장에 같은 지시어가 남았는지 검사합니다.
`sideEffects`에는 CSS가 명시되어 소비 앱의 최적화 과정에서 스타일이 제거되지
않습니다.

`scripts/verify-dist.mjs`는 모든 `exports`, `main`, `types`, `bin` 대상과 CSS,
운영 no-op의 의존성 격리, 소스가 내장된 source map을 검사합니다.
이 검사는 `build`와 `prepack`에서 모두 실행되며, `prepack`은
실제 tarball allowlist도 함께 검사합니다.

공개 export는 다음 세 개로 제한합니다.

- `.`: `DevFeedbackCapture`
- `./types`: 공개 메타데이터 타입
- `./package.json`: 패키지 정보

client, server, persistence 구현은 호환성을 보장하지 않는 내부 모듈입니다.

## 저장 트랜잭션

저장 단계는 다음 불변 조건을 지킵니다.

1. 개발 환경과 요청 크기 확인
2. 제출 구조, URL, selector, 소스 힌트와 PNG 검증
3. `.feedback/` 경로와 symlink 경계 확인
4. 임시 디렉터리에 JSON과 선택적 이미지 작성
5. 완성된 날짜-순번 디렉터리로 원자적 이동
6. 브라우저에는 상대 경로와 안전한 오류만 반환

`.feedback/README.md`는 최초 생성 시에만 쓰고 기존 내용을 덮어쓰지 않습니다.
동시 저장은 디렉터리 예약 단계에서 충돌하지 않는 당일 순번을 선택합니다.

## 작은 요약과 상세 메타데이터

`summary.json`은 에이전트의 기본 진입점입니다. 요청, 선택적 소스 힌트,
페이지 URL/pathname, selector와 짧은 텍스트만 포함합니다. `metadata.json`은
viewport, 스크롤, 전체 rect, 선별 속성, 길이가 제한된 HTML 같은 디버깅
정보를 별도로 보관합니다.

이 분리는 에이전트가 매번 긴 `outerHTML`과 브라우저 정보를 컨텍스트에 넣지
않도록 하기 위한 것입니다. 상세 파일과 이미지는 요약만으로 수정 위치를 찾기
어려울 때 열어야 합니다.

## Server Action 요청 크기

Next.js 기본 한도 1MB는 Base64 PNG 두 장에 부족합니다. 기본 CLI는 개발
환경의 `experimental.serverActions.bodySizeLimit`을 32MB로 설정합니다.
패키지 자체 한도는 더 낮게 유지해 Next.js 전역 한도를 저장 유효성 검증으로
사용하지 않습니다.

설정 변경을 원하지 않으면 metadata-only 모드가 이미지를 생성하거나 전송하지
않습니다. 이 모드는 기본 1MB 안에서 동작하도록 텍스트 필드 길이도 제한합니다.

## 지원하지 않는 환경

- Pages Router 전용 앱
- Edge Runtime
- 운영 환경 피드백 수집
- 읽기 전용 또는 영속성이 없는 파일 시스템
- iframe 내부 DOM 선택과 캡처

향후 원격 스토리지가 필요해지면 저장 인터페이스를 별도 transport로 추상화할
수 있지만, 현재 패키지는 개발용 로컬 파일 저장만 지원합니다.
