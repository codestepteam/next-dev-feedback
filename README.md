# @tallpizza/next-dev-feedback

Next.js App Router 개발 서버에서 화면의 DOM 요소를 선택하고 UI 개선 요청을
프로젝트의 `.feedback/` 폴더에 저장하는 개발 전용 도구입니다.

- 별도의 `app/api/dev-feedback/route.ts`를 만들지 않습니다.
- 브라우저 캡처는 Client Component, 파일 저장은 Server Action이 담당합니다.
- 입력 항목은 **사용자 요청** 하나뿐입니다. 제목과 Codex용 `request.md`는
  생성하지 않습니다.
- 에이전트가 먼저 읽을 작은 `summary.json`과 필요할 때만 읽는
  `metadata.json`을 분리합니다.
- 운영 환경에서는 UI, 이벤트 리스너, 저장 동작이 모두 비활성화됩니다.

> 현재 버전은 `0.1.0-beta.0`입니다. Next.js `16.2.x` App Router를 기준으로
> 먼저 검증하고 있습니다.

## 요구사항

- Next.js `>=16.2.0 <17`
- React와 React DOM `>=19.2.0 <20`
- Node.js `>=20.9.0`
- App Router
- Node.js Runtime과 쓰기 가능한 로컬 파일 시스템

Edge Runtime은 Node 파일 시스템 API를 제공하지 않으므로 지원하지 않습니다.

### 포함 의존성

- `html2canvas-pro`: 개발 브라우저에서 viewport와 선택 영역 PNG를 생성합니다.
- `server-only`: 실제 개발 엔트리를 Server Component 전용으로 표시해 Client
  Component에서 잘못 가져오는 경우를 빌드 시점에 막습니다.

두 모듈은 설치 의존성이지만 운영 모드는 의존성이 없는 `noop.js`를 선택하므로
운영 번들 그래프에는 들어가지 않습니다.

## 빠른 설치

```bash
npm install @tallpizza/next-dev-feedback
npx @tallpizza/next-dev-feedback init
```

CLI는 프로젝트 구조를 확인한 뒤 다음 변경을 제안합니다.

1. 루트 레이아웃에 `<DevFeedbackCapture />` 추가
2. `.gitignore`에 `.feedback/` 추가
3. 전체 스크린샷을 전송할 수 있도록 개발 서버의 Server Action 요청 한도를
   `32mb`로 설정

기존 설정을 덮어쓰지 않으며, 자동 변경이 안전하지 않은 구조에서는 적용할
코드를 안내합니다. 먼저 결과만 확인하려면 다음 명령을 사용하세요.

```bash
npx @tallpizza/next-dev-feedback init --dry-run
```

### CLI 옵션

```text
next-dev-feedback init [options]

--dry-run                 파일을 변경하지 않고 예정된 변경 표시
--check                   파일을 변경하지 않고 설치 상태 점검
--yes                     대화형 확인에 기본값 사용
--metadata-only           스크린샷 없이 JSON만 저장하도록 레이아웃 구성
--body-size-limit <size>  Server Action 한도 지정 (기본값: 32mb)
--no-layout               루트 레이아웃을 변경하지 않음
--no-config               next.config.*를 변경하지 않음
--no-gitignore            .gitignore를 변경하지 않음
```

`--metadata-only`는 레이아웃에 `<DevFeedbackCapture metadataOnly />`를 추가하고
요청 크기 설정은 변경하지 않습니다. 기존 앱에서 설정 파일을 직접 관리하려면
`--no-config`, 레이아웃 적용 코드를 직접 넣으려면 `--no-layout`을 사용하세요.

## 수동 설치

App Router의 루트 레이아웃에 서버 엔트리 하나를 추가합니다.

```tsx
import { DevFeedbackCapture } from "@tallpizza/next-dev-feedback";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        {process.env.NODE_ENV === "development" ? (
          <DevFeedbackCapture />
        ) : null}
      </body>
    </html>
  );
}
```

패키지 내부에서도 개발 환경을 확인하지만, 레이아웃 조건을 함께 두면 의도가
명확하고 운영 렌더 경로에서 컴포넌트 호출을 피할 수 있습니다.

스크린샷을 저장하려면 `next.config.ts`에서 **개발 서버에만** Server Action
요청 한도를 올립니다.

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental:
    process.env.NODE_ENV === "development"
      ? {
          serverActions: {
            bodySizeLimit: "32mb",
          },
        }
      : undefined,
};

