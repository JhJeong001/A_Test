/**
 * extract-api-spec.js  (개선 버전)
 *
 * 개선사항:
 *  1. 다중 로그 파일 병합 (--all | --env prod|stg | --auth guest|login)
 *  2. JSON Schema 자동 추론 (request / response)
 *  3. Query-string → 파라미터 테이블 분리
 *  4. 파라미터 의존성(이전 단계 출처) 자동 태깅
 *  5. entryCd 가입유형 레이블 표기
 *  6. Excel 4개 시트: [API 명세] [파라미터 상세] [시나리오 비교] [요청·응답 샘플]
 *  7. CLI: --file <path> | --all | --env <prod|stg> | --auth <guest|login> | --out <path>
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── CLI 옵션 ────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };

const OPT_FILE = getArg('--file');
const OPT_ALL  = args.includes('--all');
const OPT_ENV  = getArg('--env');
const OPT_AUTH = getArg('--auth');
const OPT_OUT  = getArg('--out');

const LOG_DIR  = path.join(__dirname, '..', 'output', 'logs');
const SPEC_DIR = path.join(__dirname, '..', 'output', 'spec');

// ─── 상수 ────────────────────────────────────
const ENTRY_CD_MAP = { '11':'신규가입', '20':'번호이동', '31':'기기변경' };

const STEP_ORDER = {
  'step_01_shop_product_list_landing':          { order:1,  name:'상품 리스트' },
  'step_02_wait_product_list_ready':            { order:2,  name:'상품 리스트 대기' },
  'step_03_select_product_direct':              { order:3,  name:'상품 선택' },
  'step_03_select_product_and_detail_apis':     { order:3,  name:'상품 선택' },
  'step_04_open_entry_popup':                   { order:4,  name:'가입유형 팝업' },
  'step_05_select_entry_type':                  { order:5,  name:'가입유형 선택' },
  'step_06_confirm_entry_type':                 { order:6,  name:'가입유형 확정' },
  'step_06_confirm_entry_type_and_prod_detail': { order:6,  name:'가입유형 확정' },
  'step_07_manual_flow_after_entry':            { order:7,  name:'혜택/배송/주문' },
};

// 파라미터 → 출처 매핑
const PARAM_SOURCE = {
  productGrpId:    { from:'wireless/product/list/mobile-list',         field:'content[].productGrpId' },
  productId:       { from:'buyproc/product/detail/info',               field:'[].productId' },
  colorSeq:        { from:'buyproc/product/detail/info',               field:'[].colorSeq' },
  subscriptionId:  { from:'buyproc/charge/subscription-product-info',  field:'subscriptionResVo.subscriptionId' },
  entryCd:         { from:'UI 가입유형 선택',                           field:'11=신규/20=번호이동/31=기기변경' },
  giftGrpId:       { from:'buyproc/benf/tgift-list',                   field:'[].giftGrpId' },
  giftId:          { from:'buyproc/benf/tgift-list',                   field:'[].giftOptions[].giftId' },
  orderId:         { from:'buyproc/delivery/order-pay',                field:'orderId' },
  installmentTerm: { from:'buyproc/condition/installment-term-list',   field:'[]' },
  eqpCharge:       { from:'buyproc/benf/tdp-list',                     field:'eqpCharge' },
  monthlyEqpCharge:{ from:'buyproc/benf/tdp-list',                     field:'monthlyEqpCharge' },
  monthlyPayment:  { from:'buyproc/benf/tdp-list',                     field:'monthlyPayment' },
  monthlyFeeCharge:{ from:'buyproc/benf/tdp-list',                     field:'monthlyFeeCharge' },
};

// ─── 유틸 ────────────────────────────────────
const ensureDir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true }); };

function safeJson(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function getPathname(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function getQueryString(url) {
  try { const u = new URL(url); return u.search ? u.search.slice(1) : ''; }
  catch { return ''; }
}

function parseQS(qs) {
  if (!qs) return {};
  const obj = {};
  for (const pair of qs.split('&')) {
    const [k, ...rest] = pair.split('=');
    if (k) {
      try { obj[decodeURIComponent(k)] = rest.join('=') ? decodeURIComponent(rest.join('=')).replace(/\+/g,' ') : ''; }
      catch { obj[k] = rest.join('='); }
    }
  }
  return obj;
}

function parseBody(postData) {
  if (!postData) return null;
  const json = safeJson(postData);
  if (json && typeof json === 'object') return json;
  if (typeof postData === 'string' && postData.includes('=')) return parseQS(postData);
  return null;
}

function inferSchema(value, depth=0) {
  if (value === null) return { type:'null' };
  if (Array.isArray(value)) {
    if (!value.length) return { type:'array', items:{} };
    return { type:'array', items: depth<3 ? inferSchema(value[0], depth+1) : {} };
  }
  if (typeof value === 'object') {
    const props = {};
    for (const [k,v] of Object.entries(value)) {
      props[k] = depth<3 ? inferSchema(v, depth+1) : { type:typeof v };
    }
    return { type:'object', properties:props };
  }
  return { type:typeof value, example:String(value).slice(0,80) };
}

function summarizeSchema(schema, indent=0) {
  if (!schema || typeof schema !== 'object') return '';
  const pad = '  '.repeat(indent);
  if (schema.type === 'object' && schema.properties) {
    return Object.entries(schema.properties).map(([k,v]) => {
      const ex  = v.example ? ` (예: ${v.example})` : '';
      const src = PARAM_SOURCE[k] ? ` ← ${PARAM_SOURCE[k].from}` : '';
      if (v.type === 'object' && v.properties && indent < 1)
        return `${pad}${k}: {object}${src}\n${summarizeSchema(v, indent+1)}`;
      return `${pad}${k}: ${v.type}${ex}${src}`;
    }).join('\n');
  }
  if (schema.type === 'array' && schema.items)
    return `${pad}[]\n${summarizeSchema(schema.items, indent+1)}`;
  return `${pad}${schema.type}`;
}

function entryLabel(qs, bodyObj) {
  const all = { ...parseQS(String(qs||'')), ...(bodyObj||{}) };
  const cd  = all.entryCd;
  if (!cd) return '';
  return `${cd} (${ENTRY_CD_MAP[cd] || '?'})`;
}

function inferParamType(values) {
  if (!values.length) return 'string';
  if (values.every(v => /^\d+$/.test(v)))         return 'number';
  if (values.every(v => v==='Y' || v==='N'))        return 'Y/N';
  if (values.every(v => /^(true|false)$/i.test(v))) return 'boolean';
  return 'string';
}

function simplify(obj, depth) {
  if (depth===0) return '...';
  if (Array.isArray(obj)) { if(!obj.length) return []; return [simplify(obj[0], depth-1)]; }
  if (typeof obj==='object' && obj!==null) {
    const out={};
    for (const [k,v] of Object.entries(obj)) out[k]=simplify(v, depth-1);
    return out;
  }
  if (typeof obj==='string' && obj.length>60) return obj.slice(0,57)+'...';
  return obj;
}

// ─── 파일 선택 ───────────────────────────────
function selectLogFiles() {
  if (OPT_FILE) {
    const p = path.resolve(OPT_FILE);
    if (!fs.existsSync(p)) throw new Error(`파일 없음: ${p}`);
    return [{ name:path.basename(p), path:p, env:'?', auth:'?' }];
  }

  let files = fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.json') && f.startsWith('api-log_'))
    .map(f => ({
      name: f,
      path: path.join(LOG_DIR, f),
      env:  f.includes('_stg_') ? 'stg' : 'prod',
      auth: f.includes('_login_') ? 'login' : 'guest',
    }));

  if (OPT_ENV)  files = files.filter(f => f.env  === OPT_ENV);
  if (OPT_AUTH) files = files.filter(f => f.auth === OPT_AUTH);
  if (!files.length) throw new Error('조건에 맞는 로그 파일 없음');

  if (OPT_ALL) return files;

  // 기본: 최신 파일 1개
  files.sort((a,b) => fs.statSync(b.path).mtime - fs.statSync(a.path).mtime);
  return [files[0]];
}

// ─── 로그 로드 ───────────────────────────────
function loadLogs(files) {
  const merged = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(f.path, 'utf-8'));
    raw.forEach(item => { item.__src=f.name; item.__env=f.env; item.__auth=f.auth; });
    merged.push(...raw);
  }
  return merged;
}

// ─── 명세 빌드 ───────────────────────────────
function buildSpec(logs) {
  const map = new Map();

  for (const item of logs) {
    const pathname = getPathname(item.url);
    const method   = item.method || 'GET';
    const key      = `${method} ${pathname}`;
    const si       = STEP_ORDER[item.step] || { order:99, name: item.step||'unknown' };

    if (!map.has(key)) {
      map.set(key, {
        key, method, pathname,
        stepOrder: si.order, stepName: si.name,
        envs: new Set(), auths: new Set(), cookies: new Set(),
        queryParams: {}, bodyParams: {},
        bodySchema: null, respSchema: null, respSample: null,
        statuses: new Set(), scenarios: [],
      });
    }

    const spec = map.get(key);

    if (item.type === 'request') {
      spec.envs.add(item.__env||'?');
      spec.auths.add(item.__auth||'?');

      // 쿠키명
      const ch = item.headers?.cookie || item.headers?.Cookie || '';
      ch.split('; ').forEach(c => { const n=c.split('=')[0].trim(); if(n) spec.cookies.add(n); });

      // Query params
      const qs = getQueryString(item.url);
      if (qs) {
        for (const [k,v] of Object.entries(parseQS(qs))) {
          if (!spec.queryParams[k]) spec.queryParams[k] = new Set();
          spec.queryParams[k].add(v);
        }
      }

      // Body params
      const bodyObj = parseBody(item.postData);
      if (bodyObj) {
        for (const [k,v] of Object.entries(bodyObj)) {
          if (!spec.bodyParams[k]) spec.bodyParams[k] = new Set();
          spec.bodyParams[k].add(String(v));
        }
        if (!spec.bodySchema) spec.bodySchema = inferSchema(bodyObj);
      }

      spec.scenarios.push({
        env:      item.__env||'?',
        auth:     item.__auth||'?',
        entryCd:  entryLabel(qs, bodyObj),
        reqSample: item.postData
          ? String(item.postData).slice(0,300)
          : qs ? qs.slice(0,200) : '',
        status: null,
        file:   item.__src,
      });
    }

    if (item.type === 'response') {
      spec.statuses.add(item.status);
      const last = [...spec.scenarios].reverse().find(s => s.status===null);
      if (last) last.status = item.status;

      if (!spec.respSchema && item.body) {
        const p = safeJson(item.body);
        if (p) { spec.respSchema = inferSchema(p); spec.respSample = p; }
      }
    }
  }

  return [...map.values()].sort((a,b) => {
    if (a.stepOrder !== b.stepOrder) return a.stepOrder - b.stepOrder;
    return a.pathname.localeCompare(b.pathname);
  });
}

// ─── Excel 빌드 ──────────────────────────────
function buildExcel(specs) {
  const wb = XLSX.utils.book_new();

  // 시트 1: API 명세
  const mainRows = specs.map((s, i) => {
    const qKeys = Object.keys(s.queryParams).map(k => {
      const src = PARAM_SOURCE[k];
      return src ? `[Q] ${k}  ← ${src.from}` : `[Q] ${k}`;
    });
    const bKeys = Object.keys(s.bodyParams).map(k => {
      const src = PARAM_SOURCE[k];
      return src ? `[B] ${k}  ← ${src.from}` : `[B] ${k}`;
    });

    const respSummary = s.respSchema
      ? summarizeSchema(s.respSchema).slice(0,500)
      : '';

    return {
      'No':          i+1,
      '순서':        s.stepOrder,
      '단계명':      s.stepName,
      'Method':      s.method,
      'Endpoint':    s.pathname,
      '환경':        [...s.envs].join('/'),
      '인증':        [...s.auths].join('/'),
      '필요 쿠키':   [...s.cookies].join(', '),
      '파라미터':    [...qKeys, ...bKeys].join('\n'),
      '응답 Status': [...s.statuses].join(', '),
      '응답 구조':   respSummary,
      '비고':        '',
    };
  });

  const ws1 = XLSX.utils.json_to_sheet(mainRows, {
    header:['No','순서','단계명','Method','Endpoint','환경','인증','필요 쿠키','파라미터','응답 Status','응답 구조','비고'],
  });
  ws1['!cols'] = [
    {wch:5},{wch:6},{wch:14},{wch:7},{wch:50},
    {wch:8},{wch:9},{wch:30},{wch:60},{wch:12},{wch:55},{wch:20},
  ];
  XLSX.utils.book_append_sheet(wb, ws1, 'API 명세');

  // 시트 2: 파라미터 상세
  const paramRows = [];
  for (const s of specs) {
    const entries = [
      ...Object.entries(s.queryParams).map(([k,vals]) => ({kind:'Query',k,vals})),
      ...Object.entries(s.bodyParams).map(([k,vals])  => ({kind:'Body', k,vals})),
    ];
    for (const {kind,k,vals} of entries) {
      const src = PARAM_SOURCE[k];
      paramRows.push({
        'Endpoint':      s.pathname,
        'Method':        s.method,
        '단계':          s.stepName,
        '위치':          kind,
        '파라미터명':    k,
        '관측된 값':     [...vals].slice(0,5).join(' | '),
        '값 유형':       inferParamType([...vals]),
        '의존 출처':     src ? `${src.from}  .${src.field}` : '',
        '필수 여부':     '',
        '설명':          '',
      });
    }
  }

  const ws2 = XLSX.utils.json_to_sheet(paramRows, {
    header:['Endpoint','Method','단계','위치','파라미터명','관측된 값','값 유형','의존 출처','필수 여부','설명'],
  });
  ws2['!cols'] = [
    {wch:50},{wch:7},{wch:14},{wch:7},{wch:25},
    {wch:45},{wch:10},{wch:55},{wch:10},{wch:30},
  ];
  XLSX.utils.book_append_sheet(wb, ws2, '파라미터 상세');

  // 시트 3: 시나리오 비교
  const scenRows = [];
  for (const s of specs) {
    const uniq = new Map();
    for (const sc of s.scenarios) {
      const k = `${sc.env}_${sc.auth}_${sc.entryCd}`;
      if (!uniq.has(k)) uniq.set(k, sc);
    }
    for (const sc of uniq.values()) {
      scenRows.push({
        'Endpoint':  s.pathname,
        'Method':    s.method,
        '환경':      sc.env,
        '인증모드':  sc.auth,
        '가입유형':  sc.entryCd || '-',
        'Status':    sc.status ?? '-',
        '요청 샘플': sc.reqSample,
        '소스 파일': sc.file,
      });
    }
  }

  const ws3 = XLSX.utils.json_to_sheet(scenRows, {
    header:['Endpoint','Method','환경','인증모드','가입유형','Status','요청 샘플','소스 파일'],
  });
  ws3['!cols'] = [
    {wch:50},{wch:7},{wch:6},{wch:10},{wch:16},{wch:8},{wch:80},{wch:45},
  ];
  XLSX.utils.book_append_sheet(wb, ws3, '시나리오 비교');

  // 시트 4: 요청·응답 샘플
  const sampleRows = specs.map(s => ({
    'Endpoint':  s.pathname,
    'Method':    s.method,
    '단계':      s.stepName,
    '요청 샘플': s.scenarios[0]?.reqSample || '',
    '응답 샘플': s.respSample
      ? JSON.stringify(simplify(s.respSample, 2), null, 2).slice(0,1500)
      : '',
  }));

  const ws4 = XLSX.utils.json_to_sheet(sampleRows, {
    header:['Endpoint','Method','단계','요청 샘플','응답 샘플'],
  });
  ws4['!cols'] = [{wch:50},{wch:7},{wch:14},{wch:80},{wch:100}];
  XLSX.utils.book_append_sheet(wb, ws4, '요청·응답 샘플');

  return wb;
}

// ─── 메인 ────────────────────────────────────
function main() {
  ensureDir(SPEC_DIR);

  const files = selectLogFiles();
  console.log(`\n📂 처리할 로그 파일 (${files.length}개):`);
  files.forEach(f => console.log(`   ${f.name}`));

  const logs  = loadLogs(files);
  console.log(`\n📋 총 로그 항목: ${logs.length}개`);

  const specs = buildSpec(logs);
  console.log(`🔎 추출된 API: ${specs.length}개`);

  const wb  = buildExcel(specs);
  const out = OPT_OUT
    ? path.resolve(OPT_OUT)
    : path.join(SPEC_DIR, `api-spec_${Date.now()}.xlsx`);

  XLSX.writeFile(wb, out);
  console.log(`\n✅ 저장 완료: ${out}`);
  console.log('   시트: [API 명세] [파라미터 상세] [시나리오 비교] [요청·응답 샘플]\n');

  console.log('─'.repeat(65));
  console.log(' 순서 | 단계명           | Method | Endpoint');
  console.log('─'.repeat(65));
  for (const s of specs) {
    const ep  = s.pathname.replace('/api/buyproc/','').replace('/api/wireless/','');
    const st  = [...s.statuses].join(',') || '?';
    console.log(` [${String(s.stepOrder).padStart(2)}] ${s.stepName.padEnd(14)}  ${s.method.padEnd(6)}  ${ep}  (${st})`);
  }
  console.log('─'.repeat(65));
}

main();
