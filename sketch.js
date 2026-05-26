/* =============================================================
 * 臺北市雨量站即時監測 — p5.js + Mappa 地圖版
 * -------------------------------------------------------------
 * 【地圖】Mappa（mappa-mundi）+ Leaflet 圖磚地圖
 *        p5.js 畫布以 overlay 方式疊在地圖上方
 *
 * 【資料來源 1】臺北市水利處 OpenData（雨量值）
 *   https://wic.gov.taipei/OpenData/API/Rain/Get
 *     ?stationNo=&loginId=open_rain&dataKey=85452C1D
 *
 * 【資料來源 2】中央氣象署 CWA OpenData（站點經緯度 + 雨量）
 *   https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001
 *     ?Authorization=rdec-key-123-45678-011121314
 *   → 篩選 GeoInfo.CountyName === "臺北市"，取得所有臺北市測站，
 *     每站含 WGS84 經緯度（GeoInfo.Coordinates）。
 *
 * 【兩 API 如何整合】
 *   CWA API 提供「所有臺北市測站」的真實經緯度與即時雨量，
 *   作為地圖紅點的座標來源（每個點都有真實 lat/lng）。
 *   水利處 API 的雨量值再以「站名比對」方式疊加上去；
 *   若某站兩邊都有資料，以水利處數值為主、CWA 數值為輔。
 *
 * 【CORS 代理伺服器】
 *   兩個政府 API 都未開放 Access-Control-Allow-Origin，
 *   瀏覽器（localhost / 127.0.0.1）會被擋。解法是透過公共
 *   CORS 代理伺服器：代理以伺服器對伺服器方式取得資料，
 *   再補上 Access-Control-Allow-Origin: * 回傳給瀏覽器。
 *   本程式內建多個代理，依序嘗試，任一成功即採用。
 * ============================================================= */

/* ───────────── 常數設定 ───────────── */

// 資料來源 1：臺北市水利處雨量 API
const WIC_API_URL =
  'https://wic.gov.taipei/OpenData/API/Rain/Get' +
  '?stationNo=&loginId=open_rain&dataKey=85452C1D';

// 資料來源 2：中央氣象署 CWA 自動雨量站 API（含經緯度）
const CWA_API_URL =
  'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001' +
  '?Authorization=rdec-key-123-45678-011121314';

// 只取此縣市的測站（依 GeoInfo.CountyName 篩選，而非站名）
const TARGET_COUNTY = '臺北市';

