# extract-api-spec v2 통합 설계안

## 1) 목표
- **v2의 분석 정확도**(정규화, 필드 스키마 추론, required/optional 통계)를 유지한다.
- **v1의 실무 사용성**(CLI 필터, 한국어 보고서 4시트, 시나리오 비교)을 흡수한다.
- 단일 명령으로 **팀 공유용 Excel + 기계처리용 JSON**을 동시에 생성한다.

---

## 2) 설계 원칙
1. **입력은 느슨하게, 출력은 일관되게**
   - 로그 구조가 달라도 request/response 공통 레코드로 정규화한다.
2. **변동값 노이즈 최소화**
   - timestamp/cacheBust 등 불안정 query key는 기본 제외한다.
3. **가시성과 검증 가능성**
   - 요약 시트 + 상세 시트 + 샘플 시트를 분리해 검토 흐름을 단순화한다.
4. **하위 호환 우선**
   - 기존 v1 옵션/출력 습관을 최대한 유지하며 v2 기능을 증분 반영한다.

---

## 3) 사용자 관점 기능 요구사항

### 3.1 CLI
- `--file <path>`: 단일 로그 파일 처리
- `--all`: 로그 디렉터리 전체 처리
- `--env <prod|stg>`: 파일명 또는 로그 메타 기준 환경 필터
- `--auth <guest|login>`: 인증 모드 필터
- `--out <path>`: Excel 출력 경로
- `--json-out <path>`: JSON 출력 경로 (미지정 시 Excel 파일명 기반)
- `--exclude-query <k1,k2,...>`: 제외할 query key 추가
- `--strict-pairing`: request-response 매칭 실패 항목을 경고/별도 시트로 기록

### 3.2 출력물
- Excel (한국어 중심)
  1. `API 명세`
  2. `파라미터 상세`
  3. `시나리오 비교`
  4. `요청·응답 샘플`
  5. `품질 경고` (신규)
- JSON
  - endpoint별 통합 스펙(요약 + 필드 매트릭스 + 샘플)

---

## 4) 아키텍처

```text
[Log Loader]
   -> [Normalizer]
      -> [Aggregator]
         -> [Scenario Matcher]
            -> [Workbook Builder]
            -> [JSON Builder]
```

### 4.1 모듈 구조 제안
- `src/cli.js`: 인자 파싱, 옵션 유효성 검사
- `src/loaders/log-loader.js`: 파일 선택/로딩/기본 필터
- `src/normalize/record-normalizer.js`: request/response 표준 레코드 변환
- `src/aggregate/spec-aggregator.js`: endpoint 단위 집계
- `src/aggregate/scenario-matcher.js`: 시나리오 추적/매칭
- `src/export/excel-builder.js`: 5개 시트 생성
- `src/export/json-builder.js`: JSON 생성
- `src/index.js`: 실행 진입점

---

## 5) 데이터 모델

### 5.1 정규화 레코드
```js
{
  kind: 'request' | 'response',
  sourceFile: string,
  step: string,
  method: string,
  endpoint: string,
  origin: string,
  query: object,
  headers: object,
  cookies: string[],
  requestBody: any,
  responseBody: any,
  status: number | '',
  requestContentType: string,
  timestamp: string | number
}
```

### 5.2 집계 스펙
```js
{
  method, endpoint,
  steps: Set,
  origins: Set,
  requestCount, responseCount,
  statuses: Set,
  requestFields: Map<path, {count, types, examples}>,
  responseFields: Map<path, {count, types, examples}>,
  queryParams: Map<name, {count, types, examples}>,
  cookies: Map<name, count>,
  scenarios: [],
  warnings: []
}
```

---

## 6) 핵심 처리 규칙

### 6.1 URL/Query 정규화
- `VOLATILE_QUERY_KEYS` 기본값 적용
- `--exclude-query`로 런타임 확장
- endpoint key는 `METHOD + pathname` 기준

### 6.2 Body 파싱 우선순위
1. `parsedBody` 존재 시 사용
2. JSON parse
3. form-urlencoded parse
4. raw string fallback

### 6.3 타입 추론
- primitive + array(inner type) + object
- string은 integer-like/number-like/date-like 보조 분류

### 6.4 required/optional 판정
- 요청 계열: `count === requestCount`면 required
- 응답 계열: `count === responseCount`면 required
- 응답 수가 0인 endpoint는 `unknown`으로 표시

### 6.5 시나리오 매칭
- 1차 키: `(sourceFile, step, method, endpoint)`
- 2차 키: timestamp 근접도(예: ±5초)
- 매칭 실패는 `품질 경고` 시트로 이동

### 6.6 민감정보 마스킹
- header: `cookie`, `authorization` 제외
- body 내 패턴(`token`, `password`, `auth`)은 샘플 출력 시 `***` 마스킹

---

## 7) 시트 설계

### 7.1 API 명세
- 순서, 단계명, Method, Endpoint
- 환경/인증/요청수/응답수/Status
- 필요 쿠키, Query 요약, Request/Response 필드 요약
- 비즈니스 결과 힌트

### 7.2 파라미터 상세
- Endpoint, 위치(Query/Body/Response), 필드 경로
- Required/Optional, 타입, 관측 예시, 출처(가능 시)

### 7.3 시나리오 비교
- 환경, 인증, 가입유형(entryCd), Status, 요청 샘플, 소스 파일

### 7.4 요청·응답 샘플
- 요청 샘플 1~2개
- 성공 응답 샘플 1개
- 실패 응답 샘플 1개

### 7.5 품질 경고 (신규)
- 매칭 실패, parse 실패, 빈 endpoint, 비정상 status 등

---

## 8) 성능/안정성
- 대용량 로그 대비 스트리밍 또는 chunk 로딩 옵션 고려 (`--chunk-size` 확장 여지)
- 시트 셀 길이 제한(예: 1500자) 적용
- 파싱 실패는 중단하지 않고 warning 누적

---

## 9) 마이그레이션 전략

### Phase 1: CLI + 로더 통합
- v1 옵션을 v2 파이프라인 앞단에 이식

### Phase 2: 출력 통합
- v2 집계 결과를 v1 스타일 4시트에 매핑
- JSON 출력 추가

### Phase 3: 품질 보강
- 품질 경고 시트
- strict pairing
- 민감정보 마스킹 강화

---

## 10) 완료 기준 (DoD)
- `node --check` 통과
- 샘플 로그셋에서 Excel 5시트 생성 확인
- JSON 산출물 생성 확인
- `--env/--auth/--file/--all/--out` 옵션 동작 확인
- 매칭 실패/파싱 실패가 경고 시트에 기록됨

---

## 11) 권장 기본값
- 기본 입력: 최신 로그 1개 (`--all` 미지정 시)
- 기본 제외 쿼리키: `_, timestamp, ts, t, callback, cacheBust, cachebuster`
- 샘플 축약 깊이: 2
- 시나리오 매칭 허용 오차: 5초

---

## 12) 요약
이 설계는 **v2 분석력 + v1 사용성**을 결합한 형태다.
- 개발자에게는 정밀한 필드/타입/샘플/품질 지표를 제공하고,
- 기획/운영에게는 한국어 기반의 읽기 쉬운 보고서를 제공한다.
