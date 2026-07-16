# 릴리스 가이드

## 사전 조건

- GitHub 저장소: `codestepteam/next-dev-feedback`
- npm package: `@tallpizza/next-dev-feedback`
- npm 사용자 `tallpizza`와 `@tallpizza` scope package publish 권한
- Node.js `>=20.9.0`

GitHub 저장소 권한과 npm 사용자 scope 권한은 별개입니다. 배포 전
`npm whoami`가 `tallpizza`인지 확인하세요.

## 로컬 검증

```bash
npm clean-install
npm run verify
npm run pack:check
```

`pack:check`는 build 결과와 CSS, 타입 선언, CLI를 확인하고 `src`, `tests`,
`scripts`, `.feedback` 같은 개발 파일이 tarball에 들어가지 않았는지 검사합니다.

실제 tarball도 설치해 확인합니다.

```bash
npm pack
npm install /absolute/path/tallpizza-next-dev-feedback-0.1.0-beta.0.tgz
```

검증용 Next.js App Router 프로젝트에서 다음 항목을 확인하세요.

1. `next dev`에서 버튼, 선택, metadata-only 저장
2. 32MB 설정에서 전체/선택 PNG 저장
3. `.feedback/README.md`, `summary.json`, `metadata.json` 구조
4. `next build`와 `next start`에서 버튼과 저장 동작이 없음
5. tarball 설치 후 TypeScript 타입과 CSS가 정상 해석됨
6. `npx @tallpizza/next-dev-feedback init --check` 통과

## beta 배포

버전과 변경 사항을 검토한 뒤 beta dist-tag로 공개합니다.

```bash
npm publish --access public --tag beta
```

배포 확인:

```bash
npm view @tallpizza/next-dev-feedback@beta version
npm view @tallpizza/next-dev-feedback@beta dist.tarball
```

일반 설치 예시는 beta 기간 동안 명시적인 tag를 사용할 수 있습니다.

```bash
npm install @tallpizza/next-dev-feedback@beta
```

## stable 배포

consumer fixture, 개발 캡처, 운영 비활성화와 npm tarball 검증이 모두 통과한
뒤 stable 버전을 올리고 `latest` tag로 게시합니다.

```bash
npm version 0.1.0
npm publish --access public
```

태그와 GitHub release는 package version과 일치시킵니다. 토큰 기반 수동 배포를
계속 사용하기보다 npm Trusted Publishing과 GitHub Actions OIDC를 구성하는 것을
권장합니다. provenance 사용 여부도 배포 워크플로에서 명시적으로 검증하세요.

이 저장소의 `.github/workflows/publish.yml`은 GitHub Release가 게시될 때 OIDC로
`npm publish --provenance`를 실행합니다. 사용하기 전에 npm package 설정의
Trusted Publisher에 GitHub 조직 `codestepteam`, 저장소 `next-dev-feedback`,
워크플로 파일 `publish.yml`을 등록해야 합니다. npm package가 아직 만들어지지
않았거나 Trusted Publisher를 등록하지 않았다면 먼저 위의 수동 beta 배포로
package를 생성하세요.

## 배포 금지 항목

- 실제 `.feedback/` 기록과 스크린샷
- 예제 앱의 세션, 환경변수, 로컬 경로
- npm token과 GitHub token
- 소비 프로젝트 전용 샘플 화면
- 생성된 tarball과 임시 consumer fixture