export default nextConfig;
```

이미 `experimental` 또는 `serverActions` 설정이 있다면 기존 값을 유지하면서
`bodySizeLimit`만 병합하세요.

설정을 바꾸고 싶지 않으면 스크린샷을 보내지 않는 모드를 사용합니다.

```tsx
<DevFeedbackCapture metadataOnly />
```

## 왜 32MB 설정이 필요한가요?

Next.js Server Action 요청 본문 기본 한도는 1MB입니다. 전체 viewport와 선택
영역을 Base64 PNG 두 장으로 보내면 이 값을 넘을 수 있습니다. 패키지는 자체적으로
전체 요청 30MB, 개별 PNG 10MB 제한과 PNG 구조 검증을 적용하지만, 그 검증에
도달하기 전에 Next.js가 요청을 거절하지 않도록 약간의 여유를 둔 32MB가
필요합니다.

`bodySizeLimit`은 해당 개발 서버의 **모든 Server Action에 적용되는 전역
설정**입니다. 큰 요청은 메모리와 CPU 사용량, 서비스 거부 공격 표면을 늘릴 수
있습니다. 따라서 이 저장 도구는 개발 환경에서만 사용하고, 운영 빌드에는 이
설정을 적용하지 마세요. 이 전역 변경을 원하지 않는 프로젝트에는
`--metadata-only`를 권장합니다.

## 사용 방법

1. 개발 서버를 실행하고 대상 페이지를 엽니다.
2. 오른쪽 아래 **UI 피드백** 버튼을 누릅니다.
3. 마우스로 요소를 가리켜 하이라이트와 selector를 확인합니다.
4. 요소를 클릭하고 개선 요청을 입력합니다.
5. **저장**을 누릅니다.

선택 모드는 `Esc`로 취소할 수 있습니다. 저장에 성공하면 생성된 상대 경로가
패널에 표시됩니다. 스크린샷만 실패한 경우에도 텍스트 메타데이터는 저장할 수
있습니다.

## 저장 구조

```text
.feedback/
  README.md
  2026-07-15-001/
    summary.json
    metadata.json
    screenshot-full.png       # 캡처 성공 시
    screenshot-target.png     # 캡처 성공 시
```

`.feedback/README.md`는 디렉터리가 처음 만들어질 때 생성되며 기존 파일을
덮어쓰지 않습니다. `.feedback/`은 기본적으로 Git에서 제외됩니다. 팀이 기록을
버전 관리하려면 `.gitignore`에서 해당 한 줄을 제거하세요.

### 에이전트가 읽는 순서

대부분의 수정은 `summary.json`만으로 시작할 수 있습니다.

```json
{
  "request": "이 셀의 텍스트를 가운데 정렬해 주세요.",
  "source": {
    "componentName": "OrdersTable",
    "filePath": "src/components/orders-table.tsx",
    "lineNumber": 48,
    "columnNumber": 5
  },
  "page": {
    "url": "http://localhost:3000/orders?status=pending",
    "pathname": "/orders"
  },
  "target": {
    "selector": "[data-testid=\"order-date\"]",
    "tagName": "td",
    "textContent": "2026-07-15"
  },
  "detailFile": "metadata.json",
  "screenshots": {
    "full": "screenshot-full.png",
    "target": "screenshot-target.png"
  }
}
```

권장 순서는 다음과 같습니다.

1. 최신 캡처 폴더의 `summary.json`에서 `request`, `source`, `page`, `target` 확인
2. 관련 컴포넌트와 스타일 탐색
3. 정확한 DOM HTML, 속성, 좌표나 브라우저 상태가 필요할 때만
   `metadata.json` 확인
4. 시각적 문맥이 필요할 때만 PNG 확인

Codex 실행 예시:

```bash
codex "Read the newest .feedback/*/summary.json first and implement its request. Open metadata.json and screenshots only when the summary is insufficient."
```

`metadata.json`에는 viewport, 스크롤, user agent, 대상의 bounding rect,
선별된 attributes, 최대 2,000자의 `textContent`, 최대 20,000자의 정제된
`outerHTML`이 포함됩니다. 별도 제목이나 수정 프롬프트는 저장하지 않습니다.

## selector와 소스 위치 힌트

data 속성이 전혀 없어도 사용할 수 있습니다. selector는 고유한 `id`, 기존
`data-testid`, `data-component`, 안정적인 class 조합, 부모 계층, 필요한 경우
`nth-of-type` 순서로 만들어지고 실제로 선택한 요소를 가리키는지 확인됩니다.

소스 파일을 더 빨리 찾고 싶다면 주요 컴포넌트의 DOM 루트에만 다음 힌트를
선택적으로 추가하세요.

```tsx
<section
  data-component="OrdersTable"
  data-source-file="src/components/orders-table.tsx"
  data-source-line="48"
  data-source-column="5"
>
  {/* ... */}
