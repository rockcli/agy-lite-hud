(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.__agCsUsageCore = exported;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const HOME_HEAT_WEEKS = 26;
  const HOME_HEAT_RAMP = [8, 28, 52, 76, 100];
  const HOME_HEAT_STEPS = HOME_HEAT_RAMP.length;
  const HOME_CHART_DAYS = 30;
  const HOME_MODEL_ROWS = 6;
  const HOME_MODEL_COLOUR_COUNT = 10;

  function resolveLang(langOrZh) {
    if (langOrZh === true) return 'zh-CN';
    if (langOrZh === false || langOrZh === null) return 'en';
    if (langOrZh === 'zh-TW' || langOrZh === 'yue' || langOrZh === 'en' || langOrZh === 'ja') return langOrZh;
    return 'zh-CN';
  }

  function pickByLang(map, langOrZh, fallback = '') {
    const l = resolveLang(langOrZh);
    if (!map) return fallback;
    if (map[l] !== undefined) return map[l];
    if (l === 'yue' && map['zh-TW'] !== undefined) return map['zh-TW'];
    return map['zh-CN'] !== undefined ? map['zh-CN'] : (map.en !== undefined ? map.en : fallback);
  }

  const HOME_RANGES = [
    { id: 'all', days: 0, labelZh: '全部', labelEn: 'All', labels: { 'zh-CN': '全部', 'zh-TW': '全部', yue: '全部', en: 'All', ja: '全期間' } },
    { id: '30d', days: 30, labelZh: '30 天', labelEn: '30d', labels: { 'zh-CN': '30 天', 'zh-TW': '30 天', yue: '30 日', en: '30d', ja: '30日間' } },
    { id: '7d', days: 7, labelZh: '7 天', labelEn: '7d', labels: { 'zh-CN': '7 天', 'zh-TW': '7 天', yue: '7 日', en: '7d', ja: '7日間' } },
  ];

  // Book yardsticks matched by token count (measured via o200k_base in dsh-claude-style).
  const HOME_BOOKS = [
    { key: 'tao', tokens: 7607, zh: '《道德经》', zhTW: '《道德經》', ja: '『老子（道徳経）』', en: 'Tao Te Ching' },
    { key: 'yellow', tokens: 7778, zh: '《黄色壁纸》', zhTW: '《黃色壁紙》', ja: '『黄色い壁紙』', en: 'The Yellow Wallpaper' },
    { key: 'meta', tokens: 27557, zh: '《变形记》', zhTW: '《變形記》', ja: '『変身』', en: 'Metamorphosis' },
    { key: 'jekyll', tokens: 34713, zh: '《化身博士》', zhTW: '《化身博士》', ja: '『ジーキル博士とハイド氏』', en: 'The Strange Case of Dr Jekyll and Mr Hyde' },
    { key: 'alice', tokens: 37248, zh: '《爱丽丝漫游奇境》', zhTW: '《愛麗絲夢遊仙境》', ja: '『不思議の国のアリス』', en: "Alice's Adventures in Wonderland" },
    { key: 'animal', tokens: 39000, zh: '《动物农场》', zhTW: '《動物農莊》', ja: '『動物農場』', en: 'Animal Farm' },
    { key: 'carol', tokens: 40306, zh: '《圣诞颂歌》', zhTW: '《小氣財神》', yue: '《聖誕頌歌》', ja: '『クリスマス・キャロル』', en: 'A Christmas Carol' },
    { key: 'wild', tokens: 42383, zh: '《野性的呼唤》', zhTW: '《野性的呼喚》', ja: '『野生の呼び声』', en: 'The Call of the Wild' },
    { key: 'time', tokens: 42817, zh: '《时间机器》', zhTW: '《時間機器》', ja: '『タイム・マシン』', en: 'The Time Machine' },
    { key: 'oz', tokens: 51004, zh: '《绿野仙踪》', zhTW: '《綠野仙蹤》', ja: '『オズの魔法使い』', en: 'The Wonderful Wizard of Oz' },
    { key: 'darkness', tokens: 52163, zh: '《黑暗之心》', zhTW: '《黑暗之心》', ja: '『闇の奥』', en: 'Heart of Darkness' },
    { key: 'faust', tokens: 53930, zh: '《浮士德》', zhTW: '《浮士德》', ja: '『ファウスト』', en: 'Faust' },
    { key: 'screw', tokens: 57484, zh: '《螺丝在拧紧》', zhTW: '《碧廬冤孽》', ja: '『ねじの回転』', en: 'The Turn of the Screw' },
    { key: 'aesop', tokens: 60707, zh: '《伊索寓言》', zhTW: '《伊索寓言》', ja: '『イソップ寓話』', en: "Aesop's Fables" },
    { key: 'peter', tokens: 63821, zh: '《彼得·潘》', zhTW: '《小飛俠彼得潘》', ja: '『ピーター・パン』', en: 'Peter Pan' },
    { key: 'gatsby', tokens: 65763, zh: '《了不起的盖茨比》', zhTW: '《大亨小傳》', ja: '『グレート・ギャツビー』', en: 'The Great Gatsby' },
    { key: 'prince', tokens: 66670, zh: '《君主论》', zhTW: '《君王論》', ja: '『君主論』', en: 'The Prince' },
    { key: 'invisible', tokens: 68163, zh: '《隐形人》', zhTW: '《隱形人》', ja: '『透明人間』', en: 'The Invisible Man' },
    { key: 'andersen', tokens: 73931, zh: '《安徒生童话》', zhTW: '《安徒生童話》', ja: '『アンデルセン童話集』', en: "Andersen's Fairy Tales" },
    { key: 'worlds', tokens: 80168, zh: '《世界大战》', zhTW: '《世界大戰》', ja: '『宇宙戦争』', en: 'The War of the Worlds' },
    { key: 'beyond', tokens: 89836, zh: '《善恶的彼岸》', zhTW: '《善惡的彼岸》', ja: '『善悪の彼岸』', en: 'Beyond Good and Evil' },
    { key: 'whitefang', tokens: 96418, zh: '《白牙》', zhTW: '《白牙》', ja: '『白い牙』', en: 'White Fang' },
    { key: 'meditations', tokens: 96973, zh: '《沉思录》', zhTW: '《沉思錄》', ja: '『自省録』', en: 'Meditations' },
    { key: 'frankenstein', tokens: 97886, zh: '《弗兰肯斯坦》', zhTW: '《科學怪人》', ja: '『フランケンシュタイン』', en: 'Frankenstein' },
    { key: 'stone', tokens: 100000, zh: '《哈利·波特与魔法石》', zhTW: '《哈利波特：神秘的魔法石》', ja: '『ハリー・ポッターと賢者の石』', en: "Harry Potter and the Philosopher's Stone" },
    { key: 'dorian', tokens: 106339, zh: '《道林·格雷的画像》', zhTW: '《格雷的畫像》', ja: '『ドリアン・グレイの肖像』', en: 'The Picture of Dorian Gray' },
    { key: 'tolive', tokens: 115000, zh: '《活着》', zhTW: '《活著》', ja: '『生きる』', en: 'To Live' },
    { key: 'hobbit', tokens: 123000, zh: '《霍比特人》', zhTW: '《哈比人歷險記》', yue: '《哈比人》', ja: '『ホビットの冒険』', en: 'The Hobbit' },
    { key: 'grimm', tokens: 132467, zh: '《格林童话》', zhTW: '《格林童話》', ja: '『グリム童話集』', en: "Grimms' Fairy Tales" },
    { key: '1984', tokens: 136278, zh: '《一九八四》', zhTW: '《一九八四》', ja: '『1984年』', en: 'Nineteen Eighty-Four' },
    { key: 'sherlock', tokens: 138725, zh: '《福尔摩斯冒险史》', zhTW: '《福爾摩斯冒險史》', ja: '『シャーロック・ホームズの冒険』', en: 'The Adventures of Sherlock Holmes' },
    { key: 'gulliver', tokens: 138958, zh: '《格列佛游记》', zhTW: '《格列佛遊記》', ja: '『ガリヴァー旅行記』', en: "Gulliver's Travels" },
    { key: 'walden', tokens: 152659, zh: '《瓦尔登湖》', zhTW: '《湖濱散記》', ja: '『ウォールデン 森の生活』', en: 'Walden' },
    { key: 'crusoe', tokens: 153596, zh: '《鲁滨逊漂流记》', zhTW: '《魯賓遜漂流記》', ja: '『ロビンソン・クルーソー』', en: 'Robinson Crusoe' },
    { key: 'huck', tokens: 154263, zh: '《哈克贝利·费恩历险记》', zhTW: '《頑童歷險記》', ja: '『ハックルベリー・フィンの冒険』', en: 'Adventures of Huckleberry Finn' },
    { key: 'divine', tokens: 157765, zh: '《神曲》', zhTW: '《神曲》', ja: '『神曲』', en: 'The Divine Comedy' },
    { key: 'bovary', tokens: 159575, zh: '《包法利夫人》', zhTW: '《包法利夫人》', ja: '『ボヴァリー夫人』', en: 'Madame Bovary' },
    { key: 'zarathustra', tokens: 161488, zh: '《查拉图斯特拉如是说》', zhTW: '《查拉圖斯特拉如是說》', ja: '『ツァラトゥストラはこう語った』', en: 'Thus Spoke Zarathustra' },
    { key: 'pride', tokens: 171701, zh: '《傲慢与偏见》', zhTW: '《傲慢與偏見》', ja: '『高慢と偏見』', en: 'Pride and Prejudice' },
    { key: 'odyssey', tokens: 173150, zh: '《奥德赛》', zhTW: '《奧德賽》', ja: '『オデュッセイア』', en: 'The Odyssey' },
    { key: 'twocities', tokens: 187333, zh: '《双城记》', zhTW: '《雙城記》', ja: '『二都物語』', en: 'A Tale of Two Cities' },
    { key: 'threebody', tokens: 202000, zh: '《三体》', zhTW: '《三體》', ja: '『三体』', en: 'The Three-Body Problem' },
    { key: 'dracula', tokens: 213648, zh: '《德古拉》', zhTW: '《德古拉》', ja: '『ドラキュラ』', en: 'Dracula' },
    { key: 'expectations', tokens: 252176, zh: '《远大前程》', zhTW: '《孤星血淚》', ja: '『大いなる遺産』', en: 'Great Expectations' },
    { key: 'janeeyre', tokens: 256179, zh: '《简·爱》', zhTW: '《簡·愛》', ja: '『ジェイン・エア』', en: 'Jane Eyre' },
    { key: 'republic', tokens: 279539, zh: '《理想国》', zhTW: '《理想國》', ja: '『国家』', en: 'The Republic' },
    { key: 'crime', tokens: 285009, zh: '《罪与罚》', zhTW: '《罪與罰》', ja: '『罪と罰』', en: 'Crime and Punishment' },
    { key: 'leviathan', tokens: 304696, zh: '《利维坦》', zhTW: '《利維坦》', ja: '『リヴァイアサン』', en: 'Leviathan' },
    { key: 'moby', tokens: 306522, zh: '《白鲸》', zhTW: '《白鯨記》', ja: '『白鯨』', en: 'Moby-Dick' },
    { key: 'darkforest', tokens: 307000, zh: '《三体Ⅱ·黑暗森林》', zhTW: '《三體Ⅱ·黑暗森林》', ja: '『三体II 黒暗森林』', en: 'The Dark Forest' },
    { key: 'deathsend', tokens: 336000, zh: '《三体Ⅲ·死神永生》', zhTW: '《三體Ⅲ·死神永生》', ja: '『三体III 死神永生』', en: "Death's End" },
    { key: 'anna', tokens: 481659, zh: '《安娜·卡列尼娜》', zhTW: '《安娜·卡列尼娜》', ja: '『アンナ・カレーニナ』', en: 'Anna Karenina' },
    { key: 'karamazov', tokens: 487590, zh: '《卡拉马佐夫兄弟》', zhTW: '《卡拉馬佐夫兄弟》', ja: '『カラマーゾフの兄弟』', en: 'The Brothers Karamazov' },
    { key: 'quixote', tokens: 574243, zh: '《堂吉诃德》', zhTW: '《唐吉訶德》', ja: '『ドン・キホーテ』', en: 'Don Quixote' },
    { key: 'lotr', tokens: 625000, zh: '《魔戒》', zhTW: '《魔戒》', ja: '『指輪物語』', en: 'The Lord of the Rings' },
    { key: 'kingdoms', tokens: 638009, zh: '《三国演义》', zhTW: '《三國演義》', ja: '『三国志演義』', en: 'Romance of the Three Kingdoms' },
    { key: 'montecristo', tokens: 651128, zh: '《基督山伯爵》', zhTW: '《基督山恩仇記》', ja: '『モンテ・クリスト伯』', en: 'The Count of Monte Cristo' },
    { key: 'warpeace', tokens: 769001, zh: '《战争与和平》', zhTW: '《戰爭與和平》', ja: '『戦争と平和』', en: 'War and Peace' },
    { key: 'journeywest', tokens: 783200, zh: '《西游记》', zhTW: '《西遊記》', ja: '『西遊記』', en: 'Journey to the West' },
    { key: 'miserables', tokens: 801791, zh: '《悲惨世界》', zhTW: '《悲慘世界》', yue: '《孤星淚》', ja: '『レ・ミゼラブル』', en: 'Les Misérables' },
    { key: 'redchamber', tokens: 903956, zh: '《红楼梦》', zhTW: '《紅樓夢》', ja: '『紅楼夢』', en: 'Dream of the Red Chamber' },
    { key: 'watermargin', tokens: 958242, zh: '《水浒传》', zhTW: '《水滸傳》', ja: '『水滸伝』', en: 'Water Margin' },
    { key: 'ordinary', tokens: 998000, zh: '《平凡的世界》', zhTW: '《平凡的世界》', ja: '『平凡な世界』', en: 'Ordinary World' },
    { key: 'harrypotter', tokens: 1409000, zh: '《哈利·波特》全集', zhTW: '《哈利波特》全集', ja: '『ハリー・ポッター』全巻', en: 'the whole Harry Potter series' },
    { key: 'losttime', tokens: 1647000, zh: '《追忆似水年华》', zhTW: '《追憶似水年華》', ja: '『失われた時を求めて』', en: 'In Search of Lost Time' },
  ];

  function homeBookTitle(book, langOrZh) {
    if (!book) return '';
    const l = resolveLang(langOrZh);
    if (l === 'en') return book.en;
    if (l === 'ja') return book.ja || book.en;
    if (l === 'yue') return book.yue || book.zhTW || book.zh;
    if (l === 'zh-TW') return book.zhTW || book.zh;
    return book.zh;
  }

  function homeRangeLabel(rangeOrId, langOrZh) {
    const r = typeof rangeOrId === 'string' ? (HOME_RANGES.find((x) => x.id === rangeOrId) || HOME_RANGES[0]) : rangeOrId;
    if (!r) return '';
    return pickByLang(r.labels, langOrZh, r.labelZh);
  }

  function pad2(v) {
    return v < 10 ? '0' + v : String(v);
  }

  function homeDayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function homeRangeStart(windowDays, nowDate) {
    if (!windowDays) return null;
    const start = nowDate ? new Date(nowDate.getTime()) : new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (windowDays - 1));
    return homeDayKey(start);
  }

  function formatHomeCount(count) {
    const value = Math.round(Number(count) || 0);
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatCompactTokens(count) {
    const value = Number(count) || 0;
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    for (let u = 0; u < units.length; u++) {
      const scaled = Math.round((value / units[u][0]) * 10) / 10;
      if (scaled >= 1) return String(scaled) + units[u][1];
    }
    return String(Math.round(value));
  }

  function formatHomeHour(hour, langOrZh) {
    const h = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const l = resolveLang(langOrZh);
    if (l === 'zh-CN') return (h < 12 ? '上午 ' : '下午 ') + h12 + ' 点';
    if (l === 'zh-TW') return (h < 12 ? '上午 ' : '下午 ') + h12 + ' 點';
    if (l === 'yue') return (h < 12 ? '上晝 ' : '下晝 ') + h12 + ' 點';
    if (l === 'ja') return (h < 12 ? '午前 ' : '午後 ') + h12 + ' 時';
    return h12 + (h < 12 ? ' AM' : ' PM');
  }

  function homeShortDateFormat(langOrZh) {
    const map = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', yue: 'zh-HK', en: 'en-US', ja: 'ja-JP' };
    return new Intl.DateTimeFormat(map[resolveLang(langOrZh)] || 'en-US', { month: 'short', day: 'numeric' });
  }

  function homeShortDate(format, day) {
    const parts = String(day || '').split('-');
    if (parts.length !== 3) return String(day || '');
    return format.format(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    const sec = Number(ts.seconds || 0);
    const nanos = Number(ts.nanos || 0);
    return sec > 0 ? sec * 1000 + Math.floor(nanos / 1e6) : 0;
  }

  function cleanModelName(val) {
    const raw = String(val?.modelDisplayName || val?.responseModel || (val?.model ? 'Model #' + val.model : 'unknown')).trim();
    return raw || 'unknown';
  }

  function isSubagentSummary(summary) {
    if (!summary || typeof summary !== 'object') return false;
    const meta = summary.trajectoryMetadata || {};
    return Boolean(meta.parentConversationId) || Number(meta.nestingDepth || 0) > 0;
  }

  // Extract a compact, JSON-serializable per-conversation usage record for caching.
  function analyzeTrajectoryForUsage(trajObj, summaryObj, cascadeId) {
    const t = trajObj?.response?.trajectory || trajObj?.trajectory || trajObj || {};
    const steps = Array.isArray(t.steps) ? t.steps : [];
    const gmList = Array.isArray(t.generatorMetadata) ? t.generatorMetadata : [];
    const stepTime = new Map();
    for (let i = 0; i < steps.length; i++) {
      const ms = tsToMs(steps[i]?.metadata?.createdAt);
      if (ms > 0) stepTime.set(i, ms);
    }
    const fallbackMs =
      tsToMs(summaryObj?.lastModifiedTime) ||
      tsToMs(summaryObj?.createdTime) ||
      tsToMs(t?.metadata?.createdAt) ||
      0;

    const days = {}; // YYYY-MM-DD -> { calls, input, output, cacheRead, cacheWrite, total, hours: number[24], models: { [id]: { input, output, cacheRead, cacheWrite, total, calls } } }
    let calls = 0;

    for (let i = 0; i < gmList.length; i++) {
      const val = gmList[i]?.metadata?.value;
      if (!val) continue;
      const u = val.usage || val.retryInfos?.[val.retryInfos.length - 1]?.usage;
      if (!u) continue;
      const input = Number(u.inputTokens || 0);
      const cacheRead = Number(u.cacheReadTokens || 0);
      const cacheWrite = Number(u.cacheWriteTokens || 0);
      const output = Number(u.outputTokens || 0);
      const total = input + cacheRead + cacheWrite + output;
      if (total <= 0 && input === 0 && output === 0) continue;

      calls += 1;
      const sIndices = Array.isArray(gmList[i].stepIndices) ? gmList[i].stepIndices : [];
      let ts = 0;
      for (let k = 0; k < sIndices.length; k++) {
        const hit = stepTime.get(sIndices[k]);
        if (hit) {
          ts = hit;
          break;
        }
      }
      if (!ts) ts = fallbackMs;
      if (!ts) continue;

      const d = new Date(ts);
      const dayKey = homeDayKey(d);
      const hour = d.getHours();
      const modelId = cleanModelName(val);

      let day = days[dayKey];
      if (!day) {
        day = {
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          hours: new Array(24).fill(0),
          models: {},
        };
        days[dayKey] = day;
      }
      day.calls += 1;
      day.input += input;
      day.output += output;
      day.cacheRead += cacheRead;
      day.cacheWrite += cacheWrite;
      day.total += total;
      day.hours[hour] = (day.hours[hour] || 0) + 1;

      let mod = day.models[modelId];
      if (!mod) {
        mod = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 };
        day.models[modelId] = mod;
      }
      mod.input += input;
      mod.output += output;
      mod.cacheRead += cacheRead;
      mod.cacheWrite += cacheWrite;
      mod.total += total;
      mod.calls += 1;
    }

    return {
      cascadeId: String(cascadeId || t.cascadeId || ''),
      stepCount: Number(summaryObj?.stepCount ?? steps.length ?? 0),
      lastModifiedSec: Number(summaryObj?.lastModifiedTime?.seconds || 0),
      subagent: isSubagentSummary(summaryObj),
      calls,
      days,
    };
  }

  function homeHeatGrid(dayTotalsMap, nowDate) {
    const today = nowDate ? new Date(nowDate.getTime()) : new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (HOME_HEAT_WEEKS * 7 - 1));
    start.setDate(start.getDate() - start.getDay());
    const cells = [];
    let peak = 0;
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const key = homeDayKey(cursor);
      const tokens = Number(dayTotalsMap[key] || 0);
      if (tokens > peak) peak = tokens;
      cells.push({ date: key, tokens, level: 0 });
    }
    for (let c = 0; c < cells.length; c++) {
      if (cells[c].tokens <= 0 || peak <= 0) continue;
      cells[c].level = Math.max(1, Math.min(HOME_HEAT_STEPS, Math.ceil((cells[c].tokens / peak) * HOME_HEAT_STEPS)));
    }
    return { cells, peak };
  }

  function aggregateUsageRollup(records, rangeId, bookPick, zh, nowDate) {
    const list = Array.isArray(records) ? records : [];
    const rangeObj = HOME_RANGES.find((r) => r.id === rangeId) || HOME_RANGES[0];
    const start = homeRangeStart(rangeObj.days, nowDate);
    const inRange = (dateStr) => start === null || dateStr >= start;

    let totalTokens = 0;
    let totalCalls = 0;
    const sessionSet = new Set();
    const activeDaySet = new Set();
    const hourCounts = new Array(24).fill(0);
    const modelTotals = {}; // modelId -> { id, input, output, cacheRead, cacheWrite, tokens, calls, sessions: Set }
    const allDayTotals = {}; // full calendar day -> tokens (heat grid shows 26 weeks always)
    const allDayModels = {}; // full calendar day -> { modelId: tokens } (chart shows 30d/7d)

    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (!rec || !rec.days) continue;
      let countedSessionInRange = false;
      const dayKeys = Object.keys(rec.days);
      for (let d = 0; d < dayKeys.length; d++) {
        const dk = dayKeys[d];
        const day = rec.days[dk];
        if (!day) continue;
        const dTotal = Number(day.total || 0);
        allDayTotals[dk] = (allDayTotals[dk] || 0) + dTotal;

        if (day.models) {
          if (!allDayModels[dk]) allDayModels[dk] = {};
          for (const [mId, mData] of Object.entries(day.models)) {
            allDayModels[dk][mId] = (allDayModels[dk][mId] || 0) + Number(mData.total || 0);
          }
        }

        if (!inRange(dk)) continue;
        if (dTotal > 0 || (day.calls || 0) > 0) {
          activeDaySet.add(dk);
          if (!rec.subagent && !countedSessionInRange) {
            sessionSet.add(rec.cascadeId || String(i));
            countedSessionInRange = true;
          }
        }
        totalTokens += dTotal;
        totalCalls += Number(day.calls || 0);
        if (Array.isArray(day.hours)) {
          for (let h = 0; h < 24; h++) {
            hourCounts[h] += Number(day.hours[h] || 0);
          }
        }
        if (day.models) {
          for (const [mId, mData] of Object.entries(day.models)) {
            let entry = modelTotals[mId];
            if (!entry) {
              entry = {
                id: mId,
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                tokens: 0,
                calls: 0,
                sessionsSet: new Set(),
              };
              modelTotals[mId] = entry;
            }
            entry.input += Number(mData.input || 0);
            entry.output += Number(mData.output || 0);
            entry.cacheRead += Number(mData.cacheRead || 0);
            entry.cacheWrite += Number(mData.cacheWrite || 0);
            entry.tokens += Number(mData.total || 0);
            entry.calls += Number(mData.calls || 0);
            if (!rec.subagent) entry.sessionsSet.add(rec.cascadeId || String(i));
          }
        }
      }
    }

    let bestHour = 0;
    let hourSum = 0;
    for (let h = 0; h < 24; h++) {
      hourSum += hourCounts[h];
      if (hourCounts[h] > hourCounts[bestHour]) bestHour = h;
    }
    const peakHour = hourSum > 0 ? formatHomeHour(bestHour, zh) : null;

    const models = Object.values(modelTotals)
      .map((m) => ({
        id: m.id,
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        tokens: m.tokens,
        calls: m.calls,
        sessions: m.sessionsSet.size,
      }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.id.localeCompare(b.id));

    const favModel = models.length > 0 ? models[0].id : null;

    // Book comparison
    let funBook = null;
    if (totalTokens > 0) {
      const pick = typeof bookPick === 'number' && Number.isFinite(bookPick) ? Math.max(0, Math.min(0.999999, bookPick)) : 0.07;
      let idx = Math.min(HOME_BOOKS.length - 1, Math.floor(pick * HOME_BOOKS.length));
      while (idx >= 0 && totalTokens < HOME_BOOKS[idx].tokens) idx -= 1;
      if (idx >= 0) {
        const book = HOME_BOOKS[idx];
        const count = Math.max(1, Math.round(totalTokens / book.tokens));
        const l = resolveLang(zh);
        const title = homeBookTitle(book, l);
        const cntStr = formatHomeCount(count);
        if (l === 'zh-CN') funBook = `你的 Token 用量相当于 ${cntStr} 本${title}。`;
        else if (l === 'zh-TW') funBook = `您的 Token 用量相當於 ${cntStr} 本${title}。`;
        else if (l === 'yue') funBook = `你用咗嘅 Token 相當於 ${cntStr} 本${title}。`;
        else if (l === 'ja') funBook = `消費トークン数は${title} ${cntStr} 冊分に相当します。`;
        else funBook = `You've used ~${cntStr}× the tokens in ${title}.`;
      }
    }

    // Chart columns (last 30d or 7d)
    const chartSpan = rangeObj.days > 0 && rangeObj.days < HOME_CHART_DAYS ? rangeObj.days : HOME_CHART_DAYS;
    const chartStart = homeRangeStart(chartSpan, nowDate);
    const modelDays = Object.keys(allDayModels)
      .filter((dk) => dk >= chartStart)
      .sort()
      .map((dk) => ({ date: dk, models: allDayModels[dk] }));

    return {
      sessions: sessionSet.size,
      calls: totalCalls,
      tokens: totalTokens,
      activeDays: activeDaySet.size,
      peakHour,
      model: favModel,
      grid: homeHeatGrid(allDayTotals, nowDate),
      funBook,
      models,
      modelDays,
    };
  }

  function axisMax(peak) {
    if (!(peak > 0)) return 0;
    const magnitude = Math.pow(10, Math.floor(Math.log(peak) / Math.LN10));
    const scaled = peak / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function homeChartTicks(widths, axisWidth, gap = 8, columnGap = 2) {
    const count = widths.length;
    if (count === 0 || !(axisWidth > 0)) return [];
    const column = (axisWidth - columnGap * (count - 1)) / count;
    if (!(column > 0)) return [];
    let widest = 0;
    for (let i = 0; i < count; i++) {
      if (widths[i] > widest) widest = widths[i];
    }
    const edgeShift = Math.max(0, widest / 2 - column / 2);
    let step = 1;
    while (step < count && step * (column + columnGap) < widest + gap + edgeShift) step += 1;
    const boxes = [];
    for (let i = count - 1; i >= 0; i -= step) {
      const width = widths[i];
      const centre = i * (column + columnGap) + column / 2;
      const left = Math.min(Math.max(centre - width / 2, 0), Math.max(axisWidth - width, 0));
      boxes.unshift({ index: i, left });
    }
    const kept = [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      const next = kept[0];
      if (next === undefined || box.left + widths[box.index] + gap <= next.left) kept.unshift(box);
    }
    return kept;
  }

  function createHomeModelColours() {
    const assigned = new Map();
    function preferred(id) {
      let hash = 2166136261;
      for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
      return (hash >>> 0) % HOME_MODEL_COLOUR_COUNT;
    }
    return function assign(ids) {
      const unique = Array.from(new Set(ids)).sort();
      const out = {};
      for (let i = 0; i < unique.length; i++) {
        const id = unique[i];
        if (assigned.has(id)) {
          out[id] = assigned.get(id);
          continue;
        }
        const used = new Set(assigned.values());
        let colour = preferred(id);
        while (used.size < HOME_MODEL_COLOUR_COUNT && used.has(colour)) {
          colour = (colour + 1) % HOME_MODEL_COLOUR_COUNT;
        }
        assigned.set(id, colour);
        out[id] = colour;
      }
      return out;
    };
  }

  function durSec(d) {
    if (!d) return 0;
    return Number(d.seconds || 0) + Number(d.nanos || 0) / 1e9;
  }

  function tsSec(ts) {
    if (!ts) return 0;
    return Number(ts.seconds || 0) + Number(ts.nanos || 0) / 1e9;
  }

  function fmtK(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  function fmtInt(n) {
    return (Number(n) || 0).toLocaleString();
  }

  function fmtPct(p, digits = 1) {
    const v = Number(p) || 0;
    return v.toFixed(digits) + '%';
  }

  function fmtSec(s) {
    const v = Number(s) || 0;
    if (v <= 0) return '—';
    if (v < 1) return Math.round(v * 1000) + 'ms';
    return v.toFixed(1) + 's';
  }

  function fmtResetTime(tsSeconds, langOrZh, nowSec) {
    const now = typeof nowSec === 'number' ? nowSec : Date.now() / 1000;
    const sec = Number(tsSeconds || 0) - now;
    const l = resolveLang(langOrZh);
    if (sec <= 0) {
      return pickByLang({ 'zh-CN': '即将刷新', 'zh-TW': '即將重設', yue: '就嚟重設', en: 'Refreshing', ja: '間もなく更新' }, l);
    }
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (l === 'zh-CN') return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${Math.max(1, m)}分钟`;
    if (l === 'zh-TW') return d > 0 ? `${d}天${h}小時` : h > 0 ? `${h}小時${m}分` : `${Math.max(1, m)}分鐘`;
    if (l === 'yue') return d > 0 ? `${d}日${h}個鐘` : h > 0 ? `${h}個鐘${m}分` : `${Math.max(1, m)}分鐘`;
    if (l === 'ja') return d > 0 ? `${d}日${h}時間` : h > 0 ? `${h}時間${m}分` : `${Math.max(1, m)}分`;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
  }

  // Estimate tokens for live draft text in the input box
  function estimateTextTokens(text) {
    if (!text) return { tokens: 0, chars: 0, cjk: 0 };
    const clean = String(text);
    const chars = [...clean].length;
    if (!chars) return { tokens: 0, chars: 0, cjk: 0 };
    const cjkMatches = clean.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g);
    const cjk = cjkMatches ? cjkMatches.length : 0;
    const rest = Math.max(0, clean.length - cjk);
    // Gemini / Claude tokenizer empirical ratio: ~0.68 tok/CJK char, ~0.27 tok/ASCII char
    const tokens = Math.max(1, Math.round(cjk * 0.68 + rest * 0.27));
    return { tokens, chars, cjk };
  }

  function hasUsageTokens(obj) {
    return Boolean(
      obj &&
        (Number(obj.inputTokens || 0) > 0 ||
          Number(obj.outputTokens || 0) > 0 ||
          Number(obj.cacheReadTokens || 0) > 0 ||
          Number(obj.cacheWriteTokens || 0) > 0)
    );
  }

  // Extract live active-conversation metrics, per-call telemetry, breakdown trees,
  // streaming speeds, and budgets for the composer footer, turn badges, and inspector popover.
  function analyzeActiveConversation(trajObj, opts = {}) {
    const t = trajObj?.response?.trajectory || trajObj?.trajectory || trajObj || {};
    const gmList = Array.isArray(t.generatorMetadata) ? t.generatorMetadata : [];
    const steps = Array.isArray(t.steps) ? t.steps : [];
    const execList = Array.isArray(t.executorMetadatas) ? t.executorMetadatas : [];
    const known = opts.knownLimits || {};
    const cascadeId = String(opts.cascadeId || t.cascadeId || '');

    // Build step index lookup for tool names & step cases
    const stepInfoMap = new Map();
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st) continue;
      const stepCase = st.step?.case || 'unknown';
      const val = st.step?.value || {};
      const uri =
        val.absolutePathUri ||
        val.actionSpec?.createFile?.path?.absoluteUri ||
        val.actionSpec?.editFile?.path?.absoluteUri ||
        '';
      const baseName = uri ? decodeURIComponent(uri).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
      let toolName = st.metadata?.toolCall?.name || val.toolCalls?.[0]?.name || '';
      if (!toolName) {
        if (stepCase === 'viewFile') toolName = baseName ? `read_file: ${baseName}` : 'read_file';
        else if (stepCase === 'codeAction') toolName = baseName ? `edit_file: ${baseName}` : 'edit_file';
        else if (stepCase === 'runCommand') toolName = 'run_command';
        else if (stepCase === 'commandStatus') toolName = 'command_status';
        else if (stepCase === 'listDir') toolName = 'list_dir';
        else if (stepCase === 'grep') toolName = 'grep_search';
        else if (stepCase === 'find') toolName = 'find_by_name';
        else if (stepCase === 'searchWeb') toolName = 'search_web';
      } else if (baseName && !toolName.includes(':')) {
        toolName = `${toolName}: ${baseName}`;
      }
      stepInfoMap.set(idx, {
        idx,
        stepCase,
        toolName,
        toolSummary: st.metadata?.toolSummary || '',
        status: st.status,
      });
    }

    const callList = [];
    let sumInput = 0;
    let sumCacheRead = 0;
    let sumCacheWrite = 0;
    let sumOutput = 0;
    let sumThinking = 0;
    let sumResponse = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    let timedOutputSum = 0;
    let timedStreamSum = 0;
    let latestValidSpeed = 0;
    let peakSpeed = 0;
    let sustainedPeakSpeed = 0;
    let latestCw = null;
    let latestCwMax = 0;
    let latestChatStart = null;
    let latestBreakdown = null;
    let latestBudgets = null;
    let lastSpeed = 0;
    let lastTtft = 0;

    for (let i = 0; i < gmList.length; i++) {
      const val = gmList[i]?.metadata?.value;
      if (!val) continue;
      const lastRetry =
        Array.isArray(val.retryInfos) && val.retryInfos.length
          ? val.retryInfos[val.retryInfos.length - 1]
          : null;
      const u = hasUsageTokens(val.usage) ? val.usage : lastRetry?.usage || val.usage || {};
      const inp = Number(u.inputTokens || 0);
      const cr = Number(u.cacheReadTokens || 0);
      const cw = Number(u.cacheWriteTokens || 0);
      const out = Number(u.outputTokens || 0);
      const think = Number(u.thinkingOutputTokens || 0);
      const resp = Number(u.responseOutputTokens || Math.max(0, out - think) || 0);

      sumInput += inp;
      sumCacheRead += cr;
      sumCacheWrite += cw;
      sumOutput += out;
      sumThinking += think;
      sumResponse += resp;

      const cs = val.chatStartMetadata;
      const cwMeta = cs?.contextWindowMetadata;
      if (cs) latestChatStart = cs;
      if (cwMeta && Number(cwMeta.maxContextTokens || 0) > 0) {
        latestCwMax = Number(cwMeta.maxContextTokens);
      }
      if (cwMeta && Number(cwMeta.estimatedTokensUsed || 0) > 0) {
        latestCw = cwMeta;
      } else if (!latestCw && cwMeta && cwMeta.maxContextTokens) {
        latestCw = cwMeta;
      }
      if (cwMeta?.tokenBreakdown?.groups?.length) {
        latestBreakdown = cwMeta.tokenBreakdown;
      }
      if (val.customizationTokenBudget || val.rulesTokenBudget) {
        latestBudgets = {
          customizationTokenBudget: Number(val.customizationTokenBudget || 0),
          rulesTokenBudget: Number(val.rulesTokenBudget || 0),
        };
      }

      const stream = durSec(val.streamingDuration) || durSec(lastRetry?.streamingDuration);
      const ttft = durSec(val.timeToFirstToken) || durSec(lastRetry?.timeToFirstToken);
      if (ttft > 0) {
        lastTtft = ttft;
        ttftSum += ttft;
        ttftCount++;
      }
      const speed = stream > 0.05 && out > 0 ? Math.round(out / stream) : 0;
      if (speed > 0) {
        lastSpeed = speed;
        latestValidSpeed = speed;
        timedOutputSum += out;
        timedStreamSum += stream;
        if (speed > peakSpeed) peakSpeed = speed;
        if (stream >= 0.5 && speed > sustainedPeakSpeed) sustainedPeakSpeed = speed;
      }

      const promptTotal = inp + cr;
      const callCacheHitPct = promptTotal > 0 ? (cr / promptTotal) * 100 : 0;
      const stepIndices = Array.isArray(gmList[i].stepIndices) ? gmList[i].stepIndices : [];
      callList.push({
        callNumber: callList.length + 1,
        stepIndices,
        stepRange: stepIndices.length
          ? stepIndices.length === 1
            ? `#${stepIndices[0]}`
            : `#${stepIndices[0]}–${stepIndices[stepIndices.length - 1]}`
          : '—',
        modelDisplayName: cleanModelName(val),
        responseModel: val.responseModel || '',
        modelId: Number(val.model || 0),
        contextUsed: Number(cwMeta?.estimatedTokensUsed || 0),
        contextMax: Number(cwMeta?.maxContextTokens || 0),
        inputTokens: inp,
        cacheReadTokens: cr,
        cacheWriteTokens: cw,
        cacheHitPct: callCacheHitPct,
        outputTokens: out,
        thinkingTokens: think,
        responseTokens: resp,
        ttft,
        stream,
        speed,
        retries: Number(val.retries || 0),
      });
    }

    for (let i = execList.length - 1; i >= 0; i--) {
      const ev = execList[i]?.metadata?.value || execList[i] || {};
      if (!latestBudgets && (ev.customizationTokenBudget || ev.rulesTokenBudget)) {
        latestBudgets = {
          customizationTokenBudget: Number(ev.customizationTokenBudget || 0),
          rulesTokenBudget: Number(ev.rulesTokenBudget || 0),
        };
      }
    }

    const maxContextTokens =
      latestCwMax ||
      Number(latestCw?.maxContextTokens || 0) ||
      Number(known.maxContextTokens || 0) ||
      256000;
    const contextUsed = Number(latestCw?.estimatedTokensUsed || 0);
    const contextRemaining = Math.max(0, maxContextTokens - contextUsed);
    const contextPct = maxContextTokens > 0 ? Math.min(100, (contextUsed / maxContextTokens) * 100) : 0;
    const contextRemainingPct =
      maxContextTokens > 0 ? Math.max(0, Math.min(100, (contextRemaining / maxContextTokens) * 100)) : 100;

    let sysTokens = 0;
    let toolsTokens = 0;
    let msgTokens = 0;
    let sysChildren = [];
    let toolsChildren = [];
    let msgChildren = [];
    let userMsgTokens = 0;
    let botMsgTokens = 0;
    let toolIoTokens = 0;

    if (latestBreakdown && Array.isArray(latestBreakdown.groups)) {
      for (const grp of latestBreakdown.groups) {
        const gName = String(grp.name || '');
        const gTokens = Number(grp.numTokens || 0);
        const children = (grp.children || []).map((c) => ({
          name: String(c.name || ''),
          tokens: Number(c.numTokens || 0),
        }));
        if (grp.type === 1 || /system/i.test(gName)) {
          sysTokens = gTokens;
          sysChildren = children.sort((a, b) => b.tokens - a.tokens);
        } else if (grp.type === 2 || /tool/i.test(gName)) {
          toolsTokens = gTokens;
          toolsChildren = children.sort((a, b) => b.tokens - a.tokens);
        } else if (grp.type === 7 || /message|chat/i.test(gName)) {
          msgTokens = gTokens;
          msgChildren = children.map((c) => {
            const m = /^(\d+):\s*(\S+)/.exec(c.name);
            const sIdx = m ? parseInt(m[1], 10) : -1;
            const kind = m ? m[2] : c.name;
            const sInfo = sIdx >= 0 ? stepInfoMap.get(sIdx) : null;
            if (kind === 'USER_INPUT') userMsgTokens += c.tokens;
            else if (kind === 'PLANNER_RESPONSE') botMsgTokens += c.tokens;
            else toolIoTokens += c.tokens;
            const label =
              sInfo && sInfo.toolName
                ? kind === 'GENERIC'
                  ? `#${sIdx} ${sInfo.toolName}`
                  : `#${sIdx} ${kind} (${sInfo.toolName})`
                : sIdx >= 0
                ? `#${sIdx} ${kind}`
                : c.name;
            return {
              ...c,
              stepIdx: sIdx,
              kind,
              toolName: sInfo?.toolName || '',
              label,
            };
          });
        }
      }
    }

    if (!sysTokens && known.sysTokens && contextUsed === 0) {
      sysTokens = Number(known.sysTokens) || 0;
    }
    if (!toolsTokens && known.toolsTokens && contextUsed === 0) {
      toolsTokens = Number(known.toolsTokens) || 0;
    }
    if (contextUsed > 0 && sysTokens === 0 && toolsTokens === 0 && msgTokens === 0) {
      msgTokens = contextUsed;
    }

    const lastCall = callList.length ? callList[callList.length - 1] : null;
    const totalPrompt = sumInput + sumCacheRead;
    const cacheHitPct = totalPrompt > 0 ? (sumCacheRead / totalPrompt) * 100 : 0;
    const overallThinkPct = sumOutput > 0 ? (sumThinking / sumOutput) * 100 : 0;
    const totalTokens = sumInput + sumCacheRead + sumCacheWrite + sumOutput;
    const avgTtft = ttftCount > 0 ? ttftSum / ttftCount : 0;
    const avgSpeed = timedStreamSum > 0.05 && timedOutputSum > 0 ? Math.round(timedOutputSum / timedStreamSum) : 0;
    if (!sustainedPeakSpeed) sustainedPeakSpeed = peakSpeed;

    // Live streaming speed & token estimate when the latest plannerResponse step is currently generating
    let liveSpeed = 0;
    let liveTokens = 0;
    const nowSec = typeof opts.nowSec === 'number' ? opts.nowSec : Date.now() / 1000;
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (!st) continue;
      if (st.status !== 1 && st.status !== 2) continue;
      if (st.step?.case !== 'plannerResponse') break;
      const hasLaterStep = i < steps.length - 1 && steps.slice(i + 1).some((s) => s && s.step?.case);
      if (hasLaterStep) break;
      const pv = st.step?.value || {};
      const tcText = Array.isArray(pv.toolCalls)
        ? pv.toolCalls.map((tc) => `${tc.name || ''}${tc.argumentsJson || ''}`).join('')
        : '';
      const liveText = `${pv.thinking || ''}${pv.response || ''}${tcText}`;
      const textTokens = liveText ? estimateTextTokens(liveText).tokens : 0;
      const modelOutTokens = Number(st.metadata?.modelUsage?.outputTokens || 0);
      liveTokens = Math.max(modelOutTokens, textTokens);
      const viewableSec = tsSec(st.metadata?.viewableAt);
      const finishedSec = tsSec(st.metadata?.finishedGeneratingAt);
      if (viewableSec > 0 && finishedSec === 0) {
        const elapsed = nowSec - viewableSec;
        if (elapsed >= 0.35 && elapsed < 3600 && liveTokens >= 5) {
          liveSpeed = Math.round(liveTokens / elapsed);
        }
      }
      break;
    }

    const displaySpeed = liveSpeed > 0 ? liveSpeed : lastCall?.speed > 0 ? lastCall.speed : latestValidSpeed;
    const isLiveSpeed = liveSpeed > 0;

    const checkpointIdx = Number(latestChatStart?.checkpointIndex ?? -1);
    const compactedSteps = Array.isArray(latestChatStart?.stepsCoveredByCheckpoint)
      ? latestChatStart.stepsCoveredByCheckpoint.length
      : 0;
    const truncationReason = Number(latestCw?.truncationReason || 0);

    // Detect active/running or error state for mascot & status
    let isRunning = false;
    let isThinking = false;
    let hasError = false;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (!st) continue;
      if (st.status === 1 || st.status === 2) {
        isRunning = true;
        if (st.step?.case === 'plannerResponse' && !st.step?.value?.response) isThinking = true;
      }
      if (i >= Math.max(0, steps.length - 8) && (st.status === 4 || st.status === 6)) {
        hasError = true;
      }
    }

    // Build per-turn details (turnDetails) and tool leaderboard (toolBreakdown)
    const userStepIndices = [];
    for (let idx = 0; idx < steps.length; idx++) {
      if (steps[idx]?.step?.case === 'userInput') userStepIndices.push(idx);
    }

    const turnDetails = [];
    if (callList.length > 0) {
      if (userStepIndices.length > 0 && callList.some((c) => c.stepIndices.length > 0)) {
        const turnBuckets = userStepIndices.map((uIdx, tIdx) => ({
          turn: tIdx + 1,
          userStepIdx: uIdx,
          nextUserStepIdx: tIdx + 1 < userStepIndices.length ? userStepIndices[tIdx + 1] : Infinity,
          calls: [],
        }));
        for (const c of callList) {
          const firstStep = c.stepIndices.length > 0 ? c.stepIndices[0] : -1;
          let bucket = turnBuckets[turnBuckets.length - 1];
          for (let b = turnBuckets.length - 1; b >= 0; b--) {
            if (firstStep >= turnBuckets[b].userStepIdx) {
              bucket = turnBuckets[b];
              break;
            }
          }
          bucket.calls.push(c);
        }
        let prevCtx = sysTokens + toolsTokens;
        for (const b of turnBuckets) {
          if (b.calls.length === 0) continue;
          const lastC = b.calls[b.calls.length - 1];
          const ctxU = lastC.contextUsed || prevCtx;
          const ctxDelta = ctxU - prevCtx;
          prevCtx = ctxU;
          const outSum = b.calls.reduce((s, x) => s + (x.outputTokens || 0), 0);
          const thinkSum = b.calls.reduce((s, x) => s + (x.thinkingTokens || 0), 0);
          const uStepObj = steps[b.userStepIdx] || {};
          const uStep = uStepObj.step?.value || {};
          const rawPrompt = String(uStep.query || uStep.text || uStep.userInput || '').replace(/\s+/g, ' ').trim();
          const startTimeSec = tsSec(uStepObj.metadata?.createdAt);
          let turnToolCalls = 0;
          const endIdx = Math.min(steps.length, b.nextUserStepIdx);
          for (let sIdx = b.userStepIdx + 1; sIdx < endIdx; sIdx++) {
            const sc = steps[sIdx]?.step?.case;
            if (sc && sc !== 'userInput' && sc !== 'plannerResponse' && sc !== 'systemMessage' && sc !== 'checkpoint') {
              turnToolCalls++;
            }
          }
          turnDetails.push({
            turn: turnDetails.length + 1,
            userStepIdx: b.userStepIdx,
            nextUserStepIdx: b.nextUserStepIdx,
            startTimeSec,
            model: lastC.modelDisplayName || '',
            calls: b.calls.length,
            toolCalls: turnToolCalls,
            ctxUsed: ctxU,
            ctxDelta,
            output: outSum,
            thinking: thinkSum,
            speed: lastC.speed || 0,
            ttft: lastC.ttft || 0,
            cacheHitPct: Math.round(lastC.cacheHitPct || 0),
            userPreview: rawPrompt ? rawPrompt.slice(0, 80) : '',
            subagentCount: 0,
            subagentCalls: 0,
            subagentTokens: 0,
          });
        }
      } else {
        let prevCtx = sysTokens + toolsTokens;
        for (let i = 0; i < callList.length; i++) {
          const c = callList[i];
          const ctxU = c.contextUsed || prevCtx;
          const ctxDelta = ctxU - prevCtx;
          prevCtx = ctxU;
          const firstIdx = c.stepIndices?.[0] ?? -1;
          const startTimeSec = firstIdx >= 0 ? tsSec(steps[firstIdx]?.metadata?.createdAt) : 0;
          turnDetails.push({
            turn: i + 1,
            userStepIdx: firstIdx,
            nextUserStepIdx: Infinity,
            startTimeSec,
            model: c.modelDisplayName || '',
            calls: 1,
            toolCalls: 0,
            ctxUsed: ctxU,
            ctxDelta,
            output: c.outputTokens || 0,
            thinking: c.thinkingTokens || 0,
            speed: c.speed || 0,
            ttft: c.ttft || 0,
            cacheHitPct: Math.round(c.cacheHitPct || 0),
            userPreview: '',
            subagentCount: 0,
            subagentCalls: 0,
            subagentTokens: 0,
          });
        }
      }
    }

    const toolMap = new Map();
    for (const mc of msgChildren) {
      if (mc.kind === 'USER_INPUT' || mc.kind === 'PLANNER_RESPONSE') continue;
      const rawTool = mc.toolName ? mc.toolName.split(':')[0].trim() : mc.kind || 'tool';
      const entry = toolMap.get(rawTool) || { name: rawTool, count: 0, tokens: 0 };
      entry.count += 1;
      entry.tokens += Number(mc.tokens || 0);
      toolMap.set(rawTool, entry);
    }
    if (toolMap.size === 0 && stepInfoMap.size > 0) {
      for (const [, sInfo] of stepInfoMap.entries()) {
        if (!sInfo.toolName) continue;
        const rawTool = sInfo.toolName.split(':')[0].trim();
        const entry = toolMap.get(rawTool) || { name: rawTool, count: 0, tokens: 0 };
        entry.count += 1;
        toolMap.set(rawTool, entry);
      }
    }
    const toolBreakdown = Array.from(toolMap.values()).sort((a, b) => b.tokens - a.tokens || b.count - a.count);

    const clampedToolResults = msgTokens > 0 ? Math.min(msgTokens, toolIoTokens) : toolIoTokens;
    const chatMsgTokens = msgTokens > 0 ? Math.max(0, msgTokens - clampedToolResults) : userMsgTokens + botMsgTokens;

    const result = {
      cascadeId,
      turns: turnDetails.length || callList.length,
      turnDetails,
      toolBreakdown,
      chatMsgTokens,
      toolResultsTokens: clampedToolResults,
      overheadTokens: Math.max(0, contextUsed - (sysTokens + toolsTokens + msgTokens)),
      lastModel: lastCall?.modelDisplayName || '',
      lastFreshInput: lastCall?.inputTokens || 0,
      lastCacheRead: lastCall?.cacheReadTokens || 0,
      lastOutput: lastCall?.outputTokens || 0,
      lastThinking: lastCall?.thinkingTokens || 0,
      totalOutput: sumOutput,
      subagents: [],
      subagentCount: 0,
      subagentCalls: 0,
      subagentTokens: 0,
      calls: gmList.length,
      totalCalls: callList.length,
      callList,
      lastCall,
      hasCalls: callList.length > 0,
      steps: steps.length,
      totalSteps: steps.length,
      contextUsed,
      contextRemaining,
      maxContextTokens,
      contextPct,
      contextRemainingPct,
      sysTokens,
      toolsTokens,
      msgTokens,
      sysChildren,
      toolsChildren,
      msgChildren,
      topSteps: [...msgChildren].sort((a, b) => b.tokens - a.tokens).slice(0, 10),
      userMsgTokens,
      botMsgTokens,
      toolIoTokens,
      sumInput,
      sumCacheRead,
      sumCacheWrite,
      sumOutput,
      sumThinking,
      sumResponse,
      totalTokens,
      sumAllTokens: totalTokens,
      cacheHitPct,
      overallCacheHitPct: cacheHitPct,
      overallThinkPct,
      lastSpeed,
      lastTtft,
      avgTtft,
      avgSpeed,
      latestValidSpeed,
      liveSpeed,
      liveTokens,
      displaySpeed,
      isLiveSpeed,
      peakSpeed,
      sustainedPeakSpeed,
      checkpointIdx,
      compactedSteps,
      truncationReason,
      budgets: latestBudgets || {
        customizationTokenBudget: known.customizationTokenBudget || 20000,
        rulesTokenBudget: known.rulesTokenBudget || 20000,
      },
      hasActiveLimits: Boolean((latestCwMax || latestCw?.maxContextTokens) && sysTokens > 0),
      isRunning,
      isThinking,
      hasError,
    };

    if (Array.isArray(opts.subagents) && opts.subagents.length > 0) {
      attachSubagentSummaries(result, opts.subagents);
    }

    return result;
  }

  function attachSubagentSummaries(convoData, subagentItems) {
    if (!convoData || !Array.isArray(subagentItems)) return convoData;
    const normalized = [];
    for (const raw of subagentItems) {
      if (!raw) continue;
      const id = String(raw.id || raw.cascadeId || '');
      const analysis = raw.analysis || (raw.trajectory ? analyzeActiveConversation(raw.trajectory, { cascadeId: id }) : null);
      const createdAtSec = Number(raw.createdAtSec || tsSec(raw.createdAt || raw.createdTime) || 0);
      const status = Number(raw.status ?? (analysis?.isRunning ? 2 : 1));
      const calls = Number(raw.calls ?? analysis?.totalCalls ?? 0);
      const totalTokens = Number(raw.totalTokens ?? analysis?.totalTokens ?? 0);
      const outputTokens = Number(raw.outputTokens ?? analysis?.totalOutput ?? 0);
      const contextUsed = Number(raw.contextUsed ?? analysis?.contextUsed ?? 0);
      const steps = Number(raw.steps ?? analysis?.totalSteps ?? raw.stepCount ?? 0);
      const model = String(raw.model || analysis?.lastModel || '');
      const speed = Number(raw.speed ?? analysis?.displaySpeed ?? analysis?.avgSpeed ?? 0);
      const toolCount = Number(
        raw.toolCount ?? (analysis?.toolBreakdown || []).reduce((acc, t) => acc + (t.count || 0), 0)
      );
      normalized.push({
        id,
        shortId: id ? id.slice(0, 8) : 'subagent',
        parentId: String(raw.parentId || ''),
        rootId: String(raw.rootId || ''),
        summary: String(raw.summary || ''),
        status,
        isRunning: status === 2 || Boolean(analysis?.isRunning),
        steps,
        calls,
        model,
        totalTokens,
        outputTokens,
        contextUsed,
        speed,
        toolCount,
        createdAtSec,
      });
    }
    normalized.sort((a, b) => (a.createdAtSec || 0) - (b.createdAtSec || 0));

    convoData.subagents = normalized;
    convoData.subagentCount = normalized.length;
    convoData.subagentCalls = normalized.reduce((s, x) => s + (x.calls || 0), 0);
    convoData.subagentTokens = normalized.reduce((s, x) => s + (x.totalTokens || 0), 0);

    if (Array.isArray(convoData.turnDetails) && convoData.turnDetails.length > 0) {
      for (const td of convoData.turnDetails) {
        td.subagentCount = 0;
        td.subagentCalls = 0;
        td.subagentTokens = 0;
      }
      for (const sub of normalized) {
        let targetTurn = convoData.turnDetails[convoData.turnDetails.length - 1];
        if (sub.createdAtSec > 0) {
          for (let i = convoData.turnDetails.length - 1; i >= 0; i--) {
            const td = convoData.turnDetails[i];
            if (td.startTimeSec > 0 && sub.createdAtSec >= td.startTimeSec - 2) {
              targetTurn = td;
              break;
            }
          }
        }
        if (targetTurn) {
          targetTurn.subagentCount = (targetTurn.subagentCount || 0) + 1;
          targetTurn.subagentCalls = (targetTurn.subagentCalls || 0) + (sub.calls || 1);
          targetTurn.subagentTokens = (targetTurn.subagentTokens || 0) + (sub.totalTokens || 0);
        }
      }
    }
    return convoData;
  }

  function normalizeQuotaData(quotaRes, userStatusOrState, storeCredits, langOrZh) {
    const lang = langOrZh === undefined ? 'zh-CN' : resolveLang(langOrZh);
    const userStatus = userStatusOrState?.userStatus ? userStatusOrState.userStatus : userStatusOrState;
    const rawGroups = quotaRes?.response?.groups || quotaRes?.groups || [];
    const groups = rawGroups.map((g) => {
      const name = String(g.displayName || g.name || '');
      const buckets = (g.buckets || []).map((b) => {
        const resetSeconds = Number(b.resetTime?.seconds || 0);
        return {
          id: String(b.bucketId || ''),
          name: String(b.displayName || ''),
          window: String(b.window || ''),
          disabled: Boolean(b.disabled),
          remainingPct:
            b.remaining?.case === 'remainingFraction'
              ? Math.max(0, Math.min(100, Number(b.remaining.value || 0) * 100))
              : typeof b.remainingPct === 'number'
              ? b.remainingPct
              : null,
          resetSeconds,
          resetIn: resetSeconds > 0 ? fmtResetTime(resetSeconds, lang) : '',
          desc: String(b.description || ''),
        };
      });
      const b5h = buckets.find((b) => b.window === '5h') || null;
      const bWeek = buckets.find((b) => b.window === 'weekly') || buckets[0] || null;
      const enabledPcts = buckets.filter((b) => !b.disabled && typeof b.remainingPct === 'number').map((b) => b.remainingPct);
      const anyPcts = buckets.filter((b) => typeof b.remainingPct === 'number').map((b) => b.remainingPct);
      const effectiveRemainingPct = enabledPcts.length
        ? Math.min(...enabledPcts)
        : anyPcts.length
        ? Math.min(...anyPcts)
        : 0;
      return {
        name,
        groupName: name,
        desc: String(g.description || ''),
        buckets,
        b5h,
        bWeek,
        effectiveRemainingPct,
      };
    });

    const modelConfigs = (userStatus?.cascadeModelConfigData?.clientModelConfigs || []).map((m) => ({
      label: String(m.label || ''),
      modelIdStr: String(m.modelId || ''),
      modelNum: Number(m.modelOrAlias?.choice?.value || 0),
      disabled: Boolean(m.disabled),
      remainingPct:
        m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number'
          ? Math.max(0, Math.min(100, Number(m.quotaInfo.remainingFraction) * 100))
          : null,
      resetSeconds: Number(m.quotaInfo?.resetTime?.seconds || 0),
    }));

    if (groups.length === 0 && modelConfigs.length > 0) {
      const seenFamilies = new Map();
      for (const mc of modelConfigs) {
        if (mc.disabled || typeof mc.remainingPct !== 'number') continue;
        const family = mc.label.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, '').trim() || mc.label;
        if (!seenFamilies.has(family)) {
          const bWeek = {
            id: mc.modelIdStr || 'model',
            name: family,
            window: 'weekly',
            disabled: false,
            remainingPct: mc.remainingPct,
            resetSeconds: mc.resetSeconds,
            resetIn: mc.resetSeconds > 0 ? fmtResetTime(mc.resetSeconds, lang) : '',
            desc: '',
          };
          seenFamilies.set(family, {
            name: family,
            groupName: family,
            desc: '',
            buckets: [bWeek],
            b5h: null,
            bWeek,
            effectiveRemainingPct: mc.remainingPct,
          });
        }
      }
      groups.push(...seenFamilies.values());
    }

    const tier = userStatus?.userTier || {};
    const planStatus = userStatus?.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const tierCredit = Array.isArray(tier.availableCredits) && tier.availableCredits[0] ? tier.availableCredits[0] : null;
    const availableCredits = Number(
      storeCredits?.availableCredits ?? tierCredit?.creditAmount ?? 0
    );
    const minimumCreditAmountForUsage = Number(
      storeCredits?.minimumCreditAmountForUsage ?? tierCredit?.minimumCreditAmountForUsage ?? 50
    );

    return {
      groups,
      modelConfigs,
      tierName: String(tier.name || planInfo.planName || ''),
      planName: String(planInfo.planName || ''),
      credits: {
        useAICredits: Boolean(storeCredits?.useAICredits),
        availableCredits,
        minimumCreditAmountForUsage,
        availablePromptCredits: Number(planStatus.availablePromptCredits || 0),
        availableFlowCredits: Number(planStatus.availableFlowCredits || 0),
        availableFlexCredits: Number(planStatus.availableFlexCredits || 0),
        monthlyPromptCredits: Number(planInfo.monthlyPromptCredits || 0),
        monthlyFlowCredits: Number(planInfo.monthlyFlowCredits || 0),
      },
    };
  }

  function getActiveQuotaInfo(quotaData, modelName, modelId) {
    const groups = quotaData?.groups || [];
    const modelConfigs = quotaData?.modelConfigs || [];
    const lower = String(modelName || '').toLowerCase();

    let matchedModel = null;
    if (modelId) {
      matchedModel = modelConfigs.find((m) => m.modelNum && m.modelNum === Number(modelId)) || null;
    }
    if (!matchedModel && lower) {
      matchedModel =
        modelConfigs.find((m) => m.label.toLowerCase() === lower) ||
        modelConfigs.find((m) => lower.includes(m.label.toLowerCase().replace(/[()]/g, '').trim())) ||
        null;
    }

    let preferred = null;
    if (groups.length > 0) {
      if (lower.includes('argon')) {
        preferred = groups.find((g) => /argon/i.test(g.name));
      } else if (/claude|gpt|sonnet|opus/i.test(lower)) {
        preferred = groups.find((g) => /claude|gpt|sonnet|opus/i.test(g.name));
      }
      if (!preferred && lower) {
        let bestLen = 0;
        for (const g of groups) {
          const gn = String(g.name || '').trim().toLowerCase();
          if (gn && lower.includes(gn) && gn.length > bestLen) {
            bestLen = gn.length;
            preferred = g;
          }
        }
      }
      if (!preferred) {
        preferred = groups.find((g) => /gemini/i.test(g.name) && !/argon/i.test(g.name)) || groups[0];
      }
    }

    if (preferred && preferred.buckets.length > 0) {
      const b5h = preferred.buckets.find((b) => b.window === '5h') || null;
      const bWeek = preferred.buckets.find((b) => b.window === 'weekly') || preferred.buckets[0] || null;
      const enabledPcts = preferred.buckets
        .filter((b) => !b.disabled && typeof b.remainingPct === 'number')
        .map((b) => b.remainingPct);
      const anyPcts = preferred.buckets
        .filter((b) => typeof b.remainingPct === 'number')
        .map((b) => b.remainingPct);
      const effectiveRemainingPct = enabledPcts.length
        ? Math.min(...enabledPcts)
        : anyPcts.length
        ? Math.min(...anyPcts)
        : matchedModel?.remainingPct ?? null;

      return {
        groupName: preferred.name,
        b5h,
        bWeek,
        buckets: preferred.buckets,
        effectiveRemainingPct,
        modelQuotaPct: matchedModel?.remainingPct ?? null,
      };
    }

    if (matchedModel && typeof matchedModel.remainingPct === 'number') {
      return {
        groupName: matchedModel.label,
        b5h: null,
        bWeek: {
          id: matchedModel.modelIdStr || 'model',
          name: matchedModel.label,
          window: 'weekly',
          disabled: matchedModel.disabled,
          remainingPct: matchedModel.remainingPct,
          resetSeconds: matchedModel.resetSeconds,
        },
        buckets: [],
        effectiveRemainingPct: matchedModel.remainingPct,
        modelQuotaPct: matchedModel.remainingPct,
      };
    }

    return null;
  }

  // Compute remaining-usage telemetry for the bottom-right circular ring (.ag-cs-context-ring).
  function computeRingTelemetry({
    activeInfo = null,
    quotaInfo = null,
    draftTokens = 0,
    ringMode = 'context',
    knownLimits = null,
  } = {}) {
    const maxTokens =
      Number(activeInfo?.maxContextTokens || 0) ||
      Number(knownLimits?.maxContextTokens || 0) ||
      256000;
    const baseUsed = Number(activeInfo?.contextUsed || 0);
    const draft = Math.max(0, Number(draftTokens) || 0);
    const usedTokens = baseUsed + draft;
    const remainingTokens = Math.max(0, maxTokens - usedTokens);
    const contextUsedPct = maxTokens > 0 ? Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100)) : 0;
    const contextRemainingPct =
      maxTokens > 0 ? Math.max(0, Math.min(100, (remainingTokens / maxTokens) * 100)) : 100;

    const quotaRemainingPct =
      quotaInfo && typeof quotaInfo.effectiveRemainingPct === 'number'
        ? Math.max(0, Math.min(100, quotaInfo.effectiveRemainingPct))
        : null;

    let mode = ringMode === 'quota' ? 'quota' : 'context';
    let pct = contextRemainingPct;
    let level;
    if (mode === 'quota' && quotaRemainingPct !== null) {
      pct = quotaRemainingPct;
      level = pct <= 10 ? 'danger' : pct <= 30 ? 'warn' : 'ok';
    } else {
      mode = 'context';
      pct = contextRemainingPct;
      level = pct <= 10 ? 'danger' : pct <= 30 ? 'warn' : 'ok';
    }

    const pctRound = Math.round(pct);
    const color = level === 'danger' ? '#dc3c3d' : level === 'warn' ? '#fbb315' : '#257de0';

    return {
      mode,
      pct,
      remainingPct: pct,
      pctRound,
      level,
      color,
      usedTokens,
      remainingTokens,
      maxTokens,
      draftTokens: draft,
      contextUsedPct,
      contextRemainingPct,
      quotaRemainingPct,
    };
  }

  function buildTelemetryReport(data, draftEst, quotaData, activeQuota, langOrZh) {
    if (!data) return '{}';
    const l = langOrZh === undefined ? 'en' : resolveLang(langOrZh);
    const maxTok = data.maxContextTokens || 256000;
    const remTok = Math.max(0, maxTok - (data.contextUsed || 0));
    const remPct = maxTok > 0 ? (remTok / maxTok) * 100 : 100;
    if (l === 'en') {
      const speedLine =
        data.displaySpeed || data.avgSpeed
          ? `- Generation Speed: ${data.isLiveSpeed ? 'Live ~' : 'Latest '}${data.displaySpeed || 0} tok/s | Session Avg ${data.avgSpeed || 0} tok/s | Peak ${data.sustainedPeakSpeed || 0} tok/s | Avg TTFT ${fmtSec(data.avgTtft || 0)}`
          : null;
      const quotaLine =
        activeQuota && activeQuota.effectiveRemainingPct != null
          ? `- Model Quota (${activeQuota.groupName}): ${activeQuota.b5h && !activeQuota.b5h.disabled ? `5h ${fmtPct(activeQuota.b5h.remainingPct, 1)} | ` : ''}${activeQuota.bWeek ? `Weekly ${fmtPct(activeQuota.bWeek.remainingPct, 1)}` : `Remaining ${fmtPct(activeQuota.effectiveRemainingPct, 1)}`}`
          : null;
      const lines = [
        `# AGY Claude Style Token HUD Report`,
        `- Conversation ID: ${data.cascadeId || 'N/A'}`,
        `- Model: ${data.lastCall?.modelDisplayName || 'N/A'}${data.lastCall?.responseModel ? ` (${data.lastCall.responseModel})` : ''}`,
        `- Context Remaining: ${fmtInt(remTok)} / ${fmtInt(maxTok)} tokens (${fmtPct(remPct)} free, ${fmtPct(data.contextPct)} used)`,
        `- Context Breakdown: System ${fmtInt(data.sysTokens)} | Tools ${fmtInt(data.toolsTokens)} (${(data.toolsChildren || []).length}) | Chat ${fmtInt(data.chatMsgTokens ?? data.msgTokens)} | Tool Results ${fmtInt(data.toolResultsTokens || 0)} (${data.totalSteps} steps)`,
        `- Session Totals (${data.totalCalls} calls): Input ${fmtInt(data.sumInput)} | Cache Read ${fmtInt(data.sumCacheRead)} (${fmtPct(data.overallCacheHitPct)} hit) | Output ${fmtInt(data.sumOutput)} (Thinking ${fmtInt(data.sumThinking)}, Response ${fmtInt(data.sumResponse)})`,
        ...(data.subagentCount > 0
          ? [`- Subagents: ${data.subagentCount} spawned (${data.subagentCalls} calls, ${fmtInt(data.subagentTokens)} total tokens)`]
          : []),
        ...(speedLine ? [speedLine] : []),
        ...(quotaLine ? [quotaLine] : []),
        ...(quotaData?.tierName ? [`- Plan / Credits: ${quotaData.tierName} (AI Credits: ${fmtInt(quotaData.credits?.availableCredits || 0)})`] : []),
        `- Live Draft: ~${fmtInt(draftEst?.tokens || 0)} tokens (${fmtInt(draftEst?.chars || 0)} chars)`,
      ];
      return lines.join('\n');
    }
    const labels = pickByLang(
      {
        'zh-CN': { title: '# AGY Claude Style Token 监控报告', cid: '对话 ID', model: '模型', rem: '上下文剩余', free: '可用', used: '已用', brk: '上下文构成', sys: '系统', tools: '工具', chat: '对话', tr: '工具结果', steps: '步', tot: '会话累计', calls: '次调用', inp: '输入', cr: '缓存读取', hit: '命中率', out: '输出', thk: '思考', rsp: '回复', sub: '子智能体', subSpawn: '个', spd: '生成速度', live: '实时 ~', latest: '最新 ', avg: '均值', peak: '峰值', ttft: '首字均值 TTFT', quota: '模型配额', q5h: '5小时', qwk: '本周', qrem: '剩余', plan: '套餐 / 额度', cred: 'AI 额度', draft: '实时草稿', chars: '字符' },
        'zh-TW': { title: '# AGY Claude Style Token 監控報告', cid: '對話 ID', model: '模型', rem: '上下文剩餘', free: '可用', used: '已用', brk: '上下文構成', sys: '系統', tools: '工具', chat: '對話', tr: '工具結果', steps: '步', tot: '工作階段累計', calls: '次呼叫', inp: '輸入', cr: '快取讀取', hit: '命中率', out: '輸出', thk: '思考', rsp: '回覆', sub: '子代理', subSpawn: '個', spd: '生成速度', live: '即時 ~', latest: '最新 ', avg: '平均', peak: '峰值', ttft: '首字平均 TTFT', quota: '模型配額', q5h: '5小時', qwk: '本週', qrem: '剩餘', plan: '方案 / 點數', cred: 'AI 點數', draft: '即時草稿', chars: '字元' },
        yue: { title: '# AGY Claude Style Token 監控報告', cid: '對話 ID', model: '模型', rem: '剩低上下文', free: '可用', used: '用咗', brk: '上下文組成', sys: '系統', tools: '工具', chat: '對話', tr: '工具結果', steps: '步', tot: '對話累計', calls: '次呼叫', inp: '輸入', cr: '快取讀取', hit: '命中率', out: '輸出', thk: '思考', rsp: '回覆', sub: '子代理', subSpawn: '個', spd: '生成速度', live: '即時 ~', latest: '最新 ', avg: '平均', peak: '峰值', ttft: '首字平均 TTFT', quota: '模型配額', q5h: '5個鐘', qwk: '今個禮拜', qrem: '剩低', plan: '方案 / 額度', cred: 'AI 額度', draft: '即時草稿', chars: '字' },
        ja: { title: '# AGY Claude Style Token レポート', cid: '会話 ID', model: 'モデル', rem: '残りコンテキスト', free: '空き', used: '使用', brk: 'コンテキスト内訳', sys: 'システム', tools: 'ツール', chat: '会話', tr: 'ツール結果', steps: 'ステップ', tot: 'セッション合計', calls: '回呼出', inp: '入力', cr: 'キャッシュ読込', hit: '命中率', out: '出力', thk: '思考', rsp: '応答', sub: 'サブエージェント', subSpawn: '件', spd: '生成速度', live: '現在 ~', latest: '直近 ', avg: '平均', peak: '最大', ttft: '平均 TTFT', quota: 'モデルクォータ', q5h: '5時間', qwk: '週間', qrem: '残り', plan: 'プラン / クレジット', cred: 'AI クレジット', draft: '入力中下書き', chars: '文字' },
      },
      l,
    );
    const speedLine =
      data.displaySpeed || data.avgSpeed
        ? `- ${labels.spd}: ${data.isLiveSpeed ? labels.live : labels.latest}${data.displaySpeed || 0} tok/s | ${labels.avg} ${data.avgSpeed || 0} tok/s | ${labels.peak} ${data.sustainedPeakSpeed || 0} tok/s | ${labels.ttft} ${fmtSec(data.avgTtft || 0)}`
        : null;
    const quotaLine =
      activeQuota && activeQuota.effectiveRemainingPct != null
        ? `- ${labels.quota} (${activeQuota.groupName}): ${activeQuota.b5h && !activeQuota.b5h.disabled ? `${labels.q5h} ${fmtPct(activeQuota.b5h.remainingPct, 1)} | ` : ''}${activeQuota.bWeek ? `${labels.qwk} ${fmtPct(activeQuota.bWeek.remainingPct, 1)}` : `${labels.qrem} ${fmtPct(activeQuota.effectiveRemainingPct, 1)}`}`
        : null;
    const lines = [
      labels.title,
      `- ${labels.cid}: ${data.cascadeId || 'N/A'}`,
      `- ${labels.model}: ${data.lastCall?.modelDisplayName || 'N/A'}${data.lastCall?.responseModel ? ` (${data.lastCall.responseModel})` : ''}`,
      `- ${labels.rem}: ${fmtInt(remTok)} / ${fmtInt(maxTok)} tokens (${fmtPct(remPct)} ${labels.free}, ${fmtPct(data.contextPct)} ${labels.used})`,
      `- ${labels.brk}: ${labels.sys} ${fmtInt(data.sysTokens)} | ${labels.tools} ${fmtInt(data.toolsTokens)} (${(data.toolsChildren || []).length}) | ${labels.chat} ${fmtInt(data.chatMsgTokens ?? data.msgTokens)} | ${labels.tr} ${fmtInt(data.toolResultsTokens || 0)} (${data.totalSteps} ${labels.steps})`,
      `- ${labels.tot} (${data.totalCalls} ${labels.calls}): ${labels.inp} ${fmtInt(data.sumInput)} | ${labels.cr} ${fmtInt(data.sumCacheRead)} (${fmtPct(data.overallCacheHitPct)} ${labels.hit}) | ${labels.out} ${fmtInt(data.sumOutput)} (${labels.thk} ${fmtInt(data.sumThinking)}, ${labels.rsp} ${fmtInt(data.sumResponse)})`,
      ...(data.subagentCount > 0
        ? [`- ${labels.sub}: ${data.subagentCount}${labels.subSpawn} (${data.subagentCalls} ${labels.calls}, ${fmtInt(data.subagentTokens)} tokens)`]
        : []),
      ...(speedLine ? [speedLine] : []),
      ...(quotaLine ? [quotaLine] : []),
      ...(quotaData?.tierName ? [`- ${labels.plan}: ${quotaData.tierName} (${labels.cred}: ${fmtInt(quotaData.credits?.availableCredits || 0)})`] : []),
      `- ${labels.draft}: ~${fmtInt(draftEst?.tokens || 0)} tokens (${fmtInt(draftEst?.chars || 0)} ${labels.chars})`,
    ];
    return lines.join('\n');
  }

  return {
    HOME_HEAT_WEEKS,
    HOME_HEAT_RAMP,
    HOME_HEAT_STEPS,
    HOME_CHART_DAYS,
    HOME_MODEL_ROWS,
    HOME_RANGES,
    HOME_BOOKS,
    resolveLang,
    homeRangeLabel,
    homeBookTitle,
    homeDayKey,
    homeRangeStart,
    formatHomeCount,
    formatCompactTokens,
    formatHomeHour,
    homeShortDateFormat,
    homeShortDate,
    isSubagentSummary,
    analyzeTrajectoryForUsage,
    homeHeatGrid,
    aggregateUsageRollup,
    axisMax,
    homeChartTicks,
    createHomeModelColours,
    durSec,
    tsSec,
    fmtK,
    fmtInt,
    fmtPct,
    fmtSec,
    fmtResetTime,
    estimateTextTokens,
    analyzeActiveConversation,
    attachSubagentSummaries,
    normalizeQuotaData,
    getActiveQuotaInfo,
    computeRingTelemetry,
    buildTelemetryReport,
  };
});
