const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'output', 'logs');
const SPEC_DIR = path.join(ROOT, 'output', 'spec');

const BASE_VOLATILE_QUERY_KEYS = new Set(['_', 'timestamp', 'ts', 't', 'callback', 'cacheBust', 'cachebuster']);
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization']);
const SENSITIVE_BODY_KEYS = [/token/i, /password/i, /^auth/i, /secret/i];

const STEP_MAPPING = {
  step_01_shop_product_list_landing: { order: 1, name: '상품 리스트' },
  step_02_wait_product_list_ready: { order: 2, name: '상품 리스트 대기' },
  step_03_select_product_direct: { order: 3, name: '상품 선택' },
  step_03_select_product_and_detail_apis: { order: 3, name: '상품 선택' },
  step_04_open_entry_popup: { order: 4, name: '가입유형 팝업' },
  step_05_select_entry_type: { order: 5, name: '가입유형 선택' },
  step_06_confirm_entry_type: { order: 6, name: '가입유형 확정' },
  step_06_confirm_entry_type_and_prod_detail: { order: 6, name: '가입유형 확정' },
  step_07_manual_flow_after_entry: { order: 7, name: '혜택/배송/주문' },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const readValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };

  const excludeQueryRaw = readValue('--exclude-query');
  const excludeQuery = new Set([...BASE_VOLATILE_QUERY_KEYS]);
  if (excludeQueryRaw) {
    for (const key of excludeQueryRaw.split(',').map((v) => v.trim()).filter(Boolean)) {
      excludeQuery.add(key);
    }
  }

  const outPath = readValue('--out');
  const jsonOutPath = readValue('--json-out');

  return {
    file: readValue('--file'),
    all: args.includes('--all'),
    env: readValue('--env'),
    auth: readValue('--auth'),
    outPath: outPath ? path.resolve(outPath) : null,
    jsonOutPath: jsonOutPath ? path.resolve(jsonOutPath) : null,
    strictPairing: args.includes('--strict-pairing'),
    excludeQuery,
  };
}

function detectMetaFromFilename(name) {
  const lower = name.toLowerCase();
  const env = lower.includes('prod') ? 'prod' : lower.includes('stg') ? 'stg' : '';
  const auth = lower.includes('guest') ? 'guest' : lower.includes('login') ? 'login' : '';
  return { env, auth };
}

function listLogFiles(options) {
  if (!fs.existsSync(LOG_DIR)) {
    throw new Error(`로그 디렉터리를 찾을 수 없습니다: ${LOG_DIR}`);
  }

  const files = fs.readdirSync(LOG_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(LOG_DIR, name);
      const stat = fs.statSync(fullPath);
      const meta = detectMetaFromFilename(name);
      return { name, fullPath, mtimeMs: stat.mtimeMs, ...meta };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (options.file) {
    const resolved = path.resolve(options.file);
    const match = files.find((f) => path.resolve(f.fullPath) === resolved || path.resolve(path.join(LOG_DIR, f.name)) === resolved);
    if (!match) throw new Error(`--file 대상 로그를 찾을 수 없습니다: ${options.file}`);
    return [match];
  }

  let selected = options.all ? files : files.slice(-1);
  if (options.env) selected = selected.filter((f) => f.env === options.env);
  if (options.auth) selected = selected.filter((f) => f.auth === options.auth);

  if (selected.length === 0) {
    throw new Error('조건에 맞는 로그 파일이 없습니다. (--all/--env/--auth/--file 확인)');
  }

  return selected;
}

function safeJsonParse(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryParseFormEncoded(text) {
  if (!text || typeof text !== 'string') return null;
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) return null;
  if (!text.includes('=')) return null;

  try {
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [key, value] of params.entries()) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
        obj[key].push(value);
      } else {
        obj[key] = value;
      }
    }
    return Object.keys(obj).length ? obj : null;
  } catch {
    return null;
  }
}

function normalizeUrl(rawUrl, volatileKeys) {
  try {
    const u = new URL(rawUrl);
    return {
      origin: u.origin,
      pathname: u.pathname,
      query: Object.fromEntries([...u.searchParams.entries()].filter(([k]) => !volatileKeys.has(k))),
    };
  } catch {
    return { origin: '', pathname: rawUrl || '', query: {} };
  }
}

