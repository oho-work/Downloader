// content/content.js
// 页面注入：右下角嗅探浮窗 + 被动嗅探兜底
// 浮窗以 Shadow DOM 挂载，隔离页面样式

(() => {
  if (window.__hlsCachePlayerLoaded) return;
  window.__hlsCachePlayerLoaded = true;

  const STYLE = `
    .wrap{position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    .card{width:300px;background:rgba(14,17,22,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);color:#fff;overflow:hidden;transform:translateY(12px);opacity:0;transition:transform .25s,opacity .25s}
    .card.show{transform:translateY(0);opacity:1}
    .head{display:flex;align-items:center;gap:9px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.08)}
    .dot{width:26px;height:26px;border-radius:8px;background:#22D3EE;display:flex;align-items:center;justify-content:center;flex:none}
    .dot svg{width:13px;height:13px}
    .head b{font-size:13.5px;font-weight:600}
    .head .x{margin-left:auto;background:none;border:none;color:#9aa3b2;font-size:16px;cursor:pointer;line-height:1;padding:2px 6px}
    .head .x:hover{color:#fff}
    .body{padding:11px 15px 13px;color:#c6cdd8;font-size:12.5px;line-height:1.5}
    .body .url{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#8b94a3;font-size:11.5px;margin-top:3px}
    .meta{display:flex;gap:10px;margin-top:6px;color:#7dd3fc;font-size:11.5px}
    .btn{margin:2px 15px 15px;width:calc(100% - 30px);padding:9px 0;border:none;border-radius:9px;background:#22D3EE;color:#0B0E14;font-weight:700;font-size:13px;cursor:pointer}
    .btn:hover{background:#4ade80}
  `;

  let host, root, card, timer;

  function fmtDuration(s) {
    if (!s || s <= 0) return '';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function ensureDom() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = STYLE;
    const wrap = document.createElement('div'); wrap.className = 'wrap';

    const cardEl = document.createElement('div'); cardEl.className = 'card';
    cardEl.innerHTML = `
      <div class="head">
        <span class="dot"><svg viewBox="0 0 24 24" fill="none"><path d="M9 6v12l9-6z" fill="#0B0E14"/></svg></span>
        <b>检测到视频流</b>
        <button class="x" title="关闭">×</button>
      </div>
      <div class="body">
        <div class="tip"></div>
        <div class="url"></div>
        <div class="meta"></div>
      </div>
      <button class="btn">在独立标签页播放</button>`;
    shadow.append(style, wrap); wrap.append(cardEl);
    document.documentElement.append(host);
    root = shadow; card = cardEl;
    card.querySelector('.x').onclick = hide;
    card.querySelector('.btn').onclick = () => {
      const u = card.__streamUrl;
      if (u) chrome.runtime.sendMessage({ type: 'OPEN_PLAYER', stream: { url: u } });
      hide();
    };
  }

  function show(stream) {
    ensureDom();
    card.__streamUrl = stream.url;
    card.querySelector('.tip').textContent = stream.live ? '直播流已嗅探，点击开始播放' : '已自动嗅探到可用视频流，点击开始播放';
    card.querySelector('.url').textContent = stream.url;
    const meta = [];
    if (stream.totalDuration) meta.push(`时长 ${fmtDuration(stream.totalDuration)}`);
    if (stream.isMaster) meta.push('多码率');
    if (stream.encrypted) meta.push('加密');
    if (stream.domain) meta.push(stream.domain);
    card.querySelector('.meta').textContent = meta.join(' · ');
    card.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(hide, 15000); // 15s 自动收起
  }
  function hide() { if (card) card.classList.remove('show'); }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STREAM_DETECTED') show(msg.stream);
  });

  // A verified stream may arrive before this script is ready, or be deduped
  // across a same-URL reload. Restore the current page's best candidate.
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).then((result) => {
    if (result?.ok && result.streams?.length) show(result.streams[0]);
  }).catch(() => {});

  // ── 兜底嗅探：PerformanceObserver 捕获页面加载的 m3u8 资源 ──
  if ('PerformanceObserver' in window) {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (typeof e.name === 'string' && e.name.includes('.m3u8')) {
            chrome.runtime.sendMessage({ type: 'SEND_STREAMS', url: e.name }).catch(() => {});
          }
        }
      });
      po.observe({ entryTypes: ['resource'] });
    } catch { /* 忽略 */ }
  }
})();
