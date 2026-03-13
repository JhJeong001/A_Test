--- /mnt/data/capture_proj/scripts/extract-api-spec.js	2026-03-12 08:17:08.000000000 +0000
+++ /mnt/data/capture_proj/scripts/extract-api-spec-v2.js	2026-03-13 04:28:05.317745278 +0000
@@ -2,295 +2,488 @@
 const path = require('path');
 const XLSX = require('xlsx');
 
-const LOG_DIR = path.join(__dirname, '..', 'output', 'logs');
-const SPEC_DIR = path.join(__dirname, '..', 'output', 'spec');
+const ROOT = path.join(__dirname, '..');
+const LOG_DIR = path.join(ROOT, 'output', 'logs');
+const SPEC_DIR = path.join(ROOT, 'output', 'spec');
+const VOLATILE_QUERY_KEYS = new Set(['_', 'timestamp', 'ts', 't', 'callback', 'cacheBust', 'cachebuster']);
+const SENSITIVE_HEADERS = new Set(['cookie', 'authorization']);
+const STEP_MAPPING = {
+  step_01_shop_product_list_landing: { order: 1, name: '상품리스트' },
+  step_02_wait_product_list_ready: { order: 2, name: '상품리스트대기' },
+  step_03_select_product_direct: { order: 3, name: '상품선택' },
+  step_03_select_product_and_detail_apis: { order: 3, name: '상품선택' },
+  step_04_open_entry_popup: { order: 4, name: '가입유형팝업' },
+  step_05_select_entry_type: { order: 5, name: '가입유형선택' },
+  step_06_confirm_entry_type: { order: 6, name: '가입유형확정' },
+  step_06_confirm_entry_type_and_prod_detail: { order: 6, name: '가입유형확정' },
+  step_07_manual_flow_after_entry: { order: 7, name: '수동진행' },
+};
 
 function ensureDir(dir) {
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 }
 