function parseEntryCd(query, requestBody) {
  const source = [query?.entryCd, requestBody?.entryCd, requestBody?.svcInfo?.entryCd].find(Boolean);
  if (!source) return '';
  const map = { '11': '신규가입', '20': '번호이동', '31': '기기변경' };
  return map[String(source)] || String(source);
}

function normalizeRequestBody(item) {
  if (item.parsedBody) return item.parsedBody;
  const byJson = safeJsonParse(item.postData);
  if (byJson !== null) return byJson;
  const byForm = tryParseFormEncoded(item.postData);
  if (byForm) return byForm;
  return item.postData || null;
}

function normalizeResponseBody(item) {
  if (item.response?.data !== undefined) return item.response.data;
  if (item.body !== undefined) return safeJsonParse(item.body) ?? item.body;
  if (item.responseBody !== undefined) return safeJsonParse(item.responseBody) ?? item.responseBody;
  if (item.response !== undefined) return item.response;
  return null;
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) continue;
    if (['content-type', 'accept', 'origin', 'referer', 'x-requested-with'].includes(lower) || lower.startsWith('x-')) {
      out[lower] = value;
    }
  }
  return out;
}

function extractCookieNames(headers, cookiesField) {
  const names = new Set();
  const cookieHeader = headers?.cookie || headers?.Cookie;
  if (cookieHeader && typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const key = part.split('=')[0].trim();
      if (key) names.add(key);
    }
  }
  if (cookiesField && typeof cookiesField === 'object') {
    for (const key of Object.keys(cookiesField)) names.add(key);
  }
  return [...names].sort();
}

function inferValueType(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<unknown>';
    const inner = [...new Set(value.slice(0, 5).map(inferValueType))].join('|');
    return `array<${inner}>`;
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') {
    if (value === '') return 'string(empty)';
    if (/^-?\d+$/.test(value)) return 'string(integer-like)';
    if (/^-?\d+\.\d+$/.test(value)) return 'string(number-like)';
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string(date-like)';
    return 'string';
  }
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