</section>
```

선택한 하위 요소에 힌트가 없으면 부모 방향으로 최대 10단계를 탐색합니다.
모든 요소에 data 속성을 추가할 필요가 없습니다. `data-testid`도 프로젝트가
이미 테스트 식별자로 사용할 때만 재사용하면 됩니다.

`data-source-file`에는 프로젝트 기준 상대 경로만 사용하세요. 서버 절대 경로,
`..`, 사용자 정보, 토큰 같은 민감한 값을 data 속성에 넣지 마세요. React Fiber
내부 속성은 안정적인 공개 API가 아니므로 소스 추적의 기본 방식으로 사용하지
않습니다.

## 보안과 개인정보 보호

도구는 다음 데이터를 수집하거나 저장하지 않습니다.

- 쿠키, Authorization 헤더, 인증 토큰과 세션 정보
- `localStorage`와 `sessionStorage`
- `input`과 `textarea`의 현재 `value`
- password 및 password 관련 `autocomplete` 값

저장 전 복제한 HTML에서 폼 값, 실행 가능한 스크립트, 민감한 URL 파라미터를
제거하거나 마스킹합니다. URL, HTML과 속성은 서버에서 다시 검증하며 파일 경로와
Base64 PNG도 제한합니다.

단, 화면에 이미 표시된 개인정보는 **스크린샷 픽셀에 포함될 수 있습니다**.
민감한 개발 데이터가 렌더링된 화면에서는 캡처하지 마세요. 개발 서버를 외부
네트워크에 공개하는 것도 권장하지 않습니다.

Server Action은 사용자에게 보이는 Route Handler 파일이 없을 뿐, 내부적으로는
POST 요청으로 호출되는 서버 진입점입니다. 패키지는 모든 입력을 신뢰하지 않고
검증하며 개발 환경이 아니면 저장하지 않습니다.

## 스크린샷 제약

`html2canvas-pro`는 화면을 녹화하는 것이 아니라 DOM과 CSS를 다시 그립니다.
다음 항목은 실제 브라우저 표시와 다르거나 캡처에서 제외될 수 있습니다.

- CORS가 허용되지 않은 외부 이미지와 폰트
- `iframe` 내용
- 비디오, WebGL, 기존 canvas와 일부 CSS 필터
- 매우 큰 viewport나 복잡한 DOM

전체 이미지는 현재 viewport 기준입니다. 선택 이미지는 요소 주변 여백을 포함해
viewport 경계 안에서 잘립니다. 화면 밖 요소 부분은 캡처할 수 없습니다.

## 운영 환경과 배포 제약

- Next.js 개발 모드는 package의 `development` export로 실제 캡처 엔트리를 불러옵니다.
- 운영 모드와 일반 Node.js 모듈 해석은 의존성이 없는 no-op export를 선택합니다.
- 따라서 개발용 Client Component, CSS, `html2canvas-pro`, 저장 Action이 운영 모듈 그래프에 진입하지 않습니다.
- 운영 환경에서는 버튼을 렌더링하거나 전역 이벤트 리스너를 등록하지 않습니다.
- 저장 Action도 개발 환경을 다시 확인하고 운영 요청을 거절합니다.
- CLI가 추가하는 32MB 설정은 개발 서버에만 적용되어야 합니다.

파일 저장은 `process.cwd()` 아래 `.feedback/`을 사용하는 Node.js 전용 기능입니다.
Edge Runtime과 읽기 전용 또는 일시적 파일 시스템에서는 사용할 수 없습니다.
이 패키지는 배포 환경의 피드백 수집 서비스가 아니라 로컬 개발 도구입니다.

## 공개 엔트리

```ts
import { DevFeedbackCapture } from "@tallpizza/next-dev-feedback";
import type {
  DevFeedbackMetadata,
  DevFeedbackSummary,
} from "@tallpizza/next-dev-feedback/types";
```

내부 client/server 모듈은 공개 export가 아닙니다. package는 ESM이며 TypeScript
선언 파일과 CSS Module을 함께 배포합니다.

## 개발과 검증

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
npm run pack:check
```

빌드는 코드를 번들링하지 않고 `tsc`로 ESM과 선언 파일을 출력합니다. 별도
스크립트가 CSS를 같은 상대 경로로 복사하고 `"use client"` 및 `"use server"`
지시어가 결과물 첫 문장에 보존됐는지 검사합니다. `pack:check`는 npm tarball에
허용된 배포 파일만 포함됐는지 확인합니다.

구조와 릴리스 절차는 [아키텍처](./docs/architecture.md)와
[릴리스 가이드](./docs/releasing.md)를 참고하세요.

## 라이선스

[MIT](./LICENSE)