// 公共 CORS 代理伺服器清單（依序嘗試）
const CORS_PROXIES = [
  { name: 'corsproxy.io',
    build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { name: 'allorigins.win',
    build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs.com',
    build: (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u) },
  { name: 'thingproxy',
    build: (u) => 'https://thingproxy.freeboard.io/fetch/' + u },
];

const REFRESH_INTERVAL = 300;   // 自動更新間隔（秒）
const FETCH_TIMEOUT_MS  = 10000; // 單一代理逾時（毫秒）

// 臺北市地圖中心與縮放
const MAP_CENTER = { lat: 25.067, lng: 121.55 };
const MAP_ZOOM   = 12;

// 雨量警戒等級（單位 mm）
const THRESHOLDS = [
  { min: 0,     max: 0.001, label: '無雨', color: [120, 140, 165] },
  { min: 0.001, max: 1,     label: '微雨', color: [0,   190, 255] },
  { min: 1,     max: 4,     label: '小雨', color: [0,   220, 130] },
  { min: 4,     max: 10,    label: '中雨', color: [255, 184, 0]   },
  { min: 10,    max: 20,    label: '大雨', color: [255, 107, 0]   },
  { min: 20,    max: 99999, label: '豪雨', color: [255, 30,  60]  },
];

/* ───────────── 全域狀態 ───────────── */

let mappa;            // Mappa 實例
let myMap;            // tileMap 物件
let canvas;           // p5 畫布

let stations = [];    // 整合後的測站陣列（含經緯度）
let isLoading = true;
let statusMessage = '初始化中…';
let lastUpdate = '';
let liveCount = { wic: 0, cwa: 0 }; // 各來源成功筆數
let countdown = REFRESH_INTERVAL;

let hoveredStation = null; // 目前 hover 的測站物件

/* =============================================================
 * p5.js 生命週期
 * ============================================================= */

function setup() {
  // 全螢幕畫布
  canvas = createCanvas(windowWidth, windowHeight);
  textFont('Noto Sans TC, sans-serif');

  // 建立 Mappa 地圖（Leaflet 圖磚），並把 p5 畫布疊上去
  mappa = new Mappa('Leaflet');
  const options = {
    lat: MAP_CENTER.lat,
    lng: MAP_CENTER.lng,
    zoom: MAP_ZOOM,
    // OpenStreetMap 圖磚
    style: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  };
  myMap = mappa.tileMap(options);
  myMap.overlay(canvas);

  // 地圖被拖動 / 縮放時，重畫一次（draw 為連續迴圈，此處僅確保即時）
  myMap.onChange(() => {});

  fetchAllData();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function draw() {
  clear(); // 透明背景，露出底下的 Leaflet 地圖

  if (isLoading && stations.length === 0) {
    drawLoadingOverlay();
  } else {
    drawStationDots();   // 在真實經緯度畫紅色圓點
    drawTooltip();       // hover 時顯示資料卡
  }

  drawHud(); // 頂部標題列 + 統計

  // 每秒處理倒數
  if (frameCount % 60 === 0 && !isLoading) {
    countdown--;
    if (countdown <= 0) {
      countdown = REFRESH_INTERVAL;
      fetchAllData();
    }
  }
}

/* =============================================================
 * 資料擷取：同時抓兩個 API，再整合
 * ============================================================= */

async function fetchAllData() {
  isLoading = true;
  statusMessage = '透過 CORS 代理伺服器連線中…';

  // 平行擷取兩個來源
  const [cwaRaw, wicRaw] = await Promise.all([
    fetchViaProxies(CWA_API_URL, 'CWA 氣象署'),
    fetchViaProxies(WIC_API_URL, '水利處'),
  ]);

  // ── 解析 CWA：取臺北市所有測站（含經緯度）──
  const cwaStations = parseCWA(cwaRaw);
  liveCount.cwa = cwaStations.length;

  // ── 解析水利處：站名 → 雨量 對照表 ──
  const wicMap = parseWIC(wicRaw); // Map(stationName -> {rain, recTime})
  liveCount.wic = wicMap.size;

  // ── 整合：以 CWA 臺北市測站為主體（保證有經緯度）──
  const merged = cwaStations.map((s) => {
    const wic = wicMap.get(s.stationName);
    return {
      stationName: s.stationName,
      stationId:   s.stationId,
      lat: s.lat,
      lng: s.lng,
      town: s.town,
      altitude: s.altitude,
      // 雨量：優先用水利處數值，否則用 CWA 數值
      rain: wic ? wic.rain : s.rain,
      rainSource: wic ? '水利處' : 'CWA',
      recTime: wic ? wic.recTime : s.recTime,
      cwaRain: s.rain, // 保留 CWA 原始值供對照
    };
  });

  if (merged.length > 0) {
    stations = merged.sort((a, b) => b.rain - a.rain);
    lastUpdate = nowStr();
    statusMessage =
      `LIVE｜CWA ${liveCount.cwa} 站（經緯度）` +
      `／水利處 ${liveCount.wic} 站（雨量比對）`;
  } else {
    // 兩邊都失敗 → 示範資料
    stations = loadDemoData();
    lastUpdate = nowStr() + '（示範）';
    statusMessage = 'DEMO 示範資料（API 連線失敗）';
  }
  isLoading = false;
}

/**
 * 依序嘗試每個公共 CORS 代理伺服器擷取指定 URL。
 * 回傳解析後的 JSON 物件；全部失敗回傳 null。
 */
async function fetchViaProxies(targetUrl, label) {
  for (const proxy of CORS_PROXIES) {
    try {
      const url = proxy.build(targetUrl);
      console.log(`🌐 [${label}] 嘗試代理 ${proxy.name}`);
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const json = JSON.parse(text);
      console.log(`✅ [${label}] 透過 ${proxy.name} 取得資料`);
      return json;
    } catch (err) {
      console.warn(`⚠️ [${label}] 代理 ${proxy.name} 失敗：${err.message}`);
    }
  }
  console.error(`❌ [${label}] 所有代理皆失敗`);
  return null;
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json, text/plain, */*' },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

/* ───────────── 解析 CWA 氣象署資料 ───────────── */

/**
 * 從 CWA O-A0002-001 取出「臺北市」所有測站。
 * 篩選條件：GeoInfo.CountyName === '臺北市'（依縣市，不是站名）。
 * 每站取 WGS84 經緯度。
 */
function parseCWA(raw) {
  if (!raw || !raw.records || !Array.isArray(raw.records.Station)) return [];

  return raw.records.Station
    // ★ 關鍵：以 CountyName 篩選臺北市，涵蓋全部臺北市測站
    .filter((s) => s.GeoInfo && s.GeoInfo.CountyName === TARGET_COUNTY)
    .map((s) => {
      // 取 WGS84 座標（若無則退而取第一組）
      const coords = s.GeoInfo.Coordinates || [];
      const wgs = coords.find((c) => c.CoordinateName === 'WGS84')
                  || coords[0] || {};
      const lat = parseFloat(wgs.StationLatitude);
      const lng = parseFloat(wgs.StationLongitude);

      // 即時雨量（RainfallElement.Now.Precipitation）
      let rain = 0;
      const re = s.RainfallElement;
      if (re && re.Now && re.Now.Precipitation !== undefined) {
        const v = parseFloat(re.Now.Precipitation);
        rain = (isNaN(v) || v < 0) ? 0 : v;
      }

      // 觀測時間
      let recTime = '';
      if (s.ObsTime && s.ObsTime.DateTime) {
        recTime = String(s.ObsTime.DateTime).replace('T', ' ').slice(0, 16);
      }

      return {
        stationName: String(s.StationName || '').trim(),
        stationId:   String(s.StationId || '').trim(),
        lat, lng,
        town:     (s.GeoInfo.TownName || '').trim(),
        altitude: parseFloat(s.GeoInfo.StationAltitude) || 0,
        rain, recTime,
      };
    })
    // 過濾掉經緯度無效的站
    .filter((s) => !isNaN(s.lat) && !isNaN(s.lng) && s.stationName !== '');
}

/* ───────────── 解析水利處資料 ───────────── */

/**
 * 把水利處 API 回傳整理成 Map：站名 → { rain, recTime }
 * 之後用站名與 CWA 測站比對。
 */
function parseWIC(raw) {
  const map = new Map();
  if (!Array.isArray(raw)) return map;

  raw.forEach((item) => {
    const name = String(item.stationName || '').trim();
    if (!name) return;
    let rain = parseFloat(item.rain);
    rain = (isNaN(rain) || rain < 0) ? 0 : rain;
    map.set(name, {
      rain,
      recTime: String(item.recTime || '').trim(),
    });
  });
  return map;
}

/* ───────────── 備用示範資料 ───────────── */

function loadDemoData() {
  // 臺北市代表性測站的真實 WGS84 座標
  const demo = [
    ['鞍部',   25.182586, 121.529731, '北投區', 25.5],
    ['陽明山', 25.162078, 121.544547, '北投區', 8.5],
    ['臺北',   25.037659, 121.514854, '中正區', 2.0],
    ['信義',   25.037,    121.565,    '信義區', 4.6],
    ['內湖',   25.079,    121.575,    '內湖區', 1.2],
    ['士林',   25.094,    121.526,    '士林區', 12.4],
    ['文山',   24.989,    121.570,    '文山區', 16.5],
    ['松山',   25.049,    121.577,    '松山區', 3.1],
  ];
  return demo.map(([name, lat, lng, town, rain]) => ({
    stationName: name, stationId: 'DEMO', lat, lng, town,
    altitude: 0, rain, rainSource: '示範', recTime: nowStr().slice(0, 16),
    cwaRain: rain,
  })).sort((a, b) => b.rain - a.rain);
}

/* =============================================================
 * 繪製：地圖上的紅色測站圓點
 * ============================================================= */

function drawStationDots() {
  hoveredStation = null;

  for (const s of stations) {
    // 經緯度 → 畫布像素座標
    const pos = myMap.latLngToPixel(s.lat, s.lng);

    // 圓點大小：依雨量略微放大（基本 9px，最大約 22px）
    const r = 9 + Math.min(s.rain, 30) / 30 * 13;

    // 是否被滑鼠指到
    const d = dist(mouseX, mouseY, pos.x, pos.y);
    const isHover = d < r + 3;
    if (isHover) hoveredStation = { ...s, px: pos.x, py: pos.y };

    // 外圈光暈（雨量越大越明顯）
    noStroke();
    if (s.rain > 0) {
      const lvl = getRainLevel(s.rain);
      fill(lvl.color[0], lvl.color[1], lvl.color[2], 45);
      const pulse = (sin(frameCount * 0.05) + 1) / 2;
      circle(pos.x, pos.y, r * 2 + pulse * 10);
    }

    // ★ 紅色圓點（依需求，標示點一律使用紅色）
    stroke(255);
    strokeWeight(isHover ? 2.5 : 1.5);
    fill(225, 30, 45); // 紅色
    circle(pos.x, pos.y, isHover ? r * 1.35 : r);

    // 雨量 > 0 時，在圓點旁標示數值
    if (s.rain > 0) {
      noStroke();
      fill(255);
      textSize(11);
      textAlign(LEFT, CENTER);
      textStyle(BOLD);
      text(s.rain.toFixed(1), pos.x + r + 4, pos.y);
      textStyle(NORMAL);
    }
  }

  // hover 中的點改變游標
  cursor(hoveredStation ? HAND : ARROW);
}

/* =============================================================
 * 繪製：hover 資料顯示卡（tooltip）
 * ============================================================= */

function drawTooltip() {
  if (!hoveredStation) return;
  const s = hoveredStation;
  const lvl = getRainLevel(s.rain);

  // 卡片內容
  const lines = [
    { t: s.stationName + '  雨量站', size: 15, c: [255, 255, 255], bold: true },
    { t: '所在區域：' + (s.town || '—'), size: 12, c: [180, 200, 220] },
    { t: '即時雨量：' + s.rain.toFixed(1) + ' mm（' + lvl.label + '）',
      size: 13, c: lvl.color, bold: true },
    { t: '雨量來源：' + s.rainSource, size: 11, c: [150, 170, 195] },
    { t: '經緯度：' + s.lat.toFixed(5) + ', ' + s.lng.toFixed(5),
      size: 11, c: [150, 170, 195] },
    { t: '海拔：' + s.altitude.toFixed(0) + ' m', size: 11, c: [150, 170, 195] },
    { t: '觀測時間：' + (s.recTime || '—'), size: 11, c: [130, 150, 175] },
    { t: '站碼：' + s.stationId, size: 11, c: [130, 150, 175] },
  ];

  // 量測卡片尺寸
  const pad = 12, lineGap = 6;
  let cardW = 0, cardH = pad * 2;
  textStyle(NORMAL);
  for (const ln of lines) {
    textSize(ln.size);
    cardW = Math.max(cardW, textWidth(ln.t));
    cardH += ln.size + lineGap;
  }
  cardW += pad * 2;

  // 卡片位置（避免超出畫面邊界）
  let cx = s.px + 18;
  let cy = s.py + 18;
  if (cx + cardW > width)  cx = s.px - cardW - 18;
  if (cy + cardH > height) cy = height - cardH - 10;
  if (cy < 0) cy = 10;

  // 卡片底
  noStroke();
  fill(12, 18, 34, 240);
  rect(cx, cy, cardW, cardH, 10);
  // 左側等級色條
  fill(...lvl.color);
  rect(cx, cy, 4, cardH, 10, 0, 0, 10);

  // 連接線（從圓點拉到卡片）
  stroke(255, 255, 255, 120);
  strokeWeight(1);
  line(s.px, s.py, cx, cy + 14);

  // 文字
  noStroke();
  textAlign(LEFT, TOP);
  let ty = cy + pad;
  for (const ln of lines) {
    textSize(ln.size);
    textStyle(ln.bold ? BOLD : NORMAL);
    fill(...ln.c);
    text(ln.t, cx + pad, ty);
    ty += ln.size + lineGap;
  }
  textStyle(NORMAL);
}

/* =============================================================
 * 繪製：頂部 HUD（標題 + 統計 + 圖例）
 * ============================================================= */

function drawHud() {
  // 頂部半透明面板
  noStroke();
  fill(8, 13, 26, 230);
  rect(0, 0, width, 64);

  // 標題
  fill(235, 242, 250);
  textAlign(LEFT, CENTER);
  textSize(19);
  textStyle(BOLD);
  text('臺北市雨量站即時監測 — 地圖視覺化', 20, 22);
  textStyle(NORMAL);

  // 副標
  fill(140, 160, 185);
  textSize(11);
  text('地圖：Mappa + Leaflet ／ 經緯度：CWA 氣象署（臺北市）／ 雨量：水利處 OpenData',
       20, 44);

  // 統計（右側）
  if (stations.length > 0) {
    const total = stations.length;
    const raining = stations.filter((s) => s.rain > 0).length;
    const alert = stations.filter((s) => s.rain >= 10).length;
    const maxS = stations.reduce((m, s) => (s.rain > m.rain ? s : m), stations[0]);

    textAlign(RIGHT, CENTER);
    fill(150, 170, 195);
    textSize(11);
    text(`測站 ${total}　降雨中 ${raining}　警戒 ${alert}　` +
         `最大 ${maxS.stationName} ${maxS.rain.toFixed(1)}mm`,
         width - 20, 18);
    fill(120, 140, 165);
    text(`最後更新 ${lastUpdate}　下次更新 ${countdown}s`, width - 20, 40);
    textAlign(LEFT, CENTER);
  }

  // 底部圖例
  drawLegend();

  // 載入中提示
  if (isLoading) {
    fill(0, 200, 255);
    textAlign(RIGHT, CENTER);
    textSize(11);
    text('● 更新中…', width - 20, 40);
    textAlign(LEFT, CENTER);
  }
}

function drawLegend() {
  const legendItems = THRESHOLDS.slice(1); // 去掉「無雨」
  const boxW = 150, lineH = 22;
  const boxH = legendItems.length * lineH + 36;
  const x = 16, y = height - boxH - 16;

  noStroke();
  fill(8, 13, 26, 230);
  rect(x, y, boxW, boxH, 8);

  fill(200, 215, 230);
  textSize(12);
  textStyle(BOLD);
  textAlign(LEFT, CENTER);
  text('雨量等級', x + 12, y + 18);
  textStyle(NORMAL);

  legendItems.forEach((t, i) => {
    const ly = y + 36 + i * lineH;
    fill(t.color[0], t.color[1], t.color[2]);
    circle(x + 18, ly, 12);
    fill(180, 195, 210);
    textSize(11);
    const range = (t.max > 999)
      ? `≥ ${t.min}` : `${t.min} ~ ${t.max}`;
    text(`${t.label}　${range} mm`, x + 32, ly);
  });

  // 提示
  fill(120, 140, 165);
  textSize(10);
  text('紅點 = 雨量站；滑鼠移上可看詳細資料', x, y - 8);
}

/* =============================================================
 * 載入動畫
 * ============================================================= */

function drawLoadingOverlay() {
  push();
  textAlign(CENTER, CENTER);
  const cx = width / 2, cy = height / 2;

  for (let i = 0; i < 12; i++) {
    const ang = frameCount * 0.05 + i * TWO_PI / 12;
    fill(0, 200, 255, map(i, 0, 12, 40, 255));
    noStroke();
    circle(cx + cos(ang) * 24, cy + sin(ang) * 24, 7);
  }
  fill(235, 242, 250);
  textSize(15);
  text('載入臺北市雨量站資料中…', cx, cy + 56);
  fill(150, 170, 195);
  textSize(12);
  text(statusMessage, cx, cy + 80);
  pop();
}

/* =============================================================
 * 互動 + 工具
 * ============================================================= */

function mousePressed() {
  // 點擊頂部面板右側（重新整理熱區）
  if (mouseY < 64 && mouseX > width - 220 && !isLoading) {
    countdown = REFRESH_INTERVAL;
    fetchAllData();
  }
}

function getRainLevel(mm) {
  for (const t of THRESHOLDS) {
    if (mm >= t.min && mm < t.max) return t;
  }
  return THRESHOLDS[THRESHOLDS.length - 1];
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}