-function getLatestLogFile() {
-  const files = fs.readdirSync(LOG_DIR)
-    .filter(f => f.endsWith('.json'))
-    .map(f => ({
-      name: f,
-      time: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime()
+function listLogFiles() {
+  return fs.readdirSync(LOG_DIR)
+    .filter((name) => name.endsWith('.json'))
+    .map((name) => ({
+      name,
+      fullPath: path.join(LOG_DIR, name),
+      mtimeMs: fs.statSync(path.join(LOG_DIR, name)).mtimeMs,
     }))
-    .sort((a, b) => b.time - a.time);
-
-  if (!files.length) throw new Error('로그 파일 없음');
+    .sort((a, b) => a.mtimeMs - b.mtimeMs);
+}
 
-  return path.join(LOG_DIR, files[0].name);
+function safeJsonParse(value) {
+  if (value == null || value === '') return null;
+  if (typeof value === 'object') return value;
+  try {
+    return JSON.parse(value);
+  } catch {
+    return null;
+  }
 }
 
-// 개선된 파라미터 추출 (nested object 지원)
-function extractParams(data, depth = 2) {
+function tryParseFormEncoded(text) {
+  if (!text || typeof text !== 'string') return null;
+  if (text.trim().startsWith('{') || text.trim().startsWith('[')) return null;
+  if (!text.includes('=')) return null;
+
   try {
-    const obj = JSON.parse(data);
-    const keys = [];
-    
-    function traverse(obj, prefix = '', currentDepth = 0) {
-      if (currentDepth > depth) return;
-      
-      for (const [key, value] of Object.entries(obj)) {
-        const fullKey = prefix ? `${prefix}.${key}` : key;
-        keys.push(fullKey);
-        
-        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
-          traverse(value, fullKey, currentDepth + 1);
-        }
+    const params = new URLSearchParams(text);
+    const obj = {};
+    for (const [key, value] of params.entries()) {
+      if (Object.prototype.hasOwnProperty.call(obj, key)) {
+        if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
+        obj[key].push(value);
+      } else {
+        obj[key] = value;
       }
     }
-    
-    traverse(obj);
-    return keys.join(', ');
+    return Object.keys(obj).length ? obj : null;
   } catch {
-    return '';
+    return null;
   }
 }
 
-function extractResponseFields(body) {
+function normalizeUrl(rawUrl) {
   try {
-    const obj = JSON.parse(body);
-    return Object.keys(obj).join(', ');
+    const u = new URL(rawUrl);
+    return {
+      origin: u.origin,
+      pathname: u.pathname,
+      query: Object.fromEntries([...u.searchParams.entries()].filter(([k]) => !VOLATILE_QUERY_KEYS.has(k))),
+    };
   } catch {
-    return '';
+    return { origin: '', pathname: rawUrl, query: {} };
   }
 }
 
-function extractEndpoint(url) {
-  try {
-    const u = new URL(url);
-    return u.pathname;  // endpoint는 pathname만
-  } catch {
-    return url;
+function sortObjectDeep(value) {
+  if (Array.isArray(value)) return value.map(sortObjectDeep);
+  if (value && typeof value === 'object') {
+    return Object.keys(value).sort().reduce((acc, key) => {
+      acc[key] = sortObjectDeep(value[key]);
+      return acc;
+    }, {});
   }
+  return value;
 }
 
-// Query Parameter 추출 함수 추가
-function extractQueryParams(url) {
-  try {
-    const u = new URL(url);
-    if (!u.search) return '';
-    
-    // ?를 제거하고 반환
-    return u.search.substring(1);
-  } catch {
-    return '';
+function inferValueType(value) {
+  if (Array.isArray(value)) {
+    if (value.length === 0) return 'array<unknown>';
+    const inner = [...new Set(value.slice(0, 5).map(inferValueType))].join('|');
+    return `array<${inner}>`;
+  }
+  if (value === null) return 'null';
+  if (typeof value === 'boolean') return 'boolean';
+  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
+  if (typeof value === 'string') {
+    if (value === '') return 'string(empty)';
+    if (/^(true|false)$/i.test(value)) return 'string(boolean-like)';
+    if (/^-?\d+$/.test(value)) return 'string(integer-like)';
+    if (/^-?\d+\.\d+$/.test(value)) return 'string(number-like)';
+    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string(date-like)';
+    return 'string';
   }
+  if (value && typeof value === 'object') return 'object';
+  return typeof value;
 }
 
-// Cookie 이름만 추출 (값은 제외)
-function extractCookieNames(headers) {
-  const cookieHeader = headers?.['cookie'] || '';
-  if (!cookieHeader) return '';
-  
-  const cookieNames = cookieHeader
-    .split('; ')
-    .map(c => c.split('=')[0])
-    .filter(name => name);
-  
-  return cookieNames.join(', ');
-}
-
-// Response Body 간소화
-function simplifyJson(obj, depth = 2) {
-  if (depth === 0) return '...';
-  
-  if (Array.isArray(obj)) {
-    if (obj.length === 0) return [];
-    return [simplifyJson(obj[0], depth - 1)];
-  }
-  
-  if (typeof obj === 'object' && obj !== null) {
-    const result = {};
-    for (const [key, value] of Object.entries(obj)) {
-      result[key] = simplifyJson(value, depth - 1);
-    }
-    return result;
-  }
-  
-  // 긴 문자열은 축약
-  if (typeof obj === 'string' && obj.length > 50) {
-    return obj.substring(0, 47) + '...';
-  }
-  
-  return obj;
-}
-
-function formatJsonForExcel(data) {
-  if (!data) return '';
-  
-  // Query String 형식 확인 (key=value&key2=value2)
-  if (typeof data === 'string' && data.includes('=') && !data.trim().startsWith('{')) {
-    // Query String을 JSON 형태로 변환
-    try {
-      const params = {};
-      data.split('&').forEach(pair => {
-        const [key, value] = pair.split('=');
-        if (key) {
-          params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
-        }
-      });
-      return JSON.stringify(params, null, 2);
-    } catch {
-      return data;
+function flattenSchema(value, prefix = '', rows = []) {
+  if (Array.isArray(value)) {
+    rows.push({ path: prefix || '[]', type: inferValueType(value), example: JSON.stringify(value[0] ?? null) });
+    if (value.length > 0) flattenSchema(value[0], prefix ? `${prefix}[]` : '[]', rows);
+    return rows;
+  }
+
+  if (value && typeof value === 'object') {
+    if (prefix) rows.push({ path: prefix, type: 'object', example: '' });
+    for (const [key, child] of Object.entries(value)) {
+      const childPath = prefix ? `${prefix}.${key}` : key;
+      rows.push({ path: childPath, type: inferValueType(child), example: primitiveExample(child) });
+      if (child && typeof child === 'object') flattenSchema(child, childPath, rows);
     }
+    return rows;
   }
-  
-  // JSON 형식 처리
-  try {
-    const obj = typeof data === 'string' ? JSON.parse(data) : data;
-    const simplified = simplifyJson(obj, 2);
-    return JSON.stringify(simplified, null, 2);
-  } catch {
-    return data?.substring(0, 200) || '';
+
+  rows.push({ path: prefix || '$', type: inferValueType(value), example: primitiveExample(value) });
+  return rows;
+}
+
+function primitiveExample(value) {
+  if (value == null) return '';
+  if (typeof value === 'object') return '';
+  const text = String(value);
+  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
+}
+
+function simplifyForSample(value, depth = 2) {
+  if (depth < 0) return '...';
+  if (Array.isArray(value)) return value.length ? [simplifyForSample(value[0], depth - 1)] : [];
+  if (value && typeof value === 'object') {
+    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, simplifyForSample(v, depth - 1)]));
   }
+  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 117)}...`;
+  return value;
 }
 
-// Step 정보 매핑
-const STEP_MAPPING = {
-  'step_01_shop_product_list_landing': { order: 1, name: '상품리스트' },
-  'step_02_wait_product_list_ready': { order: 2, name: '상품리스트대기' },
-  'step_03_select_product_direct': { order: 3, name: '상품선택' },
-  'step_03_select_product_and_detail_apis': { order: 3, name: '상품선택' },  // 추가
-  'step_04_open_entry_popup': { order: 4, name: '가입유형팝업' },
-  'step_05_select_entry_type': { order: 5, name: '가입유형선택' },
-  'step_06_confirm_entry_type': { order: 6, name: '가입유형확정' },
-  'step_06_confirm_entry_type_and_prod_detail': { order: 6, name: '가입유형확정' },  // 추가
-  'step_07_manual_flow_after_entry': { order: 7, name: '수동진행' },
-};
+function normalizeRequestBody(item) {
+  if (item.parsedBody) return item.parsedBody;
+  const byJson = safeJsonParse(item.postData);
+  if (byJson) return byJson;
+  const byForm = tryParseFormEncoded(item.postData);
+  if (byForm) return byForm;
+  return item.postData || null;
+}
+
+function normalizeResponseBody(item) {
+  if (item.response?.data !== undefined) return item.response.data;
+  if (item.body !== undefined) {
+    const parsed = safeJsonParse(item.body);
+    return parsed ?? item.body;
+  }
+  if (item.responseBody !== undefined) {
+    const parsed = safeJsonParse(item.responseBody);
+    return parsed ?? item.responseBody;
+  }
+  if (item.response !== undefined) return item.response;
+  return null;
+}
 
-function buildSpec(logs) {
-  const map = new Map();
+function toRequestRecord(item, sourceFile) {
+  const { origin, pathname, query } = normalizeUrl(item.url || item.endpoint || '');
+  return {
+    kind: 'request',
+    sourceFile,
+    step: item.step || 'unknown',
+    method: item.method || 'GET',
+    endpoint: pathname,
+    origin,
+    query,
+    headers: sanitizeHeaders(item.headers || {}),
+    cookies: extractCookieNames(item.headers || {}, item.cookies),
+    requestBody: normalizeRequestBody(item),
+    requestContentType: (item.headers?.['content-type'] || item.headers?.['Content-Type'] || '').split(';')[0] || '',
+    timestamp: item.timestamp || item.time || '',
+  };
+}
+
+function toResponseRecord(item, sourceFile) {
+  const { origin, pathname } = normalizeUrl(item.url || item.endpoint || '');
+  return {
+    kind: 'response',
+    sourceFile,
+    step: item.step || 'unknown',
+    method: item.method || 'GET',
+    endpoint: pathname,
+    origin,
+    status: item.status ?? item.response?.status ?? '',
+    responseBody: normalizeResponseBody(item),
+    timestamp: item.timestamp || item.time || '',
+  };
+}
+
+function sanitizeHeaders(headers) {
+  const out = {};
+  for (const [key, value] of Object.entries(headers)) {
+    const lower = key.toLowerCase();
+    if (SENSITIVE_HEADERS.has(lower)) continue;
+    if (['content-type', 'accept', 'origin', 'referer', 'x-requested-with'].includes(lower) || lower.startsWith('x-')) {
+      out[lower] = value;
+    }
+  }
+  return out;
+}
+
+function extractCookieNames(headers, cookiesField) {
+  const names = new Set();
+  const cookieHeader = headers.cookie || headers.Cookie;
+  if (cookieHeader) {
+    for (const chunk of cookieHeader.split(';')) {
+      const name = chunk.split('=')[0].trim();
+      if (name) names.add(name);
+    }
+  }
+  if (cookiesField && typeof cookiesField === 'object') {
+    for (const name of Object.keys(cookiesField)) names.add(name);
+  }
+  return [...names].sort();
+}
+
+function toBusinessResult(body) {
+  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
+  if (Object.prototype.hasOwnProperty.call(body, 'result')) {
+    const errCd = body.errCd ? ` / ${body.errCd}` : '';
+    const errMsg = body.errMsg ? ` / ${String(body.errMsg).slice(0, 60)}` : '';
+    return `result=${body.result}${errCd}${errMsg}`;
+  }
+  if (Object.prototype.hasOwnProperty.call(body, 'code') || Object.prototype.hasOwnProperty.call(body, 'message')) {
+    return `${body.code || ''}${body.message ? ` / ${String(body.message).slice(0, 60)}` : ''}`.trim();
+  }
+  return '';
+}
 
-  for (const item of logs) {
-    const endpoint = extractEndpoint(item.url);
-    const key = `${item.method}_${endpoint}`;
+function buildDataset() {
+  const files = listLogFiles();
+  const requests = [];
+  const responses = [];
 
+  for (const file of files) {
+    let raw;
+    try {
+      raw = JSON.parse(fs.readFileSync(file.fullPath, 'utf-8'));
+    } catch (error) {
+      console.warn(`[WARN] skip unreadable log: ${file.name} (${error.message})`);
+      continue;
+    }
+
+    if (!Array.isArray(raw)) continue;
+
+    for (const item of raw) {
+      if (!item || typeof item !== 'object') continue;
+
+      if (item.type === 'request' || item.postData !== undefined || item.parsedBody !== undefined || item.queryParams !== undefined) {
+        requests.push(toRequestRecord(item, file.name));
+      }
+      if (item.type === 'response' || item.status !== undefined || item.response !== undefined || item.responseBody !== undefined) {
+        responses.push(toResponseRecord(item, file.name));
+      }
+    }
+  }
+
+  return { requests, responses };
+}
+
+function aggregateSpecs({ requests, responses }) {
+  const map = new Map();
+
+  function ensure(method, endpoint) {
+    const key = `${method} ${endpoint}`;
     if (!map.has(key)) {
       map.set(key, {
-        step: item.step || 'unknown',
-        method: item.method,
+        method,
         endpoint,
-        requiredCookies: new Set(),
-        requestBodySamples: [],
-        responseBodySamples: [],
-        responseStatuses: new Set()
+        origins: new Set(),
+        steps: new Set(),
+        requestCount: 0,
+        responseCount: 0,
+        fileNames: new Set(),
+        requestContentTypes: new Set(),
+        statuses: new Set(),
+        cookies: new Map(),
+        queryParams: new Map(),
+        requestFields: new Map(),
+        responseFields: new Map(),
+        requestSamples: [],
+        successResponseSample: null,
+        errorResponseSample: null,
+        businessResults: new Set(),
+        headers: new Set(),
       });
     }
+    return map.get(key);
+  }
 
-    const row = map.get(key);
+  for (const req of requests) {
+    const spec = ensure(req.method, req.endpoint);
+    spec.requestCount += 1;
+    spec.origins.add(req.origin);
+    spec.steps.add(req.step);
+    spec.fileNames.add(req.sourceFile);
+    if (req.requestContentType) spec.requestContentTypes.add(req.requestContentType);
+    Object.keys(req.headers || {}).forEach((name) => spec.headers.add(name));
 
-    if (item.type === 'request') {
-      // Cookie 이름 수집
-      const cookieNames = extractCookieNames(item.headers);
-      if (cookieNames) {
-        cookieNames.split(', ').forEach(name => row.requiredCookies.add(name));
-      }
+    for (const cookieName of req.cookies) {
+      spec.cookies.set(cookieName, (spec.cookies.get(cookieName) || 0) + 1);
+    }
 
-      // Request Body 또는 Query Parameter 샘플 저장 (최대 1개만)
-      if (row.requestBodySamples.length === 0) {
-        if (item.method === 'GET') {
-          // GET 요청: Query Parameter 추출
-          const queryParams = extractQueryParams(item.url);
-          if (queryParams) {
-            row.requestBodySamples.push(queryParams);
-          }
-        } else if (item.postData) {
-          // POST/PUT/PATCH 등: Request Body 저장
-          row.requestBodySamples.push(item.postData);
-        }
-      }
+    for (const [key, value] of Object.entries(req.query || {})) {
+      const entry = spec.queryParams.get(key) || { count: 0, types: new Set(), examples: new Set() };
+      entry.count += 1;
+      entry.types.add(inferValueType(value));
+      if (entry.examples.size < 3) entry.examples.add(String(value));
+      spec.queryParams.set(key, entry);
     }
 
-    if (item.type === 'response') {
-      // Status code 수집
-      if (item.status) {
-        row.responseStatuses.add(item.status);
+    if (req.requestBody && typeof req.requestBody === 'object') {
+      for (const row of flattenSchema(sortObjectDeep(req.requestBody))) {
+        const entry = spec.requestFields.get(row.path) || { count: 0, types: new Set(), examples: new Set() };
+        entry.count += 1;
+        entry.types.add(row.type);
+        if (row.example && entry.examples.size < 3) entry.examples.add(row.example);
+        spec.requestFields.set(row.path, entry);
       }
+    }
 
-      // Response Body 샘플 저장 (최대 1개만)
-      if (item.body && row.responseBodySamples.length === 0) {
-        row.responseBodySamples.push(item.body);
+    if (spec.requestSamples.length < 2 && req.requestBody != null) {
+      spec.requestSamples.push(req.requestBody);
+    }
+  }
+
+  for (const res of responses) {
+    const spec = ensure(res.method, res.endpoint);
+    spec.responseCount += 1;
+    spec.steps.add(res.step);
+    spec.fileNames.add(res.sourceFile);
+    if (res.status !== '') spec.statuses.add(res.status);
+
+    const body = res.responseBody;
+    const businessResult = toBusinessResult(body);
+    if (businessResult) spec.businessResults.add(businessResult);
+
+    if (body && typeof body === 'object') {
+      for (const row of flattenSchema(sortObjectDeep(body))) {
+        const entry = spec.responseFields.get(row.path) || { count: 0, types: new Set(), examples: new Set() };
+        entry.count += 1;
+        entry.types.add(row.type);
+        if (row.example && entry.examples.size < 3) entry.examples.add(row.example);
+        spec.responseFields.set(row.path, entry);
       }
     }
+
+    const isSuccess = typeof res.status === 'number' ? res.status >= 200 && res.status < 400 : false;
+    if (isSuccess && !spec.successResponseSample && body != null) spec.successResponseSample = body;
+    if (!isSuccess && !spec.errorResponseSample && body != null) spec.errorResponseSample = body;
+    if (!spec.successResponseSample && !spec.errorResponseSample && body != null) spec.successResponseSample = body;
   }
 
-  return Array.from(map.values())
-    .map(item => {
-      const stepInfo = STEP_MAPPING[item.step] || { order: 999, name: item.step };
-      
-      return {
-        step: stepInfo.order,
-        stepName: stepInfo.name,
-        method: item.method,
-        endpoint: item.endpoint,
-        requiredCookies: [...item.requiredCookies].join(', '),
-        requestBodySample: formatJsonForExcel(item.requestBodySamples[0]),
-        responseBodySample: formatJsonForExcel(item.responseBodySamples[0]),
-        responseStatus: [...item.responseStatuses].join(', '),
-        uiValidation: '',  // 수동 입력용
-        expectedValue: ''   // 수동 입력용
-      };
-    })
-    .sort((a, b) => a.step - b.step);
+  return [...map.values()].map((spec) => finalizeSpec(spec));
+}
+
+function finalizeSpec(spec) {
+  const sortedSteps = [...spec.steps].sort((a, b) => (STEP_MAPPING[a]?.order || 999) - (STEP_MAPPING[b]?.order || 999));
+  const primaryStep = sortedSteps[0] || 'unknown';
+  const stepInfo = STEP_MAPPING[primaryStep] || { order: 999, name: primaryStep };
+
+  return {
+    step: stepInfo.order,
+    stepName: stepInfo.name,
+    method: spec.method,
+    endpoint: spec.endpoint,
+    observedOrigins: [...spec.origins].filter(Boolean).join(', '),
+    observedSteps: sortedSteps.join(', '),
+    requestCount: spec.requestCount,
+    responseCount: spec.responseCount,
+    requestContentTypes: [...spec.requestContentTypes].sort().join(', '),
+    requestHeaders: [...spec.headers].sort().join(', '),
+    requiredCookies: summarizePresenceMap(spec.cookies, spec.requestCount),
+    querySpec: summarizePresenceMap(spec.queryParams, spec.requestCount, true),
+    requestFieldSpec: summarizePresenceMap(spec.requestFields, spec.requestCount, true),
+    responseFieldSpec: summarizePresenceMap(spec.responseFields, Math.max(spec.responseCount, 1), true),
+    responseStatuses: [...spec.statuses].sort((a, b) => Number(a) - Number(b)).join(', '),
+    businessResultHints: [...spec.businessResults].join(' | '),
+    requestBodySample: formatCellSample(spec.requestSamples[0]),
+    successResponseSample: formatCellSample(spec.successResponseSample),
+    errorResponseSample: formatCellSample(spec.errorResponseSample),
+    sourceFiles: [...spec.fileNames].sort().join(', '),
+  };
+}
+
+function summarizePresenceMap(map, totalCount, includeTypeInfo = false) {
+  const rows = [...map.entries()].map(([name, meta]) => {
+    const count = typeof meta === 'number' ? meta : meta.count;
+    const presence = totalCount > 0 && count === totalCount ? 'required' : 'optional';
+    if (!includeTypeInfo) return `${name}(${presence})`;
+    const types = meta.types ? [...meta.types].sort().join('|') : '';
+    const examples = meta.examples ? [...meta.examples].slice(0, 2).join(' / ') : '';
+    return `${name} [${presence}${types ? `, ${types}` : ''}${examples ? `, ex:${examples}` : ''}]`;
+  });
+
+  return rows.sort().join('\n');
 }
 
-function saveExcel(rows) {
+function formatCellSample(value) {
+  if (value == null || value === '') return '';
+  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 497)}...` : value;
+  return JSON.stringify(simplifyForSample(value, 2), null, 2);
+}
+
+function writeWorkbook(rows) {
   ensureDir(SPEC_DIR);
+  const wb = XLSX.utils.book_new();
 
-  const output = path.join(
-    SPEC_DIR,
-    `api-spec_${Date.now()}.xlsx`
-  );
-
-  const ws = XLSX.utils.json_to_sheet(rows, {
-    header: [
-      'step',
-      'stepName',
-      'method',
-      'endpoint',
-      'requiredCookies',
-      'requestBodySample',
-      'responseBodySample',
-      'responseStatus',
-      'uiValidation',
-      'expectedValue'
-    ]
-  });
+  const summaryRows = rows.map((row) => ({
+    step: row.step,
+    stepName: row.stepName,
+    method: row.method,
+    endpoint: row.endpoint,
+    requestCount: row.requestCount,
+    responseCount: row.responseCount,
+    responseStatuses: row.responseStatuses,
+    businessResultHints: row.businessResultHints,
+    requiredCookies: row.requiredCookies,
+    querySpec: row.querySpec,
+    requestContentTypes: row.requestContentTypes,
+    requestFieldSpec: row.requestFieldSpec,
+    responseFieldSpec: row.responseFieldSpec,
+    requestBodySample: row.requestBodySample,
+    successResponseSample: row.successResponseSample,
+    errorResponseSample: row.errorResponseSample,
+    sourceFiles: row.sourceFiles,
+  })).sort((a, b) => a.step - b.step || a.endpoint.localeCompare(b.endpoint));
 
-  // 컬럼 너비 설정
+  const ws = XLSX.utils.json_to_sheet(summaryRows);
   ws['!cols'] = [
-    { wch: 6 },   // step
-    { wch: 20 },  // stepName
-    { wch: 8 },   // method
-    { wch: 45 },  // endpoint
-    { wch: 20 },  // requiredCookies
-    { wch: 50 },  // requestBodySample
-    { wch: 50 },  // responseBodySample
-    { wch: 12 },  // responseStatus
-    { wch: 30 },  // uiValidation
-    { wch: 20 }   // expectedValue
+    { wch: 6 }, { wch: 16 }, { wch: 8 }, { wch: 45 }, { wch: 10 }, { wch: 10 },
+    { wch: 14 }, { wch: 35 }, { wch: 24 }, { wch: 36 }, { wch: 20 }, { wch: 55 },
+    { wch: 55 }, { wch: 45 }, { wch: 45 }, { wch: 50 }
   ];
+  XLSX.utils.book_append_sheet(wb, ws, 'API_Summary');
 
-  const wb = XLSX.utils.book_new();
-  XLSX.utils.book_append_sheet(wb, ws, 'API');
-
-  XLSX.writeFile(wb, output);
+  const detailRows = [];
+  for (const row of rows) {
+    for (const line of row.requestFieldSpec.split('\n').filter(Boolean)) {
+      detailRows.push({ endpoint: `${row.method} ${row.endpoint}`, area: 'request', field: line });
+    }
+    for (const line of row.responseFieldSpec.split('\n').filter(Boolean)) {
+      detailRows.push({ endpoint: `${row.method} ${row.endpoint}`, area: 'response', field: line });
+    }
+    for (const line of row.querySpec.split('\n').filter(Boolean)) {
+      detailRows.push({ endpoint: `${row.method} ${row.endpoint}`, area: 'query', field: line });
+    }
+  }
+  const ws2 = XLSX.utils.json_to_sheet(detailRows);
+  ws2['!cols'] = [{ wch: 50 }, { wch: 10 }, { wch: 80 }];
+  XLSX.utils.book_append_sheet(wb, ws2, 'Field_Details');
+
+  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
+  const xlsxPath = path.join(SPEC_DIR, `api-spec-v2_${timestamp}.xlsx`);
+  const jsonPath = path.join(SPEC_DIR, `api-spec-v2_${timestamp}.json`);
+  XLSX.writeFile(wb, xlsxPath);
+  fs.writeFileSync(jsonPath, JSON.stringify(summaryRows, null, 2));
 
-  console.log('API 명세 저장 완료:', output);
-  console.log('총 API 수:', rows.length);
+  return { xlsxPath, jsonPath, count: summaryRows.length };
 }
 
 function main() {
-  const logFile = getLatestLogFile();
-  console.log('로그 파일:', logFile);
-
-  const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
-  const rows = buildSpec(logs);
-
-  saveExcel(rows);
+  const dataset = buildDataset();
+  const rows = aggregateSpecs(dataset);
+  const result = writeWorkbook(rows);
+  console.log(`API spec generated: ${result.xlsxPath}`);
+  console.log(`JSON generated: ${result.jsonPath}`);
+  console.log(`Total APIs: ${result.count}`);
 }
 
-main();
\ No newline at end of file
+main();