function primitiveExample(value) {
  if (value == null || typeof value === 'object') return '';
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function sortObjectDeep(value) {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortObjectDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function flattenSchema(value, prefix = '', rows = []) {
  if (Array.isArray(value)) {
    rows.push({ path: prefix || '[]', type: inferValueType(value), example: JSON.stringify(value[0] ?? null) });
    if (value.length > 0) flattenSchema(value[0], prefix ? `${prefix}[]` : '[]', rows);
    return rows;
  }
  if (value && typeof value === 'object') {
    if (prefix) rows.push({ path: prefix, type: 'object', example: '' });
    for (const [key, child] of Object.entries(value)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      rows.push({ path: childPath, type: inferValueType(child), example: primitiveExample(child) });
      if (child && typeof child === 'object') flattenSchema(child, childPath, rows);
    }
    return rows;
  }
  rows.push({ path: prefix || '$', type: inferValueType(value), example: primitiveExample(value) });
  return rows;
}

function simplifyForSample(value, depth = 2) {
  if (depth < 0) return '...';
  if (Array.isArray(value)) return value.length ? [simplifyForSample(value[0], depth - 1)] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, simplifyForSample(v, depth - 1)]));
  }
  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 117)}...`;
  return value;
}

function maskSensitiveData(value) {
  if (Array.isArray(value)) return value.map(maskSensitiveData);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const masked = SENSITIVE_BODY_KEYS.some((rule) => rule.test(k));
      out[k] = masked ? '***' : maskSensitiveData(v);
    }
    return out;
  }
  return value;
}

function formatSample(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.length > 700 ? `${value.slice(0, 697)}...` : value;
  return JSON.stringify(simplifyForSample(maskSensitiveData(value), 2), null, 2).slice(0, 1500);
}

function businessHint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  if (Object.prototype.hasOwnProperty.call(body, 'result')) {
    const cd = body.errCd ? ` / ${body.errCd}` : '';
    const msg = body.errMsg ? ` / ${String(body.errMsg).slice(0, 50)}` : '';
    return `result=${body.result}${cd}${msg}`;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'code') || Object.prototype.hasOwnProperty.call(body, 'message')) {
    return `${body.code || ''}${body.message ? ` / ${String(body.message).slice(0, 50)}` : ''}`.trim();
  }
  return '';
}

function toRequestRecord(item, sourceFile, sourceMeta, volatileKeys) {
  const { origin, pathname, query } = normalizeUrl(item.url || item.endpoint || '', volatileKeys);
  const requestBody = normalizeRequestBody(item);
  return {
    kind: 'request',
    sourceFile,
    env: item.env || sourceMeta.env || '',
    auth: item.auth || sourceMeta.auth || '',
    step: item.step || 'unknown',
    method: item.method || 'GET',
    endpoint: pathname || 'unknown-endpoint',
    origin,
    query,
    headers: sanitizeHeaders(item.headers || {}),
    cookies: extractCookieNames(item.headers || {}, item.cookies),
    requestBody,
    requestContentType: (item.headers?.['content-type'] || item.headers?.['Content-Type'] || '').split(';')[0] || '',
    timestamp: item.timestamp || item.time || '',
    entryCdLabel: parseEntryCd(query, requestBody),
    rawReqSample: item.postData || new URLSearchParams(query).toString(),
  };
}

function toResponseRecord(item, sourceFile, sourceMeta, volatileKeys) {
  const { origin, pathname } = normalizeUrl(item.url || item.endpoint || '', volatileKeys);
  return {
    kind: 'response',
    sourceFile,
    env: item.env || sourceMeta.env || '',
    auth: item.auth || sourceMeta.auth || '',
    step: item.step || 'unknown',
    method: item.method || 'GET',
    endpoint: pathname || 'unknown-endpoint',
    origin,
    status: item.status ?? item.response?.status ?? '',
    responseBody: normalizeResponseBody(item),
    timestamp: item.timestamp || item.time || '',
  };
}

function loadDataset(options) {
  const files = listLogFiles(options);
  const requests = [];
  const responses = [];
  const warnings = [];

  for (const file of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file.fullPath, 'utf-8'));
    } catch (error) {
      warnings.push({ level: 'ERROR', type: 'JSON_PARSE', file: file.name, detail: error.message });
      continue;
    }

    if (!Array.isArray(raw)) {
      warnings.push({ level: 'WARN', type: 'FORMAT', file: file.name, detail: '로그 루트가 배열이 아님' });
      continue;
    }

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;

      const looksRequest = item.type === 'request' || item.postData !== undefined || item.parsedBody !== undefined;
      const looksResponse = item.type === 'response' || item.status !== undefined || item.response !== undefined || item.responseBody !== undefined || item.body !== undefined;

      if (looksRequest) requests.push(toRequestRecord(item, file.name, file, options.excludeQuery));
      if (looksResponse) responses.push(toResponseRecord(item, file.name, file, options.excludeQuery));
    }
  }

  return { files, requests, responses, warnings };
}

function ensureSpec(map, method, endpoint) {
  const key = `${method} ${endpoint}`;
  if (!map.has(key)) {
    map.set(key, {
      method,
      endpoint,
      origins: new Set(),
      steps: new Set(),
      envs: new Set(),
      auths: new Set(),
      requestCount: 0,
      responseCount: 0,
      sourceFiles: new Set(),
      requestContentTypes: new Set(),
      statuses: new Set(),
      cookies: new Map(),
      queryParams: new Map(),
      requestFields: new Map(),
      responseFields: new Map(),
      requestSamples: [],
      successResponseSample: null,
      errorResponseSample: null,
      businessHints: new Set(),
      scenarios: [],
      reqQueue: [],
      warnings: [],
    });
  }
  return map.get(key);
}

function bumpPresence(map, key, value) {
  const row = map.get(key) || { count: 0, types: new Set(), examples: new Set() };
  row.count += 1;
  row.types.add(inferValueType(value));
  if (row.examples.size < 3 && value !== '' && value != null) row.examples.add(String(value));
  map.set(key, row);
}

function aggregateSpecs(dataset, options) {
  const map = new Map();
  const warnings = [...dataset.warnings];

  for (const req of dataset.requests) {
    const spec = ensureSpec(map, req.method, req.endpoint);
    spec.requestCount += 1;
    spec.origins.add(req.origin);
    spec.steps.add(req.step);
    spec.envs.add(req.env || '?');
    spec.auths.add(req.auth || '?');
    spec.sourceFiles.add(req.sourceFile);
    if (req.requestContentType) spec.requestContentTypes.add(req.requestContentType);

    for (const cookie of req.cookies) spec.cookies.set(cookie, (spec.cookies.get(cookie) || 0) + 1);
    for (const [k, v] of Object.entries(req.query || {})) bumpPresence(spec.queryParams, k, v);

    if (req.requestBody && typeof req.requestBody === 'object') {
      for (const f of flattenSchema(sortObjectDeep(req.requestBody))) {
        bumpPresence(spec.requestFields, f.path, f.example || f.type);
      }
    }

    if (spec.requestSamples.length < 2 && req.requestBody != null) spec.requestSamples.push(req.requestBody);

    const scenario = {
      env: req.env || '?',
      auth: req.auth || '?',
      entryCd: req.entryCdLabel || '-',
      status: '',
      requestSample: formatSample(req.requestBody || req.rawReqSample),
      sourceFile: req.sourceFile,
      step: req.step,
      ts: req.timestamp,
    };

    spec.scenarios.push(scenario);
    spec.reqQueue.push(scenario);
  }

  for (const res of dataset.responses) {
    const spec = ensureSpec(map, res.method, res.endpoint);
    spec.responseCount += 1;
    spec.origins.add(res.origin);
    spec.steps.add(res.step);
    spec.envs.add(res.env || '?');
    spec.auths.add(res.auth || '?');
    spec.sourceFiles.add(res.sourceFile);
    if (res.status !== '') spec.statuses.add(res.status);

    const hint = businessHint(res.responseBody);
    if (hint) spec.businessHints.add(hint);

    if (res.responseBody && typeof res.responseBody === 'object') {
      for (const f of flattenSchema(sortObjectDeep(res.responseBody))) {
        bumpPresence(spec.responseFields, f.path, f.example || f.type);
      }
    }

    const isSuccess = typeof res.status === 'number' ? res.status >= 200 && res.status < 400 : false;
    if (isSuccess && !spec.successResponseSample && res.responseBody != null) spec.successResponseSample = res.responseBody;
    if (!isSuccess && !spec.errorResponseSample && res.responseBody != null) spec.errorResponseSample = res.responseBody;
    if (!spec.successResponseSample && !spec.errorResponseSample && res.responseBody != null) spec.successResponseSample = res.responseBody;

    const open = spec.reqQueue.shift();
    if (open) {
      open.status = String(res.status ?? '-');
    } else {
      const msg = `응답 매칭 실패: ${res.method} ${res.endpoint} (${res.sourceFile})`;
      spec.warnings.push(msg);
      warnings.push({ level: options.strictPairing ? 'ERROR' : 'WARN', type: 'PAIRING', file: res.sourceFile, detail: msg });
    }
  }

  for (const spec of map.values()) {
    if (spec.reqQueue.length > 0) {
      for (const left of spec.reqQueue) {
        const msg = `요청 매칭 실패: ${spec.method} ${spec.endpoint} (${left.sourceFile})`;
        spec.warnings.push(msg);
        warnings.push({ level: options.strictPairing ? 'ERROR' : 'WARN', type: 'PAIRING', file: left.sourceFile, detail: msg });
      }
    }
  }

  return { specs: [...map.values()].map(finalizeSpec), warnings };
}

function summarizePresenceMap(map, totalCount, includeTypeInfo = false) {
  const rows = [...map.entries()].map(([name, meta]) => {
    const count = typeof meta === 'number' ? meta : meta.count;
    const required = totalCount > 0 && count === totalCount;
    if (!includeTypeInfo) return `${name}(${required ? 'required' : 'optional'})`;
    const types = meta.types ? [...meta.types].sort().join('|') : '';
    const ex = meta.examples ? [...meta.examples].slice(0, 2).join(' / ') : '';
    return `${name} [${required ? 'required' : 'optional'}${types ? `, ${types}` : ''}${ex ? `, ex:${ex}` : ''}]`;
  });
  return rows.sort().join('\n');
}

function toStepInfo(steps) {
  const sorted = [...steps].sort((a, b) => (STEP_MAPPING[a]?.order || 999) - (STEP_MAPPING[b]?.order || 999));
  const primary = sorted[0] || 'unknown';
  return { primary, sorted, info: STEP_MAPPING[primary] || { order: 999, name: primary } };
}

function finalizeSpec(spec) {
  const { sorted, info } = toStepInfo(spec.steps);
  return {
    stepOrder: info.order,
    stepName: info.name,
    observedSteps: sorted.join(', '),
    method: spec.method,
    endpoint: spec.endpoint,
    envs: [...spec.envs].join('/'),
    auths: [...spec.auths].join('/'),
    origins: [...spec.origins].filter(Boolean).join(', '),
    requestCount: spec.requestCount,
    responseCount: spec.responseCount,
    responseStatuses: [...spec.statuses].sort((a, b) => Number(a) - Number(b)).join(', '),
    requestContentTypes: [...spec.requestContentTypes].sort().join(', '),
    requiredCookies: summarizePresenceMap(spec.cookies, spec.requestCount, false),
    querySpec: summarizePresenceMap(spec.queryParams, spec.requestCount, true),
    requestFieldSpec: summarizePresenceMap(spec.requestFields, spec.requestCount, true),
    responseFieldSpec: summarizePresenceMap(spec.responseFields, Math.max(spec.responseCount, 1), true),
    businessResultHints: [...spec.businessHints].join(' | '),
    requestBodySample: formatSample(spec.requestSamples[0]),
    successResponseSample: formatSample(spec.successResponseSample),
    errorResponseSample: formatSample(spec.errorResponseSample),
    sourceFiles: [...spec.sourceFiles].sort().join(', '),
    scenarios: spec.scenarios,
    warnings: spec.warnings,
  };
}

function parsePresenceLine(line) {
  const m = line.match(/^(.+?) \[(required|optional)(?:,\s*(.+?))?(?:,\s*ex:(.+))?\]$/);
  if (!m) return { name: line, required: '', types: '', examples: '' };
  return { name: m[1], required: m[2], types: m[3] || '', examples: m[4] || '' };
}

function buildWorkbook(specRows, warnings, outputPath) {
  ensureDir(path.dirname(outputPath));
  const wb = XLSX.utils.book_new();

  const apiRows = specRows.map((s, i) => ({
    No: i + 1,
    순서: s.stepOrder,
    단계명: s.stepName,
    Method: s.method,
    Endpoint: s.endpoint,
    환경: s.envs,
    인증: s.auths,
    요청수: s.requestCount,
    응답수: s.responseCount,
    '응답 Status': s.responseStatuses,
    '필요 쿠키': s.requiredCookies,
    Query: s.querySpec,
    '요청 필드': s.requestFieldSpec,
    '응답 필드': s.responseFieldSpec,
    '비즈니스 힌트': s.businessResultHints,
    '소스 파일': s.sourceFiles,
  }));

  const ws1 = XLSX.utils.json_to_sheet(apiRows);
  ws1['!cols'] = [{ wch: 5 }, { wch: 5 }, { wch: 14 }, { wch: 8 }, { wch: 48 }, { wch: 9 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 28 }, { wch: 42 }, { wch: 50 }, { wch: 50 }, { wch: 36 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'API 명세');

  const fieldRows = [];
  for (const s of specRows) {
    for (const line of s.querySpec.split('\n').filter(Boolean)) {
      const p = parsePresenceLine(line);
      fieldRows.push({ Endpoint: `${s.method} ${s.endpoint}`, 위치: 'Query', 필드: p.name, Required: p.required, 타입: p.types, 예시: p.examples });
    }
    for (const line of s.requestFieldSpec.split('\n').filter(Boolean)) {
      const p = parsePresenceLine(line);
      fieldRows.push({ Endpoint: `${s.method} ${s.endpoint}`, 위치: 'Request', 필드: p.name, Required: p.required, 타입: p.types, 예시: p.examples });
    }
    for (const line of s.responseFieldSpec.split('\n').filter(Boolean)) {
      const p = parsePresenceLine(line);
      fieldRows.push({ Endpoint: `${s.method} ${s.endpoint}`, 위치: 'Response', 필드: p.name, Required: p.required, 타입: p.types, 예시: p.examples });
    }
  }
  const ws2 = XLSX.utils.json_to_sheet(fieldRows);
  ws2['!cols'] = [{ wch: 52 }, { wch: 10 }, { wch: 42 }, { wch: 10 }, { wch: 20 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, ws2, '파라미터 상세');

  const scenarioRows = [];
  for (const s of specRows) {
    const dedup = new Set();
    for (const sc of s.scenarios) {
      const key = `${sc.env}_${sc.auth}_${sc.entryCd}_${sc.status}_${sc.sourceFile}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      scenarioRows.push({
        Endpoint: `${s.method} ${s.endpoint}`,
        환경: sc.env,
        인증모드: sc.auth,
        가입유형: sc.entryCd,
        Status: sc.status || '-',
        '요청 샘플': sc.requestSample,
        '소스 파일': sc.sourceFile,
      });
    }
  }
  const ws3 = XLSX.utils.json_to_sheet(scenarioRows);
  ws3['!cols'] = [{ wch: 52 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 85 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws3, '시나리오 비교');

  const sampleRows = specRows.map((s) => ({
    Endpoint: `${s.method} ${s.endpoint}`,
    단계: s.stepName,
    '요청 샘플': s.requestBodySample,
    '성공 응답 샘플': s.successResponseSample,
    '실패 응답 샘플': s.errorResponseSample,
  }));
  const ws4 = XLSX.utils.json_to_sheet(sampleRows);
  ws4['!cols'] = [{ wch: 52 }, { wch: 14 }, { wch: 85 }, { wch: 85 }, { wch: 85 }];
  XLSX.utils.book_append_sheet(wb, ws4, '요청·응답 샘플');

  const warningRows = warnings.map((w, i) => ({ No: i + 1, 레벨: w.level, 유형: w.type, 파일: w.file, 상세: w.detail }));
  const ws5 = XLSX.utils.json_to_sheet(warningRows);
  ws5['!cols'] = [{ wch: 5 }, { wch: 8 }, { wch: 12 }, { wch: 32 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, ws5, '품질 경고');

  XLSX.writeFile(wb, outputPath);
}

function writeJson(specRows, jsonPath) {
  ensureDir(path.dirname(jsonPath));
  const slim = specRows.map((s) => ({
    stepOrder: s.stepOrder,
    stepName: s.stepName,
    method: s.method,
    endpoint: s.endpoint,
    envs: s.envs,
    auths: s.auths,
    requestCount: s.requestCount,
    responseCount: s.responseCount,
    responseStatuses: s.responseStatuses,
    querySpec: s.querySpec,
    requestFieldSpec: s.requestFieldSpec,
    responseFieldSpec: s.responseFieldSpec,
    businessResultHints: s.businessResultHints,
    sourceFiles: s.sourceFiles,
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(slim, null, 2));
}

function resolveOutputPaths(options) {
  ensureDir(SPEC_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const xlsxPath = options.outPath || path.join(SPEC_DIR, `api-spec-v2_${stamp}.xlsx`);
  const jsonPath = options.jsonOutPath || xlsxPath.replace(/\.xlsx$/i, '.json');
  return { xlsxPath, jsonPath };
}

function main() {
  const options = parseCliArgs(process.argv);
  const dataset = loadDataset(options);
  const { specs, warnings } = aggregateSpecs(dataset, options);

  const sorted = specs.sort((a, b) => a.stepOrder - b.stepOrder || a.endpoint.localeCompare(b.endpoint));
  const { xlsxPath, jsonPath } = resolveOutputPaths(options);

  buildWorkbook(sorted, warnings, xlsxPath);
  writeJson(sorted, jsonPath);

  console.log('📂 처리 파일:', dataset.files.map((f) => f.name).join(', '));
  console.log('🔎 추출 API 수:', sorted.length);
  console.log('⚠️ 경고 수:', warnings.length);
  console.log('✅ Excel:', xlsxPath);
  console.log('✅ JSON :', jsonPath);

  if (options.strictPairing && warnings.some((w) => w.type === 'PAIRING')) {
    process.exitCode = 2;
  }
}

main();
