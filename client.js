/* wechat-neuron · client half
 * 神经元风格 3D 微信关系图谱：Canvas 2D 自研伪 3D 管线 + 力导向布局 + 多维筛选。
 */
window.__ModuleLoader__.load({
  id: 'wechat-neuron',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    const API = '/wechat-neuron/api'

    const TIERS = [
      { id: 'core', label: '核心', color: '#ffd479', hint: '75–100 · 最重要的人' },
      { id: 'friend', label: '挚友', color: '#5ee7d0', hint: '60–75' },
      { id: 'regular', label: '常联系', color: '#59a5ff', hint: '40–60' },
      { id: 'weak', label: '弱连接', color: '#a98bff', hint: '20–40' },
      { id: 'silent', label: '沉默', color: '#6b7280', hint: '0–20 · 默认隐藏' },
      { id: 'topic', label: '话题', color: '#ff7ac6', hint: '关键词簇' },
    ]
    const TIER_ORDER = { core: 0, friend: 1, regular: 2, weak: 3, silent: 4, topic: 5 }
    const TIER_COLOR = Object.fromEntries(TIERS.map(tier => [tier.id, tier.color]))
    const KIND_LABEL = {
      text: '文本', image: '图片', voice: '语音', video: '视频', link: '链接',
      card: '名片', sticker: '表情', location: '位置', call: '通话',
      redpacket: '红包', system: '系统', other: '其他', file: '文件',
    }
    const METRIC_LABEL = {
      recency: '新鲜度', frequency: '频次', reciprocity: '对称性',
      initiation: '对方主动', depth: '内容深度', intimacy: '亲密度',
    }
    const METRIC_WEIGHT = { recency: 0.30, frequency: 0.22, reciprocity: 0.16, initiation: 0.12, depth: 0.10, intimacy: 0.10 }
    const LAYOUTS = [
      { id: 'galaxy', label: '银河', hint: '旋臂围绕核心展开' },
      { id: 'sphere', label: '球体', hint: '按重要度分层球壳' },
      { id: 'helix', label: '时间螺旋', hint: '越近的越靠上' },
      { id: 'cluster', label: '类型星团', hint: '人 / 群 / 话题分簇' },
      { id: 'radial', label: '放射', hint: '重要度决定半径' },
      { id: 'force', label: '力导向', hint: '实时物理模拟' },
    ]

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    const CSS = `
.wneur { --wnr-bg: #04060f; --wnr-panel: rgba(10,15,28,.72); --wnr-panel-2: rgba(8,12,23,.86);
  --wnr-border: rgba(120,160,255,.16); --wnr-border-hi: rgba(140,190,255,.42);
  --wnr-text: #cfd8ea; --wnr-strong: #e6eeff; --wnr-muted: #8290ac; --wnr-dim: #5c6a86;
  --wnr-accent: #6fc7ff; --wnr-teal: #5ee7d0; --wnr-gold: #ffd479;
  --wnr-tint: rgba(120,160,255,.09); --wnr-tint-2: rgba(120,160,255,.06); --wnr-tint-3: rgba(255,255,255,.05);
  --wnr-soft: #b3c1dc; --wnr-chip: #c4d4ef; --wnr-body: #c8d5ec; --wnr-rail-bg: rgba(7,10,20,.62);
  --wnr-drawer-bg: rgba(7,10,20,.74); --wnr-card-bg: rgba(14,20,36,.68);
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  color: var(--wnr-text); background: var(--wnr-bg);
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
/* 浅色外观：与 DSH【设置 - 通用 - 外观】联动，改用白日星云配色 */
.wneur[data-scheme="light"] { --wnr-bg: #eef3fc; --wnr-panel: rgba(255,255,255,.82); --wnr-panel-2: rgba(255,255,255,.9);
  --wnr-border: rgba(24,48,96,.14); --wnr-border-hi: rgba(47,111,237,.4);
  --wnr-text: #24344f; --wnr-strong: #0d1a2f; --wnr-muted: #5d6d8b; --wnr-dim: #8b98b1;
  --wnr-accent: #2f6fed; --wnr-teal: #0d9488; --wnr-gold: #b4791b;
  --wnr-tint: rgba(47,111,237,.08); --wnr-tint-2: rgba(47,111,237,.05); --wnr-tint-3: rgba(16,32,64,.04);
  --wnr-soft: #41546f; --wnr-chip: #33455f; --wnr-body: #33445e; --wnr-rail-bg: rgba(255,255,255,.6);
  --wnr-drawer-bg: rgba(255,255,255,.78); --wnr-card-bg: rgba(255,255,255,.72); }
.wneur[data-scheme="light"] .wneur-title h1 { color: #16305c; }
.wneur[data-scheme="light"] .wneur-btn { color: #2b3f60; border-color: rgba(47,111,237,.24); background: var(--wnr-tint); }
.wneur[data-scheme="light"] .wneur-btn:hover { background: rgba(47,111,237,.16); color: #10233f; }
.wneur[data-scheme="light"] .wneur-btn[aria-pressed="true"] { background: rgba(13,148,136,.16); border-color: rgba(13,148,136,.45); color: #0b6f66; }
.wneur[data-scheme="light"] .wneur-search input { background: #fff; border-color: rgba(24,48,96,.18); color: #1b2b45; }
.wneur[data-scheme="light"] .wneur-seg button { color: #4b5d7c; border-color: rgba(24,48,96,.14); background: var(--wnr-tint-2); }
.wneur[data-scheme="light"] .wneur-seg button:hover { background: rgba(47,111,237,.14); color: #10233f; }
.wneur[data-scheme="light"] .wneur-seg button[aria-pressed="true"] { color: #10305e; border-color: rgba(47,111,237,.45); background: rgba(47,111,237,.16); box-shadow: none; }
.wneur[data-scheme="light"] .wneur-check { color: #41546f; }
.wneur[data-scheme="light"] .wneur-check:hover { background: var(--wnr-tint); }
.wneur[data-scheme="light"] .wneur-rank button:hover { background: var(--wnr-tint); color: #10233f; }
.wneur[data-scheme="light"] .wneur-rank b { color: #2c3e5c; }
.wneur[data-scheme="light"] .wneur-legend-row { color: #41546f; }
.wneur[data-scheme="light"] .wneur-timeline .meta b { color: #16305c; }
.wneur[data-scheme="light"] .wneur-drawer-head h2 { color: #0f2138; }
.wneur[data-scheme="light"] .wneur-bar { color: #41546f; }
.wneur[data-scheme="light"] .wneur-bar .track { background: rgba(24,48,96,.1); }
.wneur[data-scheme="light"] .wneur-chip { color: var(--wnr-chip); border-color: rgba(47,111,237,.2); background: var(--wnr-tint); }
.wneur[data-scheme="light"] .wneur-chip:hover { background: rgba(47,111,237,.16); color: #10233f; }
.wneur[data-scheme="light"] .wneur-donut .ring::after { background: #f7faff; }
.wneur[data-scheme="light"] .wneur-sample { background: var(--wnr-tint-2); border-color: rgba(24,48,96,.1); color: var(--wnr-body); }
.wneur[data-scheme="light"] .wneur-modal { background: linear-gradient(180deg, #ffffff, #f4f7fe);
  border-color: rgba(47,111,237,.2); box-shadow: 0 24px 70px rgba(20,40,80,.22); }
.wneur[data-scheme="light"] .wneur-modal h2 { color: #10233f; }
.wneur[data-scheme="light"] .wneur-field input, .wneur[data-scheme="light"] .wneur-field select {
  background: #fff; border-color: rgba(24,48,96,.18); color: #1b2b45; }
.wneur[data-scheme="light"] .wneur-note { color: #6b5a2e; background: rgba(222,160,40,.1); border-color: rgba(180,121,27,.4); }
.wneur[data-scheme="light"] .wneur-db-list div { background: var(--wnr-tint-2); }
.wneur[data-scheme="light"] .wneur-toast { color: #16305c; background: rgba(255,255,255,.97); border-color: rgba(47,111,237,.3);
  box-shadow: 0 10px 30px rgba(20,40,80,.18); }
.wneur[data-scheme="light"] .wneur-tip { color: #24344f; background: rgba(255,255,255,.98); border-color: rgba(24,48,96,.16);
  box-shadow: 0 12px 30px rgba(20,40,80,.18); }
.wneur[data-scheme="light"] .wneur-tip b { color: #0d1a2f; }
.wneur[data-scheme="light"] .wneur-kbd { color: #41546f; border-color: rgba(24,48,96,.18); background: var(--wnr-tint); }
.wneur[data-scheme="light"] .wneur-hint { color: #6b7c99; text-shadow: none; }
.wneur[data-scheme="light"] .wneur-modal-mask { background: rgba(24,40,70,.28); }
.wneur[data-scheme="light"] .wneur-loading { color: #5d6d8b; }
.wneur * { box-sizing: border-box; }
.wneur ::-webkit-scrollbar { width: 8px; height: 8px; }
.wneur ::-webkit-scrollbar-thumb { background: rgba(120,160,255,.22); border-radius: 4px; }
.wneur ::-webkit-scrollbar-track { background: transparent; }

.wneur-head { display: flex; align-items: center; gap: 12px; padding: 11px 16px; flex: 0 0 auto;
  border-bottom: 1px solid var(--wnr-border); background: var(--wnr-panel);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.wneur-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wneur-title h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .18em; color: var(--wnr-strong);
  display: flex; align-items: center; gap: 8px; }
.wneur-title small { font-size: 11.5px; color: var(--wnr-muted); font-variant-numeric: tabular-nums; }
.wneur-badge { font-size: 9.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor;
  letter-spacing: .12em; text-transform: uppercase; font-weight: 500; }
.wneur-badge.demo { color: #ffb347; }
.wneur-badge.real { color: #4ade80; }
.wneur-grow { flex: 1 1 auto; }
.wneur-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 16px;
  border-bottom: 1px solid var(--wnr-border); background: rgba(255,171,64,.10); color: #ffcf8a;
  font-size: 12px; line-height: 1.5; }
.wneur-banner[data-kind="error"] { background: rgba(255,96,96,.12); color: #ffb3b3; }
.wneur-banner[data-kind="ok"] { background: rgba(70,220,160,.12); color: #8ff0c8; }
.wneur-banner b { font-weight: 600; }
.wneur-banner em { font-style: normal; color: var(--wnr-muted); }
.wneur-banner .spacer { flex: 1 1 auto; }
.wneur[data-scheme="light"] .wneur-banner { background: rgba(255,178,64,.16); color: #8a5300; }
.wneur[data-scheme="light"] .wneur-banner[data-kind="error"] { background: rgba(255,96,96,.14); color: #a02020; }
.wneur[data-scheme="light"] .wneur-banner[data-kind="ok"] { background: rgba(60,190,140,.16); color: #0a6a4a; }

.wneur-search { position: relative; display: flex; align-items: center; }
.wneur-search input { width: 200px; padding: 6px 11px 6px 28px; font-size: 12.5px; border-radius: 8px;
  border: 1px solid var(--wnr-border); background: var(--wnr-tint-3); color: var(--wnr-text);
  outline: none; transition: border-color .15s, box-shadow .15s; }
.wneur-search input::placeholder { color: var(--wnr-dim); }
.wneur-search input:focus { border-color: rgba(120,190,255,.6); box-shadow: 0 0 0 3px rgba(90,150,255,.12); }
.wneur-search span { position: absolute; left: 9px; opacity: .45; pointer-events: none; font-size: 12px; }

.wneur-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; font-size: 12.5px;
  border-radius: 7px; border: 1px solid rgba(120,160,255,.2); background: rgba(120,160,255,.09);
  color: #b9caf0; cursor: pointer; transition: background .15s, border-color .15s, color .15s, transform .1s;
  white-space: nowrap; }
.wneur-btn:hover { background: rgba(120,160,255,.2); color: #fff; }
.wneur-btn:active { transform: translateY(1px); }
.wneur-btn[aria-pressed="true"] { background: rgba(80,220,170,.18); border-color: rgba(80,220,170,.5); color: #9dffe0; }
.wneur-btn.primary { background: linear-gradient(135deg, rgba(110,199,255,.9), rgba(94,231,208,.85));
  border-color: transparent; color: #04121c; font-weight: 600; }

.wneur-main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
.wneur-canvas-wrap { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.wneur-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.wneur-canvas.dragging { cursor: grabbing; }
.wneur-overlay { position: absolute; pointer-events: none; inset: 0; }

.wneur-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); font-size: 11.5px; line-height: 1.6;
  color: #6d7c99; pointer-events: none; text-shadow: 0 1px 8px rgba(0,0,0,.8); white-space: nowrap; }
.wneur-stat { position: absolute; right: 14px; top: 14px; display: flex; gap: 16px; padding: 9px 14px;
  font-size: 11px; border-radius: 12px; background: var(--wnr-panel); border: 1px solid var(--wnr-border);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.wneur-stat b { display: block; font-size: 17px; font-weight: 600; color: var(--wnr-strong); font-variant-numeric: tabular-nums; }
.wneur-stat span { color: var(--wnr-muted); }

.wneur-legend { position: absolute; left: 14px; top: 14px; display: flex; flex-direction: column; gap: 4px;
  padding: 10px 12px; border-radius: 12px; background: var(--wnr-panel); border: 1px solid var(--wnr-border);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); font-size: 11px;
  max-height: calc(100% - 28px); overflow-y: auto; z-index: 3; }
.wneur-legend-title { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--wnr-dim);
  font-weight: 600; margin-bottom: 2px; }
.wneur-legend-row { display: flex; align-items: center; gap: 7px; color: var(--wnr-soft); }
.wneur-legend-row em { font-style: normal; color: var(--wnr-dim); font-size: 10.5px; }
.wneur-dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 9px currentColor; background: currentColor; flex: none; }
.wneur-line { width: 18px; height: 1px; background: currentColor; flex: none; }

.wneur-rail { flex: 0 0 208px; display: flex; flex-direction: column; gap: 9px; padding: 12px;
  border-right: 1px solid var(--wnr-border); overflow-y: auto; background: var(--wnr-rail-bg); }
.wneur-card { border: 1px solid var(--wnr-border); border-radius: 11px; padding: 10px;
  background: var(--wnr-card-bg); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.wneur-card > h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
  color: var(--wnr-dim); font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
.wneur-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
.wneur-seg button { padding: 6px 4px; font-size: 11.5px; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(120,160,255,.16); background: rgba(120,160,255,.06); color: var(--wnr-muted);
  transition: background .15s, color .15s, border-color .15s; }
.wneur-seg button:hover { background: rgba(120,160,255,.16); color: var(--wnr-strong); }
.wneur-seg button[aria-pressed="true"] { color: #eaf4ff; border-color: rgba(140,190,255,.55);
  background: rgba(90,150,255,.24); box-shadow: inset 0 0 0 1px rgba(160,205,255,.18); }
.wneur-check { display: flex; align-items: center; gap: 8px; padding: 3px 2px; font-size: 12.5px; cursor: pointer;
  user-select: none; color: var(--wnr-soft); border-radius: 6px; }
.wneur-check:hover { background: rgba(120,160,255,.08); }
.wneur-check input { accent-color: #6fc7ff; width: 13px; height: 13px; }
.wneur-check em { margin-left: auto; font-style: normal; font-size: 10.5px; color: var(--wnr-dim); font-variant-numeric: tabular-nums; }
.wneur-rank { display: flex; flex-direction: column; gap: 2px; }
.wneur-rank button { display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 7px;
  padding: 5px 6px; border-radius: 7px; border: 0; background: transparent; color: inherit; cursor: pointer;
  text-align: left; font-size: 12.5px; transition: background .15s, color .15s; }
.wneur-rank button:hover { background: rgba(120,160,255,.14); color: #fff; }
.wneur-rank i { font-style: normal; font-size: 10px; color: var(--wnr-dim); font-variant-numeric: tabular-nums; }
.wneur-rank b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wnr-text); }
.wneur-rank u { text-decoration: none; font-size: 10px; padding: 1px 6px; border-radius: 999px; font-variant-numeric: tabular-nums; }

.wneur-timeline { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 10px 18px 12px;
  border-top: 1px solid var(--wnr-border); background: var(--wnr-panel-2);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.wneur-timeline input[type=range] { flex: 1 1 auto; accent-color: #6fc7ff; height: 4px; cursor: pointer; }
.wneur-timeline .meta { font-size: 11.5px; color: var(--wnr-muted); font-variant-numeric: tabular-nums; min-width: 132px; }
.wneur-timeline .meta b { color: #cfe1ff; font-weight: 600; }

.wneur-drawer { flex: 0 0 306px; border-left: 1px solid var(--wnr-border); overflow-y: auto;
  padding: 12px; display: flex; flex-direction: column; gap: 9px; background: var(--wnr-drawer-bg);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.wneur-drawer-head { display: flex; align-items: flex-start; gap: 8px; }
.wneur-drawer-head h2 { margin: 0; font-size: 15.5px; font-weight: 600; line-height: 1.3; word-break: break-all; color: var(--wnr-strong); }
.wneur-drawer-head small { display: block; font-size: 11px; color: var(--wnr-muted); margin-top: 3px; }
.wneur-score { display: flex; align-items: baseline; gap: 8px; }
.wneur-score b { font-size: 32px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
  background: linear-gradient(135deg, #fff, var(--wnr-tier, #6fc7ff)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.wneur-score span { font-size: 11px; color: var(--wnr-muted); }
.wneur-bars { display: flex; flex-direction: column; gap: 6px; }
.wneur-bar { display: grid; grid-template-columns: 58px 1fr 34px; align-items: center; gap: 7px; font-size: 11.5px; color: var(--wnr-soft); }
.wneur-bar .track { height: 5px; border-radius: 3px; background: rgba(120,160,255,.12); overflow: hidden; }
.wneur-bar .fill { height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, rgba(110,199,255,.95), rgba(94,231,208,.9));
  box-shadow: 0 0 10px rgba(110,199,255,.5); transition: width .35s ease; }
.wneur-bar em { font-style: normal; text-align: right; color: var(--wnr-dim); font-variant-numeric: tabular-nums; }
.wneur-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.wneur-chip { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(120,160,255,.2);
  background: var(--wnr-tint); color: var(--wnr-chip); cursor: pointer; transition: background .15s, border-color .15s; }
.wneur-chip:hover { border-color: rgba(140,190,255,.6); background: rgba(120,160,255,.18); color: #fff; }
.wneur-chip.muted { color: var(--wnr-dim); cursor: default; }
.wneur-donut { display: flex; align-items: center; gap: 12px; }
.wneur-donut .ring { width: 74px; height: 74px; border-radius: 50%; flex: 0 0 auto; position: relative;
  box-shadow: inset 0 0 0 1px rgba(120,160,255,.18), 0 0 24px rgba(90,150,255,.16); }
.wneur-donut .ring::after { content: ''; position: absolute; inset: 14px; border-radius: 50%; background: #080c17; }
.wneur-donut ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--wnr-soft); }
.wneur-donut li { display: flex; align-items: center; gap: 6px; }
.wneur-donut li span { color: var(--wnr-dim); margin-left: auto; font-variant-numeric: tabular-nums; }
.wneur-spark { width: 100%; height: 46px; display: block; overflow: visible; }
.wneur-samples { display: flex; flex-direction: column; gap: 6px; }
.wneur-sample { font-size: 11.5px; line-height: 1.55; padding: 7px 9px; border-radius: 8px;
  background: var(--wnr-tint-2); border: 1px solid var(--wnr-border); color: var(--wnr-body); }
.wneur-sample.me { border-left: 2px solid rgba(110,199,255,.85); }
.wneur-sample time { display: block; font-size: 10px; color: var(--wnr-dim); margin-bottom: 2px; }
.wneur-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  height: 100%; padding: 30px; text-align: center; color: var(--wnr-muted); font-size: 12.5px; }

.wneur-modal-mask { position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
  background: rgba(2,5,12,.62); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
.wneur-modal { width: min(580px, calc(100% - 40px)); max-height: calc(100% - 60px); overflow-y: auto;
  background: linear-gradient(180deg, rgba(16,23,42,.98), rgba(8,12,22,.99));
  border: 1px solid rgba(140,190,255,.24); border-radius: 16px;
  box-shadow: 0 26px 80px rgba(0,0,0,.66), inset 0 1px 0 rgba(180,215,255,.1); padding: 20px 22px; color: var(--wnr-text); }
.wneur-modal h2 { margin: 0 0 4px; font-size: 16.5px; color: var(--wnr-strong); letter-spacing: .04em; }
.wneur-modal p.lead { margin: 0 0 14px; font-size: 12px; color: var(--wnr-muted); line-height: 1.7; }
.wneur-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.wneur-field label { font-size: 11px; letter-spacing: .08em; color: var(--wnr-dim); text-transform: uppercase; }
.wneur-field input, .wneur-field select { padding: 7px 10px; font-size: 12.5px; border-radius: 8px;
  border: 1px solid rgba(120,160,255,.2); background: rgba(255,255,255,.05); color: #e2ecff; outline: none; }
.wneur-field input:focus, .wneur-field select:focus { border-color: rgba(120,190,255,.62); }
.wneur-field .row { display: flex; gap: 8px; }
.wneur-field .row input { flex: 1 1 auto; }
.wneur-note { font-size: 11.5px; line-height: 1.7; color: #b9c6de; padding: 9px 11px; border-radius: 9px;
  border: 1px dashed rgba(255,179,71,.35); background: rgba(255,179,71,.08); }
.wneur-db-list { display: flex; flex-direction: column; gap: 4px; max-height: 158px; overflow-y: auto; font-size: 11.5px; }
.wneur-db-list div { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 4px 7px;
  border-radius: 6px; background: rgba(120,160,255,.07); }
.wneur-db-list span { color: var(--wnr-dim); font-variant-numeric: tabular-nums; }
.wneur-db-list .enc { color: #ffb347; }
.wneur-db-list .plain { color: #4ade80; }
.wneur-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.wneur-toast { position: absolute; left: 50%; bottom: 78px; transform: translateX(-50%); z-index: 50;
  padding: 8px 18px; border-radius: 999px; font-size: 12.5px; color: #dfeaff;
  background: rgba(10,16,30,.94); border: 1px solid rgba(140,190,255,.3);
  box-shadow: 0 10px 34px rgba(0,0,0,.5), 0 0 20px rgba(90,150,255,.14); }
.wneur-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 12px; font-size: 12.5px; color: var(--wnr-muted); z-index: 5; }
.wneur-spin { width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(120,160,255,.18);
  border-top-color: #6fc7ff; animation: wnr-spin .8s linear infinite; box-shadow: 0 0 18px rgba(110,199,255,.35); }
@keyframes wnr-spin { to { transform: rotate(360deg); } }
.wneur-tip { position: absolute; z-index: 30; pointer-events: none; padding: 7px 11px; border-radius: 9px;
  font-size: 11.5px; line-height: 1.55; max-width: 280px; color: #dbe6ff;
  background: rgba(8,13,24,.94); border: 1px solid rgba(120,160,255,.24);
  box-shadow: 0 12px 34px rgba(0,0,0,.55); }
.wneur-tip b { font-size: 12.5px; color: #fff; }
.wneur-tip span { color: var(--wnr-muted); }
.wneur-kbd { font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid rgba(120,160,255,.24);
  background: rgba(120,160,255,.1); color: #9fb6d8; font-family: ui-monospace, monospace; }
`

    /* ------------------------------------------------------------------ *
     * 工具
     * ------------------------------------------------------------------ */

    function fmtBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
      return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }
    function fmtNum(value) {
      const n = Number(value) || 0
      if (n < 10000) return String(n)
      if (n < 100000000) return (n / 10000).toFixed(n < 100000 ? 1 : 0) + ' 万'
      return (n / 100000000).toFixed(2) + ' 亿'
    }
    function fmtDate(value) {
      if (typeof value !== 'string' || value === '') return '—'
      return value.replace(/-/g, '.')
    }
    function shortLabel(label, max = 12) {
      const text = String(label ?? '')
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }
    function pct(value) { return Math.round((Number(value) || 0) * 100) }

    async function api(method, body) {
      const init = body === undefined
        ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
        : {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      const response = await fetch(`${API}/${method}`, init)
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (payload === null) throw new Error(`接口 ${method} 返回了非 JSON 响应（HTTP ${response.status}）`)
      if (payload.ok !== true) throw new Error(payload.error?.message || payload.error?.code || `接口 ${method} 失败`)
      return payload.value
    }

    function readPalette() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return {}
      const style = getComputedStyle(document.documentElement)
      const read = (name, fallback) => {
        const value = style.getPropertyValue(name).trim()
        return value === '' ? fallback : value
      }
      return {
        bg: read('--dsw-alias-bg-layer-1', '#14161c'),
        label: read('--dsw-alias-label-primary', '#e8ecf4'),
        secondary: read('--dsw-alias-label-secondary', '#98a2b8'),
        brand: read('--dsw-alias-brand-primary', '#6ea8ff'),
        border: read('--dsw-alias-border-l1', 'rgba(255,255,255,.12)'),
      }
    }

    /* ------------------------------------------------------------------ *
     * 主题跟随（DSH 设置 → 通用设置 → 外观）
     * ------------------------------------------------------------------ */

    const runtime = { ctx: null, scheme: 'dark', listeners: new Set() }

    function luminanceOf(color) {
      const match = /rgba?\(([^)]+)\)/i.exec(String(color ?? ''))
      if (match === null) return null
      const parts = match[1].split(',').map(part => Number.parseFloat(part.trim()))
      if (parts.length < 3 || parts.slice(0, 3).some(value => Number.isNaN(value))) return null
      return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
    }

    function detectScheme() {
      const ctx = runtime.ctx
      if (ctx !== null && typeof ctx.get === 'function') {
        try {
          const theme = ctx.get('theme')
          if (theme !== null && typeof theme?.getTheme === 'function') {
            const snapshot = theme.getTheme()
            const scheme = snapshot?.active?.colorScheme
            if (scheme === 'light' || scheme === 'dark') return scheme
          }
        } catch { /* 主题服务不可用时继续用兜底 */ }
      }
      if (typeof document !== 'undefined') {
        const root = document.documentElement
        const marks = [
          root.getAttribute('data-theme'),
          root.getAttribute('data-color-scheme'),
          root.className,
          document.body?.getAttribute('data-theme'),
          document.body?.className,
        ].join(' ').toLowerCase()
        if (marks.includes('light')) return 'light'
        if (marks.includes('dark')) return 'dark'
        const bg = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim()
        const value = luminanceOf(bg)
        if (value !== null) return value > 0.55 ? 'light' : 'dark'
      }
      return 'dark'
    }

    function publishScheme(next) {
      const scheme = next === 'light' ? 'light' : 'dark'
      if (runtime.scheme === scheme) return
      runtime.scheme = scheme
      for (const listener of runtime.listeners) {
        try { listener(scheme) } catch { /* 单个订阅失败不影响其它 */ }
      }
    }

    function useScheme() {
      const [scheme, setScheme] = useState(runtime.scheme)
      useEffect(() => {
        const listener = (next) => setScheme(next)
        runtime.listeners.add(listener)
        const initial = detectScheme()
        runtime.scheme = initial
        setScheme(initial)
        return () => { runtime.listeners.delete(listener) }
      }, [])
      return scheme
    }

    /* ------------------------------------------------------------------ *
     * 3D 渲染引擎
     * ------------------------------------------------------------------ */

    /* 星系几何常量：世界单位，盘半径归一化到 R=1.15，位图覆盖 [-DISK_R, DISK_R] */
    const GALAXY = {
      R: 1.15,
      DISK_R: 1.25,
      R0: 0.12,
      TAN_I: Math.tan((13 * Math.PI) / 180),
      H: 0.28,
      BULGE_FRACTION: 0.15,
      BULGE_H: 0.10,
      BULGE_TRUNC: 0.25,
      ARM_STARTS: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
      ARM_WEIGHT: [1, 0.45, 1, 0.45],
      STARS: 20000,
      DISK_BITMAP: 3072,
    }

    const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

    function hash01(id) {
      const str = String(id == null ? '' : id)
      let h = 0x811c9dc5
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
      return (h >>> 0) / 4294967296
    }

    function gauss(rng, sigma) {
      const u1 = Math.max(1e-12, rng())
      const u2 = rng()
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma
    }

    function safeScore(value) {
      return clampNum(Number(value) || 0, 0, 100)
    }

    const galaxyMath = {
      hash01,
      gauss,
      safeScore,
      armAngle(armIndex, r) {
        const start = GALAXY.ARM_STARTS[((armIndex % 4) + 4) % 4]
        return start + Math.log(Math.max(1e-6, r) / GALAXY.R0) / GALAXY.TAN_I
      },
      armSigma(r) {
        return clampNum(0.11 / Math.max(1e-6, r), 0.06, 0.55)
      },
      diskRadius(rng) {
        return -GALAXY.H * Math.log(Math.max(1e-12, rng()) * Math.max(1e-12, rng()))
      },
      bulgeRadius(rng) {
        return Math.min(GALAXY.BULGE_TRUNC, -GALAXY.BULGE_H * Math.log(Math.max(1e-12, rng()) * Math.max(1e-12, rng())))
      },
      starBrightness(u) {
        return 0.08 + 0.92 * Math.pow(clampNum(u, 0, 1), 4)
      },
      nodePolarRadius(score) {
        return 0.10 + Math.pow(1 - safeScore(score) / 100, 1.35) * 0.92
      },
    }

    class NeuronRenderer {
      constructor(canvas, handlers) {
        this.canvas = canvas
        this.ctx = canvas.getContext('2d', { alpha: true })
        this.handlers = handlers
        this.palette = readPalette()
        this.scheme = 'dark'
        this.nodes = []
        this.nodeById = new Map()
        this.edges = []
        this.adj = new Map()
        this.camera = { yaw: 0.62, pitch: -0.58, zoom: 1.2, panX: 0, panY: 0 }
        this.pointers = new Map()
        this.hover = null
        this.selected = null
        this.focus = null
        this.alpha = 1
        this.w = 1
        this.h = 1
        this.raf = 0
        this.lastTime = 0
        this.dragState = null
        this.targets = null
        this.blend = 0
        this.pulsePhase = 0
        this.view = {
          layout: 'galaxy', showTopics: true, showGroups: true, showCooccurrence: true,
          minTier: 'weak', pulse: true, glow: 6, autoRotate: true, labels: true,
          search: '', timeIndex: -1, highlightOnly: false,
        }
        this._onResize = () => this.resize()
        this._onWheel = (event) => this.onWheel(event)
        this._onDown = (event) => this.onPointerDown(event)
        this._onMove = (event) => this.onPointerMove(event)
        this._onUp = (event) => this.onPointerUp(event)
        this._onLeave = () => { this.hover = null; this.handlers.onHover?.(null) }
        this._onDouble = (event) => this.onDoubleClick(event)
      }

      attach() {
        const canvas = this.canvas
        canvas.addEventListener('wheel', this._onWheel, { passive: false })
        canvas.addEventListener('pointerdown', this._onDown)
        canvas.addEventListener('pointermove', this._onMove)
        canvas.addEventListener('pointerup', this._onUp)
        canvas.addEventListener('pointercancel', this._onUp)
        canvas.addEventListener('pointerleave', this._onLeave)
        canvas.addEventListener('dblclick', this._onDouble)
        if (typeof ResizeObserver !== 'undefined') {
          this.observer = new ResizeObserver(this._onResize)
          this.observer.observe(canvas.parentElement ?? canvas)
        }
        window.addEventListener('resize', this._onResize)
        this.resize()
        this.start()
      }

      detach() {
        const canvas = this.canvas
        canvas.removeEventListener('wheel', this._onWheel)
        canvas.removeEventListener('pointerdown', this._onDown)
        canvas.removeEventListener('pointermove', this._onMove)
        canvas.removeEventListener('pointerup', this._onUp)
        canvas.removeEventListener('pointercancel', this._onUp)
        canvas.removeEventListener('pointerleave', this._onLeave)
        canvas.removeEventListener('dblclick', this._onDouble)
        window.removeEventListener('resize', this._onResize)
        this.observer?.disconnect()
        this.stop()
      }

      resize() {
        const parent = this.canvas.parentElement
        const width = Math.max(1, parent?.clientWidth ?? 800)
        const height = Math.max(1, parent?.clientHeight ?? 600)
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        this.w = width
        this.h = height
        this.canvas.width = Math.round(width * dpr)
        this.canvas.height = Math.round(height * dpr)
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.computeFit()
      }

      /** 按当前布局的真实包围球把整张图缩放到视口内，避免节点挤成一团或飞出画布。 */
      computeFit() {
        const w = this.w || 800
        const h = this.h || 600
        const viewport = Math.min(w, h)
        const wanted = viewport * 0.46
        // 盘面半径 R，跨度 DISK_R；fit 上限保证整张盘（含越界星点）不溢出视口。
        const cap = wanted / GALAXY.R
        const list = this.nodes ?? []
        if (list.length === 0) { this.fit = cap; return }
        const radii = []
        for (const node of list) {
          const target = this.targets?.get(node.id)
          const x = target?.[0] ?? node.x ?? 0
          const y = target?.[1] ?? node.y ?? 0
          const z = target?.[2] ?? node.z ?? 0
          radii.push(Math.sqrt(x * x + y * y + z * z))
        }
        // 取 82 分位而不是最大值：最外圈的话题/弱连接会把整图压得过小，
        // 让真正要突出的人（核心/挚友）缩成米粒。分位数能让主体占到画面。
        radii.sort((a, b) => a - b)
        const pick = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.82))] ?? GALAXY.R
        // 正交投影下屏幕位移直接是「世界半径 × fit」，盘面本身无条件绘制，
        // 因此下限必须是 GALAXY.R：节点全挤在原点时也要让盘面铺满视口。
        const maxRadius = Math.max(GALAXY.R, pick)
        this.fit = Math.min(wanted / Math.max(1e-6, maxRadius), cap)
      }

      setPalette() { this.palette = readPalette() }

      setScheme(scheme) {
        this.scheme = scheme === 'light' ? 'light' : 'dark'
        this.dust = null
      }

      setGraph(graph) {
        const previous = this.nodeById
        this.nodes = (graph.nodes ?? []).map((node, index) => {
          const old = previous.get(node.id)
          return {
            ...node,
            r: this.radiusOf(node),
            color: node.tier === 'topic' ? TIER_COLOR.topic : (TIER_COLOR[node.tier] ?? '#7c8aa5'),
            x: old?.x ?? 0, y: old?.y ?? 0, z: old?.z ?? 0,
            vx: 0, vy: 0, vz: 0,
            index,
          }
        })
        this.nodeById = new Map(this.nodes.map(node => [node.id, node]))
        this.edges = (graph.edges ?? []).map((edge, index) => ({
          ...edge,
          index,
          a: this.nodeById.get(edge.source),
          b: this.nodeById.get(edge.target),
        })).filter(edge => edge.a !== undefined && edge.b !== undefined)
        this.adj = new Map()
        for (const edge of this.edges) {
          if (!this.adj.has(edge.a.id)) this.adj.set(edge.a.id, new Set())
          if (!this.adj.has(edge.b.id)) this.adj.set(edge.b.id, new Set())
          this.adj.get(edge.a.id).add(edge.b.id)
          this.adj.get(edge.b.id).add(edge.a.id)
        }
        this.maxWeight = this.edges.reduce((max, edge) => Math.max(max, edge.weight || 1), 1)
        this.spread()
        this.applyLayout(this.view.layout)
        this.alpha = 1
        this.start()
      }

      spread() {
        const total = this.nodes.length || 1
        const golden = Math.PI * (3 - Math.sqrt(5))
        this.nodes.forEach((node, index) => {
          if (node.x !== 0 || node.y !== 0 || node.z !== 0) return
          const t = total === 1 ? 0 : index / (total - 1)
          const y = 1 - 2 * t
          const radius = Math.sqrt(Math.max(0, 1 - y * y))
          const theta = golden * index
          const shell = GALAXY.R * 1.0
          node.x = Math.cos(theta) * radius * shell
          node.y = y * shell
          node.z = Math.sin(theta) * radius * shell
          node.vx = (Math.random() - 0.5) * 0.4
          node.vy = (Math.random() - 0.5) * 0.4
          node.vz = (Math.random() - 0.5) * 0.4
        })
      }

      radiusOf(node) {
        // 视觉尺度：核心略大，其余保持克制的星点感，避免「一堆大圆球」糊在一起。
        if (node.type === 'self') return 13
        if (node.type === 'topic') return 1.6 + Math.min(1.2, Math.sqrt(safeScore(node.score)) * 0.19)
        const score = safeScore(node.score)
        const base = node.type === 'group' ? 7.6 : 5.9
        return Math.min(9, base + Math.pow(score / 100, 1.3) * 3.1)
      }

      tierRank(tier) { return TIER_ORDER[tier] ?? 9 }

      visible(node) {
        if (node.type === 'topic' && !this.view.showTopics) return false
        if (node.type === 'group' && !this.view.showGroups) return false
        if (node.type === 'self') return true
        if (this.tierRank(node.tier) > this.tierRank(this.view.minTier)) return false
        return true
      }

      applyLayout(layout) {
        this.view.layout = layout
        this.targets = new Map()
        const visible = this.nodes.filter(node => node.type !== 'settled')
        const people = visible.filter(node => node.type === 'person' || node.type === 'group' || node.type === 'self')
        const topics = visible.filter(node => node.type === 'topic')
        const radiusByTier = { core: 150, friend: 220, regular: 290, weak: 360, silent: 410 }

        if (layout === 'galaxy') {
          // 银河：核心（我）居中，重要的人靠近核心，其余沿旋臂铺开；话题沉到盘面下方作为星尘
          const ARMS = 3
          const ordered = [...people].filter(node => node.type !== 'self')
            .sort((a, b) => (b.score || 0) - (a.score || 0))
          ordered.forEach((node, index) => {
            const t = ordered.length === 1 ? 0 : index / (ordered.length - 1)
            // 重要度 -> 半径：核心附近密集，外圈稀疏
            const radius = 150 + Math.pow(t, 0.62) * 560 + (node.type === 'group' ? 40 : 0)
            const arm = index % ARMS
            const base = (arm / ARMS) * Math.PI * 2
            const theta = base - 2.4 * Math.log(radius / 100 + 1) + index * 0.06
            const wobble = 1 + Math.sin(index * 2.3) * 0.10
            this.targets.set(node.id, [
              Math.cos(theta) * radius * wobble,
              Math.sin(index * 1.7) * 46 * (1 - t * 0.55) + (node.type === 'group' ? -34 : 0),
              Math.sin(theta) * radius * wobble,
            ])
          })
          this.targets.set('s', [0, 0, 0])
          topics.forEach((node, index) => {
            const theta = (index / Math.max(1, topics.length)) * Math.PI * 2 * 1.7
            const radius = 300 + (index % 5) * 82
            this.targets.set(node.id, [
              Math.cos(theta) * radius,
              -90 - (index % 4) * 46,
              Math.sin(theta) * radius,
            ])
          })
          this.blend = 1
        } else if (layout === 'sphere' || layout === 'force') {
          const ordered = [...people].sort((a, b) => (this.tierRank(a.tier) - this.tierRank(b.tier)) || (b.score - a.score))
          ordered.forEach((node, index) => {
            const radius = node.type === 'self' ? 0 : (radiusByTier[node.tier] ?? 380)
            const count = Math.max(1, ordered.length - 1)
            const t = count === 1 ? 0 : index / (count - 1)
            const y = 1 - 2 * t
            const ring = Math.sqrt(Math.max(0, 1 - y * y))
            const theta = Math.PI * (3 - Math.sqrt(5)) * index
            this.targets.set(node.id, [
              Math.cos(theta) * ring * radius,
              y * radius * 0.86,
              Math.sin(theta) * ring * radius,
            ])
          })
          this.blend = layout === 'sphere' ? 1 : 0
        } else if (layout === 'helix') {
          const times = people.filter(node => node.stats?.lastTime).map(node => Date.parse(node.stats.lastTime))
          const min = times.length > 0 ? Math.min(...times) : Date.now() - 365 * 86400000
          const max = times.length > 0 ? Math.max(...times) : Date.now()
          people.forEach((node, index) => {
            const time = node.stats?.lastTime ? Date.parse(node.stats.lastTime) : min
            const t = max === min ? 0.5 : (time - min) / (max - min)
            const theta = t * Math.PI * 5 + index * 0.12
            const radius = node.type === 'self' ? 0 : 250
            this.targets.set(node.id, [Math.cos(theta) * radius, -300 + t * 600, Math.sin(theta) * radius])
          })
          this.blend = 1
        } else if (layout === 'cluster') {
          const centers = {
            self: [0, 0, 0],
            person: [-150, 0, 0],
            group: [170, -60, 90],
            topic: [30, 170, -140],
          }
          const grouped = { self: [], person: [], group: [], topic: [] }
          for (const node of visible) (grouped[node.type] ?? grouped.person).push(node)
          for (const [type, list] of Object.entries(grouped)) {
            const center = centers[type] ?? [0, 0, 0]
            const radius = type === 'person' ? 180 : type === 'topic' ? 120 : 96
            list.forEach((node, index) => {
              const golden = Math.PI * (3 - Math.sqrt(5))
              const y = list.length === 1 ? 0 : 1 - 2 * (index / (list.length - 1))
              const ring = Math.sqrt(Math.max(0, 1 - y * y))
              const theta = golden * index
              this.targets.set(node.id, [
                center[0] + Math.cos(theta) * ring * radius,
                center[1] + y * radius,
                center[2] + Math.sin(theta) * ring * radius,
              ])
            })
          }
          this.blend = 1
        } else if (layout === 'radial') {
          const ordered = [...people].sort((a, b) => b.score - a.score)
          ordered.forEach((node, index) => {
            const radius = node.type === 'self' ? 0 : 120 + (1 - (node.score || 0) / 100) * 300
            const theta = (index / Math.max(1, ordered.length)) * Math.PI * 2
            this.targets.set(node.id, [Math.cos(theta) * radius, Math.sin(theta) * radius * 0.62, (index % 7 - 3) * 24])
          })
          this.blend = 1
        }
        if (topics.length > 0 && layout !== 'cluster') {
          topics.forEach((node, index) => {
            const theta = (index / Math.max(1, topics.length)) * Math.PI * 2
            this.targets.set(node.id, [Math.cos(theta) * 430, 260 + Math.sin(index * 1.7) * 40, Math.sin(theta) * 430])
          })
        }
        if (this.blend > 0) this.alpha = Math.max(this.alpha, 0.35)
        this.computeFit()
      }

      setView(patch) {
        const previousLayout = this.view.layout
        Object.assign(this.view, patch)
        if (patch.layout !== undefined && patch.layout !== previousLayout) this.applyLayout(patch.layout)
        if (patch.timeIndex !== undefined) this.alpha = Math.max(this.alpha, 0.2)
      }

      setSelected(id) {
        this.selected = id ?? null
        this.start()
      }
      setFocus(id) { this.focus = id ?? null; this.alpha = Math.max(this.alpha, 0.3); this.start() }

      start() {
        if (this.raf !== 0) return
        this.lastTime = performance.now()
        const loop = (now) => {
          this.raf = requestAnimationFrame(loop)
          this.tick(now)
        }
        this.raf = requestAnimationFrame(loop)
      }
      stop() {
        if (this.raf !== 0) cancelAnimationFrame(this.raf)
        this.raf = 0
      }

      /* -------- 物理 -------- */
      simulate(dt) {
        // 非力导向布局：始终追随布局目标，物理不接管，保证构图稳定
        const pinned = this.view.layout !== 'force' && this.targets !== null
        if (this.blend > 0 || pinned) {
          if (this.blend > 0) this.blend = Math.max(0, this.blend - 0.022)
          const ease = this.blend > 0 ? 0.09 : 0.06
          for (const node of this.nodes) {
            const target = this.targets?.get(node.id)
            if (target === undefined) continue
            node.x += (target[0] - node.x) * ease
            node.y += (target[1] - node.y) * ease
            node.z += (target[2] - node.z) * ease
          }
          return
        }
        if (this.alpha < 0.02) return
        const nodes = this.nodes.filter(node => this.visible(node))
        const alpha = this.alpha
        for (let i = 0; i < nodes.length; i += 1) {
          const a = nodes[i]
          for (let j = i + 1; j < nodes.length; j += 1) {
            const b = nodes[j]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let dz = b.z - a.z
            let distance2 = dx * dx + dy * dy + dz * dz
            if (distance2 < 1) { distance2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5 }
            const distance = Math.sqrt(distance2)
            const repel = (a.type === 'topic' || b.type === 'topic' ? 260 : 900) * alpha / distance2
            const fx = (dx / distance) * repel
            const fy = (dy / distance) * repel
            const fz = (dz / distance) * repel
            a.vx -= fx; a.vy -= fy; a.vz -= fz
            b.vx += fx; b.vy += fy; b.vz += fz
          }
          const pull = a.type === 'self' ? 0.02 : 0.004
          a.vx -= a.x * pull; a.vy -= a.y * pull; a.vz -= a.z * pull
        }
        for (const edge of this.edges) {
          const length = edge.type === 'chat' ? 90 + (1 - Math.min(1, edge.weight / this.maxWeight)) * 90
            : edge.type === 'group-member' ? 130
              : edge.type === 'topic' ? 70 : 150
          const dx = edge.b.x - edge.a.x
          const dy = edge.b.y - edge.a.y
          const dz = edge.b.z - edge.a.z
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
          const k = (edge.type === 'topic' ? 0.014 : 0.008) * alpha
          const force = (distance - length) * k
          const fx = (dx / distance) * force
          const fy = (dy / distance) * force
          const fz = (dz / distance) * force
          edge.a.vx += fx; edge.a.vy += fy; edge.a.vz += fz
          edge.b.vx -= fx; edge.b.vy -= fy; edge.b.vz -= fz
        }
        const ceiling = 1200
        for (const node of nodes) {
          if (node.type === 'self') { node.x = 0; node.y = 0; node.z = 0; node.vx = node.vy = node.vz = 0; continue }
          node.vx = Math.max(-8, Math.min(8, node.vx * 0.88))
          node.vy = Math.max(-8, Math.min(8, node.vy * 0.88))
          node.vz = Math.max(-8, Math.min(8, node.vz * 0.88))
          node.x += node.vx * dt * 60
          node.y += node.vy * dt * 60
          node.z += node.vz * dt * 60
          const radius = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z)
          if (radius > ceiling) {
            const scale = ceiling / radius
            node.x *= scale; node.y *= scale; node.z *= scale
            node.vx *= 0.5; node.vy *= 0.5; node.vz *= 0.5
          }
        }
        this.alpha *= 0.985
      }

      project(node) {
        const { yaw, pitch, zoom, panX, panY } = this.camera
        const cosY = Math.cos(yaw)
        const sinY = Math.sin(yaw)
        const cosP = Math.cos(pitch)
        const sinP = Math.sin(pitch)
        const x1 = node.x * cosY - node.z * sinY
        const z1 = node.x * sinY + node.z * cosY
        const y2 = node.y * cosP - z1 * sinP
        const z2 = node.y * sinP + z1 * cosP
        const scale = zoom * (this.fit || 1)
        return {
          sx: this.w / 2 + panX + x1 * scale,
          sy: this.h / 2 + panY + y2 * scale,
          depth: z2,
        }
      }

      nodeAlpha(node) {
        const index = this.view.timeIndex
        if (index >= 0 && Array.isArray(node.series)) {
          const value = node.series[index] ?? 0
          if (value === 0) return 0.07
          return Math.min(1, 0.28 + Math.log10(1 + value) * 0.42)
        }
        if (node.type === 'self') return 1
        const rank = this.tierRank(node.tier)
        if (rank >= 4) return 0.3
        return 0.62 + (1 - rank / 4) * 0.38
      }

      tick(now) {
        const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000))
        this.lastTime = now
        if (this.view.autoRotate && this.dragState === null) this.camera.yaw += dt * 0.10
        this.pulsePhase = (this.pulsePhase + dt * 0.35) % 1
        this.armPhase = (this.armPhase ?? 0) + dt * 0.045
        this.simulate(dt)
        this.draw(now)
      }

      draw(now) {
        const ctx = this.ctx
        const { bg, brand, label } = this.palette
        const light = this.scheme === 'light'
        ctx.clearRect(0, 0, this.w, this.h)
        // 背景：跟随 DSH 外观主题。深色=深空银河；浅色=白日星云（米白底 + 淡蓝/淡金气团）。
        const cx = this.w / 2
        const cy = this.h * 0.48
        const reach = Math.max(this.w, this.h) * 0.78
        const space = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach)
        if (light) {
          space.addColorStop(0, 'rgba(222,234,255,0.95)')
          space.addColorStop(0.42, 'rgba(240,245,253,0.98)')
          space.addColorStop(1, '#f6f9ff')
        } else {
          space.addColorStop(0, 'rgba(22,32,58,0.98)')
          space.addColorStop(0.42, 'rgba(9,13,26,0.99)')
          space.addColorStop(1, '#04060f')
        }
        ctx.fillStyle = space
        ctx.fillRect(0, 0, this.w, this.h)

        // 核心核球：仿星系中心（深色暖金 / 浅色淡金）
        const coreR = Math.max(110, Math.min(this.w, this.h) * 0.42)
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR)
        if (light) {
          core.addColorStop(0, 'rgba(255,224,158,0.30)')
          core.addColorStop(0.12, 'rgba(255,214,140,0.18)')
          core.addColorStop(0.34, 'rgba(255,203,128,0.09)')
          core.addColorStop(0.7, 'rgba(255,196,130,0.03)')
          core.addColorStop(1, 'rgba(255,196,130,0)')
        } else {
          core.addColorStop(0, 'rgba(255,246,225,0.16)')
          core.addColorStop(0.12, 'rgba(255,232,190,0.09)')
          core.addColorStop(0.34, 'rgba(255,205,140,0.035)')
          core.addColorStop(0.7, 'rgba(240,180,120,0.014)')
          core.addColorStop(1, 'rgba(255,190,120,0)')
        }
        ctx.fillStyle = core
        ctx.beginPath()
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
        ctx.fill()

        // 旋臂薄雾
        this.armPhase = (this.armPhase ?? 0)
        ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
        const ARMS = 3
        for (let pass = 0; pass < 2; pass++) {
          ctx.globalAlpha = light ? (pass === 0 ? 0.16 : 0.10) : (pass === 0 ? 0.042 : 0.024)
          ctx.strokeStyle = pass === 0
            ? (light ? 'rgba(96,140,255,1)' : 'rgba(140,180,255,1)')
            : (light ? 'rgba(236,140,190,1)' : 'rgba(255,170,205,1)')
          ctx.lineWidth = pass === 0 ? Math.max(24, this.w * 0.042) : Math.max(9, this.w * 0.015)
          ctx.lineCap = 'round'
          for (let a = 0; a < ARMS; a++) {
            ctx.beginPath()
            for (let i = 0; i <= 72; i++) {
              const rr = 0.12 + (i / 72) * 0.92
              const rad = Math.min(this.w, this.h) * 0.52 * rr
              const th = (a / ARMS) * Math.PI * 2 - 2.5 * Math.log(rr * 6 + 1) + this.armPhase
              const px = cx + Math.cos(th) * rad
              const py = cy + Math.sin(th) * rad * 0.42
              i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
            }
            ctx.stroke()
          }
        }

        // 星尘：确定性分布，缓慢自转
        if (!this.dust || this.dust.w !== this.w || this.dust.h !== this.h) {
          let seed = 20261110
          const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
          const count = Math.min(520, Math.round(this.w * this.h / 2600))
          const list = []
          for (let i = 0; i < count; i++) {
            const radius = Math.pow(rnd(), 0.62) * Math.min(this.w, this.h) * 0.62
            list.push({ r: radius, a: rnd() * Math.PI * 2, s: 0.35 + rnd() * 1.15, o: 0.16 + rnd() * 0.6, warm: rnd() > 0.72 })
          }
          this.dust = { w: this.w, h: this.h, list }
        }
        ctx.globalAlpha = 1
        for (const d of this.dust.list) {
          const th = d.a + this.armPhase * 0.6
          const px = cx + Math.cos(th) * d.r
          const py = cy + Math.sin(th) * d.r * 0.42
          ctx.globalAlpha = d.o * (0.55 + 0.45 * Math.sin(this.pulsePhase * 6.28 + d.a * 3)) * (light ? 0.55 : 1)
          ctx.fillStyle = light
            ? (d.warm ? 'rgba(196,142,52,1)' : 'rgba(96,132,196,1)')
            : (d.warm ? 'rgba(255,226,186,1)' : 'rgba(190,214,255,1)')
          ctx.fillRect(px, py, d.s, d.s)
        }
        ctx.globalCompositeOperation = 'source-over'

        // 暗角（浅色下改为轻微收边，避免压脏）
        const vignette = ctx.createRadialGradient(cx, cy, reach * 0.30, cx, cy, reach)
        vignette.addColorStop(0, 'rgba(0,0,0,0)')
        vignette.addColorStop(1, light ? 'rgba(96,120,168,0.16)' : 'rgba(0,2,8,0.72)')
        ctx.fillStyle = vignette
        ctx.fillRect(0, 0, this.w, this.h)
        ctx.globalAlpha = 1

        const projected = new Map()
        for (const node of this.nodes) projected.set(node.id, this.project(node))

        const focusSet = this.focus === null ? null : new Set([this.focus, ...(this.adj.get(this.focus) ?? [])])
        const selectedSet = this.selected === null ? null : new Set([this.selected, ...(this.adj.get(this.selected) ?? [])])
        const highlight = selectedSet ?? focusSet

        // ---- 边 ----
        const edgeList = this.edges
          .filter(edge => this.visible(edge.a) && this.visible(edge.b))
          .filter(edge => (edge.type !== 'co-occurrence' || this.view.showCooccurrence)
            && (edge.type !== 'topic' || this.view.showTopics))
          .map(edge => {
            const pa = projected.get(edge.a.id)
            const pb = projected.get(edge.b.id)
            return { edge, pa, pb, depth: (pa.depth + pb.depth) / 2 }
          })
          .sort((a, b) => a.depth - b.depth)

        for (const item of edgeList) {
          const { edge, pa, pb } = item
          const isConnected = highlight !== null && (highlight.has(edge.a.id) || highlight.has(edge.b.id))
          const dimmed = highlight !== null && !isConnected
          const weight = Math.min(1, (edge.weight || 1) / this.maxWeight)
          let alpha = (edge.type === 'co-occurrence' ? 0.06 : 0.13) + weight * 0.42
          alpha *= Math.min(1, (pa.scale + pb.scale) / 1.6)
          if (edge.type === 'topic') alpha *= 0.5
          if (dimmed) alpha *= 0.14
          if (isConnected) alpha = Math.min(0.8, alpha * 1.7)
          if (alpha < 0.012) continue
          const color = edge.type === 'group-member' ? '#5ee7d0'
            : edge.type === 'co-occurrence' ? '#a98bff'
              : edge.type === 'topic' ? '#ff7ac6' : brand
          ctx.strokeStyle = color
          ctx.globalAlpha = alpha
          ctx.lineWidth = edge.type === 'chat' ? 0.5 + weight * 1.6 : 0.4 + weight * 0.7
          const mx = (pa.sx + pb.sx) / 2 + (pa.sy - pb.sy) * 0.08
          const my = (pa.sy + pb.sy) / 2 + (pb.sx - pa.sx) * 0.08
          ctx.beginPath()
          ctx.moveTo(pa.sx, pa.sy)
          ctx.quadraticCurveTo(mx, my, pb.sx, pb.sy)
          ctx.stroke()
          // 信号脉冲
          if (this.view.pulse && (edge.type === 'chat' && (edge.a.type === 'self' || edge.b.type === 'self')) && (isConnected || highlight === null)) {
            const t = (this.pulsePhase * 1.6 + (edge.index % 13) / 13) % 1
            const ix = (1 - t) * (1 - t) * pa.sx + 2 * (1 - t) * t * mx + t * t * pb.sx
            const iy = (1 - t) * (1 - t) * pa.sy + 2 * (1 - t) * t * my + t * t * pb.sy
            ctx.globalAlpha = Math.min(1, alpha * 3.4)
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(ix, iy, 1.1 + weight * 1.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.globalAlpha = 1

        // ---- 节点 ----
        const drawNodes = this.nodes
          .filter(node => this.visible(node))
          .map(node => ({ node, p: projected.get(node.id), alpha: this.nodeAlpha(node) }))
          .sort((a, b) => a.p.depth - b.p.depth)

        const labelQueue = []
        for (const item of drawNodes) {
          const { node, p } = item
          const isSelected = node.id === this.selected
          const isFocus = node.id === this.focus
          const dimmed = highlight !== null && !highlight.has(node.id)
          let alpha = item.alpha
          if (dimmed) alpha *= 0.22
          const searched = this.view.search.trim() !== ''
          if (searched) {
            const hit = String(node.label ?? '').toLowerCase().includes(this.view.search.trim().toLowerCase())
            alpha = hit ? Math.min(1, alpha + 0.3) : alpha * 0.2
          }
          // 透视只做弱缩放：scale 在整图 fit 后会很小（本视图约 0.27），
          // 若线性相乘，所有节点都会退化成 1px 光点 —— 这里改为开方压缩 + 上下限。
          const persp = Math.max(0.62, Math.min(1.9, Math.sqrt(Math.max(0.02, p.scale)) * 1.1))
          const radius = Math.max(1.4, node.r * persp)
          const glowRadius = radius * (isSelected ? Math.min(7, this.view.glow * 1.9) : Math.min(5.2, this.view.glow * 1.05))
          const color = node.color || TIER_COLOR.regular

          if (node.type !== 'topic' || isSelected) {
            const halo = ctx.createRadialGradient(p.sx, p.sy, radius * 0.2, p.sx, p.sy, glowRadius)
            halo.addColorStop(0, this.hexAlpha(color, 0.85 * alpha))
            halo.addColorStop(0.3, this.hexAlpha(color, 0.34 * alpha))
            halo.addColorStop(0.62, this.hexAlpha(color, 0.12 * alpha))
            halo.addColorStop(1, this.hexAlpha(color, 0))
            ctx.fillStyle = halo
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, glowRadius, 0, Math.PI * 2)
            ctx.fill()
          }

          // 恒星本体：亮白核心 -> 颜色外缘
          const body = ctx.createRadialGradient(
            p.sx - radius * 0.24, p.sy - radius * 0.24, radius * 0.08,
            p.sx, p.sy, radius,
          )
          body.addColorStop(0, this.hexAlpha('#ffffff', Math.min(1, 1.05 * alpha)))
          body.addColorStop(0.5, this.hexAlpha(color, Math.min(1, 1.02 * alpha)))
          body.addColorStop(1, this.hexAlpha(color, 0.55 * alpha))
          ctx.fillStyle = body
          ctx.beginPath()
          ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2)
          ctx.fill()

          // 十字星芒：只给真正的亮星（核心 / 选中 / 高分），避免满屏光斑
          const bright = node.type === 'self' || isSelected || isFocus || (Number(node.score) || 0) >= 70
          if (bright && node.type !== 'topic') {
            ctx.globalCompositeOperation = 'lighter'
            const arm = radius * (node.type === 'self' ? 6.4 : 4.2)
            ctx.strokeStyle = this.hexAlpha(color, 0.55 * alpha)
            ctx.lineWidth = Math.max(0.8, radius * 0.13)
            ctx.beginPath()
            ctx.moveTo(p.sx - arm, p.sy); ctx.lineTo(p.sx + arm, p.sy)
            ctx.moveTo(p.sx, p.sy - arm * 0.72); ctx.lineTo(p.sx, p.sy + arm * 0.72)
            ctx.stroke()
            ctx.globalCompositeOperation = 'source-over'
          }

          if (isSelected || isFocus) {
            ctx.strokeStyle = this.hexAlpha('#ffffff', 0.9)
            ctx.lineWidth = 1.2
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, radius + 3.6 + Math.sin(now / 320) * 1.4, 0, Math.PI * 2)
            ctx.stroke()
          }
          if (node.type === 'self') {
            ctx.strokeStyle = this.hexAlpha(color, 0.5)
            ctx.lineWidth = 0.9
            for (let ring = 1; ring <= 2; ring += 1) {
              ctx.beginPath()
              ctx.arc(p.sx, p.sy, radius + ring * 6 + Math.sin(now / 640 + ring) * 2.4, 0, Math.PI * 2)
              ctx.stroke()
            }
          }

          const showLabel = this.view.labels && (node.type === 'self' || radius > 8.5 || isSelected || isFocus)
          if (showLabel && alpha > 0.3) {
            labelQueue.push({ node, p, radius, alpha, isSelected, color })
          }
        }

        // 标签统一最后画，避免被后续光晕遮盖；简单矩形避让防止重叠
        if (labelQueue.length > 0) {
          labelQueue.sort((a, b) => (b.node.score || 0) - (a.node.score || 0))
          const placed = []
          for (const item of labelQueue) {
            const { node, p, radius, alpha, isSelected } = item
            const text = shortLabel(node.label, isSelected ? 20 : 11)
            const size = Math.max(10.5, Math.min(13.5, 10.5 + radius * 0.15))
            ctx.font = `${node.type === 'self' ? 600 : 400} ${size}px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            const width = ctx.measureText(text).width
            const bx = p.sx - width / 2 - 4
            const by = p.sy + radius + 5
            const bw = width + 8
            const bh = size + 3
            const clash = placed.some(box => !(bx > box[0] + box[2] || bx + bw < box[0] || by > box[1] + box[3] || by + bh < box[1]))
            if (clash && !isSelected && node.type !== 'self') continue
            placed.push([bx, by, bw, bh])
            ctx.globalAlpha = Math.min(0.96, alpha)
            ctx.fillStyle = this.scheme === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(3,6,14,0.82)'
            ctx.beginPath()
            if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, 4)
            else ctx.rect(bx, by, bw, bh)
            ctx.fill()
            ctx.fillStyle = this.scheme === 'light'
              ? (node.type === 'self' ? '#7a4a00' : (node.type === 'topic' ? '#a3216a' : '#2b3a52'))
              : (node.type === 'self' ? '#fff8e6' : (node.type === 'topic' ? this.hexAlpha('#ffd7ee', 1) : '#dfe9fb'))
            ctx.fillText(text, p.sx, by + 1.5)
            ctx.globalAlpha = 1
          }
        }
      }

      hexAlpha(hex, alpha) {
        if (typeof hex !== 'string') return `rgba(120,160,255,${alpha})`
        if (hex.startsWith('rgb')) return hex
        const clean = hex.replace('#', '')
        const value = clean.length === 3
          ? clean.split('').map(char => char + char).join('')
          : clean
        const r = parseInt(value.slice(0, 2), 16) || 0
        const g = parseInt(value.slice(2, 4), 16) || 0
        const b = parseInt(value.slice(4, 6), 16) || 0
        return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
      }

      pick(sx, sy) {
        let best = null
        let bestScore = Infinity
        for (const node of this.nodes) {
          if (!this.visible(node)) continue
          const p = this.project(node)
          const radius = Math.max(6, node.r * p.scale * 0.9)
          const dx = p.sx - sx
          const dy = p.sy - sy
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance <= radius + 4 && distance / radius < bestScore) {
            bestScore = distance / radius
            best = node
          }
        }
        return best
      }

      /* -------- 交互 -------- */
      onWheel(event) {
        event.preventDefault()
        const factor = Math.exp(-event.deltaY * 0.0012)
        this.camera.zoom = Math.max(0.32, Math.min(3.6, this.camera.zoom * factor))
        this.alpha = Math.max(this.alpha, 0.3)
      }

      onPointerDown(event) {
        this.canvas.setPointerCapture?.(event.pointerId)
        this.canvas.classList.add('dragging')
        this.dragState = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          yaw: this.camera.yaw,
          pitch: this.camera.pitch,
          panX: this.camera.panX,
          panY: this.camera.panY,
          moved: 0,
          button: event.button,
        }
      }

      onPointerMove(event) {
        const rect = this.canvas.getBoundingClientRect()
        const sx = event.clientX - rect.left
        const sy = event.clientY - rect.top
        if (this.dragState !== null) {
          const dx = event.clientX - this.dragState.x
          const dy = event.clientY - this.dragState.y
          this.dragState.moved += Math.abs(dx) + Math.abs(dy)
          if (event.button === 1 || event.buttons === 4 || this.dragState.button === 1) {
            this.camera.panX = this.dragState.panX + dx
            this.camera.panY = this.dragState.panY + dy
          } else {
            this.camera.yaw = this.dragState.yaw + dx * 0.006
            this.camera.pitch = Math.max(-1.35, Math.min(1.35, this.dragState.pitch + dy * 0.005))
          }
          return
        }
        const node = this.pick(sx, sy)
        if ((node?.id ?? null) !== (this.hover?.id ?? null)) {
          this.hover = node
          this.handlers.onHover?.(node === null ? null : {
            id: node.id, label: node.label, type: node.type, score: node.score, tier: node.tier,
            x: sx, y: sy,
          })
        } else if (node !== null) {
          this.handlers.onHover?.({
            id: node.id, label: node.label, type: node.type, score: node.score, tier: node.tier, x: sx, y: sy,
          })
        }
        this.canvas.style.cursor = node === null ? 'grab' : 'pointer'
      }

      onPointerUp(event) {
        this.canvas.classList.remove('dragging')
        const state = this.dragState
        this.dragState = null
        if (state === null) return
        if (state.moved > 6) return
        const rect = this.canvas.getBoundingClientRect()
        const node = this.pick(event.clientX - rect.left, event.clientY - rect.top)
        this.handlers.onPick?.(node === null ? null : {
          id: node.id, label: node.label, type: node.type, score: node.score, tier: node.tier, username: node.username,
        })
      }

      onDoubleClick(event) {
        const rect = this.canvas.getBoundingClientRect()
        const node = this.pick(event.clientX - rect.left, event.clientY - rect.top)
        if (node !== null) {
          this.camera.panX = 0
          this.camera.panY = 0
          this.handlers.onFocus?.(node.id)
        }
      }

      reset() {
        this.camera = { yaw: 0.62, pitch: -0.58, zoom: 1.2, panX: 0, panY: 0 }
        this.alpha = 1
        this.applyLayout(this.view.layout)
      }
    }

    /* ------------------------------------------------------------------ *
     * 小组件
     * ------------------------------------------------------------------ */

    function IconNeuron(props) {
      const size = props?.size ?? 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 3.4, fill: 'currentColor', opacity: props?.active === false ? 0.55 : 0.95 }),
        h('circle', { cx: 12, cy: 12, r: 7.4, stroke: 'currentColor', strokeWidth: 1, opacity: 0.4 }),
        [0, 60, 120, 180, 240, 300].map((angle, index) => {
          const rad = (angle * Math.PI) / 180
          return h('g', { key: index },
            h('line', {
              x1: 12 + Math.cos(rad) * 4, y1: 12 + Math.sin(rad) * 4,
              x2: 12 + Math.cos(rad) * 10, y2: 12 + Math.sin(rad) * 10,
              stroke: 'currentColor', strokeWidth: 1, opacity: 0.65 - index * 0.06,
            }),
            h('circle', { cx: 12 + Math.cos(rad) * 10, cy: 12 + Math.sin(rad) * 10, r: 1.5, fill: 'currentColor', opacity: 0.85 }))
        }),
      )
    }

    function TierPill({ tier, score }) {
      const color = TIER_COLOR[tier] ?? '#7c8aa5'
      return h('u', {
        style: { color, border: `1px solid ${color}55`, background: `${color}18` },
        title: `重要度 ${score}`,
      }, (TIERS.find(item => item.id === tier)?.label ?? tier))
    }

    function Legend({ onClose }) {
      return h('div', { className: 'wneur-legend' },
        h('div', { className: 'wneur-legend-title', style: { display: 'flex', gap: 8, alignItems: 'center' } },
          '图例', h('button', {
            className: 'wneur-btn', style: { padding: '1px 6px', fontSize: 10 },
            onClick: onClose, title: '隐藏图例',
          }, '×')),
        TIERS.map(tier => h('div', { className: 'wneur-legend-row', key: tier.id },
          h('i', { className: 'wneur-dot', style: { color: tier.color } }),
          h('span', null, tier.label),
          h('em', { style: { fontStyle: 'normal', opacity: 0.55, fontSize: 10 } }, tier.hint))),
        h('div', { className: 'wneur-legend-row', style: { marginTop: 4 } },
          h('i', { className: 'wneur-line', style: { color: '#6ea8ff' } }), h('span', null, '聊天关系')),
        h('div', { className: 'wneur-legend-row' },
          h('i', { className: 'wneur-line', style: { color: '#5ee7d0' } }), h('span', null, '群成员')),
        h('div', { className: 'wneur-legend-row' },
          h('i', { className: 'wneur-line', style: { color: '#a98bff' } }), h('span', null, '共同群聊')),
        h('div', { className: 'wneur-legend-row' },
          h('i', { className: 'wneur-line', style: { color: '#ff7ac6' } }), h('span', null, '话题关联')),
      )
    }

    function MetricBars({ metrics }) {
      const keys = Object.keys(METRIC_WEIGHT)
      return h('div', { className: 'wneur-bars' },
        keys.map(key => {
          const value = Number(metrics?.[key]) || 0
          return h('div', { className: 'wneur-bar', key, title: `权重 ${(METRIC_WEIGHT[key] * 100).toFixed(0)}%` },
            h('span', null, METRIC_LABEL[key]),
            h('div', { className: 'track' }, h('div', { className: 'fill', style: { width: `${Math.max(2, pct(value))}%` } })),
            h('em', null, pct(value)))
        }),
      )
    }

    function Donut({ distribution }) {
      const entries = Object.entries(distribution ?? {}).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
      const total = entries.reduce((sum, [, value]) => sum + value, 0)
      if (total === 0) return h('div', { className: 'wneur-note' }, '暂无消息类型分布')
      const palette = ['#6ea8ff', '#5ee7d0', '#ffd479', '#ff7ac6', '#a98bff', '#8fa3c8', '#4ade80']
      let cursor = 0
      const stops = []
      entries.forEach(([, value], index) => {
        const start = cursor
        cursor += (value / total) * 100
        stops.push(`${palette[index % palette.length]} ${start.toFixed(1)}% ${cursor.toFixed(1)}%`)
      })
      return h('div', { className: 'wneur-donut' },
        h('div', { className: 'ring', style: { background: `conic-gradient(${stops.join(',')})` } }),
        h('ul', null, entries.slice(0, 6).map(([kind, value], index) => h('li', { key: kind },
          h('i', { className: 'wneur-dot', style: { color: palette[index % palette.length], width: 6, height: 6 } }),
          h('span', { style: { color: 'inherit', margin: 0 } }, KIND_LABEL[kind] ?? kind),
          h('span', null, `${Math.round((value / total) * 100)}%`)))),
      )
    }

    function Sparkline({ data, color }) {
      if (!Array.isArray(data) || data.length === 0) return null
      const width = 260
      const height = 44
      const max = Math.max(1, ...data.map(point => point.count))
      const step = data.length === 1 ? width : width / (data.length - 1)
      const points = data.map((point, index) => `${(index * step).toFixed(1)},${(height - (point.count / max) * (height - 6) - 3).toFixed(1)}`)
      return h('svg', { className: 'wneur-spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
        h('defs', null, h('linearGradient', { id: 'wnr-spark-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.42 }),
          h('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }))),
        h('polyline', { points: `${points.join(' ')} ${width},${height} 0,${height}`, fill: 'url(#wnr-spark-fill)', stroke: 'none' }),
        h('polyline', { points: points.join(' '), fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' }),
      )
    }

    function DetailDrawer({ detail, loading, onClose, onFocus, onKeyword }) {
      if (loading) {
        return h('aside', { className: 'wneur-drawer' },
          h('div', { className: 'wneur-empty' }, h('div', { className: 'wneur-spin' }), '正在计算节点画像…'))
      }
      if (detail === null) return null
      const node = detail.node
      const color = TIER_COLOR[node.tier] ?? '#6ea8ff'
      return h('aside', { className: 'wneur-drawer', style: { '--wnr-tier': color } },
        h('div', { className: 'wneur-drawer-head' },
          h('div', { style: { flex: 1 } },
            h('h2', null, node.label),
            h('small', null,
              `${TIERS.find(item => item.id === node.tier)?.label ?? node.tier} · ${node.type === 'group' ? '群聊' : node.type === 'self' ? '我' : '联系人'}`,
              detail.stats?.msgCount !== undefined ? ` · ${fmtNum(detail.stats.msgCount)} 条消息` : '')),
          h('button', { className: 'wneur-btn', onClick: onClose, title: '关闭' }, '×')),
        h('div', { className: 'wneur-card' },
          h('div', { className: 'wneur-score' },
            h('b', null, node.score?.toFixed?.(1) ?? node.score),
            h('span', null, '重要度 / 100')),
          h('div', { style: { marginTop: 10 } }, h(MetricBars, { metrics: detail.metrics }))),
        h('div', { className: 'wneur-card' },
          h('h3', null, '互动统计'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 } },
            h('div', null, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '我发出'), h('div', { style: { fontSize: 15, fontWeight: 600 } }, fmtNum(detail.stats?.sent ?? 0))),
            h('div', null, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '对方发来'), h('div', { style: { fontSize: 15, fontWeight: 600 } }, fmtNum(detail.stats?.recv ?? 0))),
            h('div', null, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '最近互动'), h('div', { style: { fontSize: 13 } }, fmtDate(detail.stats?.lastTime))),
            h('div', null, h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '跨度'), h('div', { style: { fontSize: 13 } }, `${detail.stats?.spanDays ?? 0} 天`)))),
        h('div', { className: 'wneur-card' },
          h('h3', null, '消息类型'),
          h(Donut, { distribution: detail.distribution })),
        h('div', { className: 'wneur-card' },
          h('h3', null, '月度活跃'),
          h(Sparkline, { data: detail.monthly, color })),
        detail.topKeywords.length > 0 && h('div', { className: 'wneur-card' },
          h('h3', null, '高频关键词'),
          h('div', { className: 'wneur-chips' },
            detail.topKeywords.map(item => h('button', {
              key: item.w, className: 'wneur-chip', onClick: () => onKeyword(item.w),
              title: `在图中高亮「${item.w}」`,
            }, `${item.w} ${item.n}`)))),
        h('div', { className: 'wneur-card' },
          h('h3', null, '最近消息'),
          h('div', { className: 'wneur-samples' },
            detail.samples.length === 0
              ? h('div', { className: 'wneur-note' }, '没有可展示的消息样本（可能是演示数据或已脱敏）')
              : detail.samples.slice(0, 6).map((sample, index) => h('div', {
                key: index, className: `wneur-sample ${sample.from === 'me' ? 'me' : ''}`,
              },
                h('time', null, `${new Date(sample.time).toLocaleString('zh-CN', { hour12: false })} · ${KIND_LABEL[sample.type] ?? sample.type}`),
                sample.text === '' ? '［非文本消息］' : sample.text)))),
        detail.neighbors.length > 0 && h('div', { className: 'wneur-card' },
          h('h3', null, '关联节点'),
          h('div', { className: 'wneur-chips' },
            detail.neighbors.slice(0, 16).map(item => h('button', {
              key: item.id, className: 'wneur-chip', onClick: () => onFocus(item.id),
            }, shortLabel(item.label, 10))))),
      )
    }

    function SettingsModal({ status, onClose, onRefresh, onToast }) {
      const [root, setRoot] = useState('')
      const [key, setKeyValue] = useState('')
      const [remember, setRemember] = useState(status?.settings?.rememberKey === true)
      const [busy, setBusy] = useState('')
      const accounts = status?.discovery?.accounts ?? []

      const saveKey = async () => {
        if (key.trim() === '') { onToast('请输入密钥'); return }
        setBusy('key')
        try {
          await api('key', { key: key.trim(), remember })
          setKeyValue('')
          onToast(remember ? '密钥已保存到本机设置' : '密钥已载入内存（重启后失效）')
          onRefresh()
        } catch (error) { onToast(String(error.message)) } finally { setBusy('') }
      }
      const addRoot = async (value) => {
        const target = String(value ?? '').trim()
        if (target === '') return
        setBusy('root')
        try {
          const scanResult = await api('scan', { root: target })
          if ((scanResult.accounts ?? []).length === 0) { onToast('该路径下没有找到微信账号目录'); return }
          const current = status?.settings?.manualRoots ?? []
          if (current.includes(target) === false) {
            await api('settings', { patch: { manualRoots: [...current, target] } })
          }
          setRoot('')
          onToast('数据目录已添加，正在读取…')
          onRefresh()
        } catch (error) { onToast(String(error.message)) } finally { setBusy('') }
      }
      const pickRoot = async () => {
        // 优先用 DSH 宿主提供的系统原生目录选择框；不可用时退回文本框。
        let picked = null
        try {
          const workspace = typeof runtime.ctx?.get === 'function' ? runtime.ctx.get('uiWorkspace') : null
          if (workspace !== null && typeof workspace?.pickDirectory === 'function') {
            picked = await workspace.pickDirectory()
          }
        } catch (error) {
          onToast(`无法打开系统选择框：${String(error.message ?? error)}`)
        }
        if (typeof picked === 'string' && picked.trim() !== '') {
          await addRoot(picked)
          return
        }
        if (picked === null) onToast('已取消选择，或该系统不支持原生选择框')
      }
      const harvest = async () => {
        setBusy('harvest')
        try {
          const started = await api('harvestKey', {})
          if (started?.ok !== true) {
            onToast(started?.message ?? `自动获取失败：${started?.reason ?? '未知原因'}`)
            return
          }
          onToast('已开始分级扫描微信进程内存（限预算限并发），通常 10–45 秒…')
          let result = null
          for (let round = 0; round < 120; round += 1) {
            await new Promise(resolve => setTimeout(resolve, 1500))
            const state = await api('harvestStatus', {})
            if (state?.state === 'done') { result = state.result; break }
            if (state?.state === 'idle') break
            const secs = Math.round(Number(state?.elapsedMs ?? 0) / 1000)
            if (round % 4 === 3) onToast(`正在扫描…已用 ${secs}s（上限约 45s，之后会自动停下）`)
          }
          if (result === null) { onToast('扫描仍在后台进行，稍后关闭窗口点「刷新」查看'); return }
          if (result.ok === true) {
            onToast('已自动获取并验证密钥，正在读取本地数据…')
            onRefresh()
          } else if (result.reason === 'TIMEOUT') {
            onToast('本次在时间/预算上限内没扫完（不代表没有密钥）。可再点一次继续扫描，或直接在下方粘贴密钥。')
          } else {
            onToast(result.message ?? `自动获取失败：${result.reason ?? '未知原因'}`)
          }
        } catch (error) { onToast(String(error.message)) } finally { setBusy('') }
      }
      const removeRoot = async (value) => {
        const current = status?.settings?.manualRoots ?? []
        await api('settings', { patch: { manualRoots: current.filter(item => item !== value) } })
        onRefresh()
      }
      const clearCache = async () => {
        setBusy('cache')
        try { await api('clearCache', {}); onToast('明文缓存已清理'); onRefresh() }
        catch (error) { onToast(String(error.message)) } finally { setBusy('') }
      }

      return h('div', { className: 'wneur-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wneur-modal' },
          h('h2', null, '数据与设置'),
          h('p', { className: 'lead' },
            '插件只读取本机微信数据目录，不上传任何内容。密钥仅用于在本地解密 SQLCipher 数据库，默认只驻留内存。'),
          h('div', { className: 'wneur-field' },
            h('label', null, '数据库密钥'),
            h('div', { className: 'row' },
              h('button', { className: 'wneur-btn primary', disabled: busy !== '', onClick: harvest },
                busy === 'harvest' ? '正在读取微信内存…' : '自动获取密钥'),
              h('span', { style: { fontSize: 11, color: 'var(--wnr-dim)' } },
                status?.key?.hasKey ? '已就绪' : '未配置')),
            h('p', { style: { marginTop: 6, fontSize: 11, color: 'var(--wnr-dim)' } },
              '自动获取会只读扫描微信进程内存中的密钥，不写任何文件；失败时可手动粘贴。'),
            h('details', { style: { marginTop: 4, fontSize: 11, color: 'var(--wnr-dim)' } },
              h('summary', { style: { cursor: 'pointer' } }, '自动获取失败怎么办？（点开看手动步骤）'),
              h('ol', { style: { margin: '6px 0 0 16px', padding: 0, lineHeight: 1.7 } },
                h('li', null, '确认微信已登录并保持运行，然后重新点「自动获取密钥」。'),
                h('li', null, '若仍失败，用社区工具读取密钥（如 chatlog / PyWxDump 的 get key 功能），复制 64 位十六进制串。'),
                h('li', null, '把该串粘贴到上面的输入框，点「载入」；需要重启后仍生效就勾选「记住密钥」。'),
                h('li', null, '载入成功会自动解密并重建图谱，标题栏的「演示」标记会消失。'))),
            h('div', { className: 'row', style: { marginTop: 8 } },
              h('input', {
                type: 'password', value: key, placeholder: status?.key?.hasKey ? '已配置，可覆盖' : '粘贴 64 位十六进制密钥',
                onChange: (event) => setKeyValue(event.target.value),
              }),
              h('button', { className: 'wneur-btn', disabled: busy !== '', onClick: saveKey }, busy === 'key' ? '保存中…' : '载入')),
            h('label', { className: 'wneur-check' },
              h('input', { type: 'checkbox', checked: remember, onChange: (event) => setRemember(event.target.checked) }),
              '记住密钥（写入本机 settings.json，有泄露风险）'),
            status?.key?.hasKey && h('button', {
              className: 'wneur-btn', style: { alignSelf: 'flex-start' },
              onClick: async () => { await api('key', { forget: true }); onToast('密钥已清除'); onRefresh() },
            }, '清除密钥')),
          h('div', { className: 'wneur-field' },
            h('label', null, '微信数据目录'),
            h('div', { className: 'row' },
              h('input', {
                value: root, placeholder: '例如 F:\\WeChat\\doc 或 …\\xwechat_files\\wxid_xxx',
                onChange: (event) => setRoot(event.target.value),
              }),
              h('button', { className: 'wneur-btn', disabled: busy !== '', onClick: pickRoot }, busy === 'root' ? '扫描中…' : '选择…'),
              h('button', { className: 'wneur-btn', disabled: busy !== '' || root.trim() === '', onClick: () => addRoot(root) }, '添加')),
            h('p', { style: { marginTop: 6, fontSize: 11, color: 'var(--wnr-dim)' } },
              '「选择…」打开系统文件夹对话框；微信 4.x 数据通常在 文档\\xwechat_files 下。')),
          (status?.settings?.manualRoots ?? []).length > 0 && h('div', { className: 'wneur-chips', style: { marginBottom: 12 } },
            status.settings.manualRoots.map(item => h('button', {
              key: item, className: 'wneur-chip', title: '点击移除', onClick: () => removeRoot(item),
            }, shortLabel(item, 28) + ' ×'))),
          h('div', { className: 'wneur-field' },
            h('label', null, `自动发现的账号（${accounts.length}）`),
            accounts.length === 0
              ? h('div', { className: 'wneur-note' }, '未发现账号。若微信 4.x 把数据放在自定义盘符，请在上方手动添加。')
              : accounts.map(account => h('div', { key: account.id, style: { marginBottom: 8 } },
                h('div', { style: { fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' } },
                  h('b', null, account.name),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    `${account.layout === 'wechat4' ? '微信 4.x' : '微信 3.x'} · ${account.stats.files} 库 · ${fmtBytes(account.stats.bytes)}`)),
                h('div', { className: 'wneur-db-list', style: { marginTop: 4 } },
                  account.databases.slice(0, 12).map(db => h('div', { key: db.file },
                    h('b', { style: { fontWeight: 400 } }, db.file),
                    h('span', null, fmtBytes(db.size)),
                    h('span', { className: db.state === 'encrypted' ? 'enc' : 'plain' },
                      db.state === 'encrypted' ? '加密' : db.state === 'plain' ? '明文' : '空'))))))),
          h('div', { className: 'wneur-field' },
            h('label', null, '缓存'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              h('span', null, status?.cache?.dir ?? '—'),
              h('button', { className: 'wneur-btn', disabled: busy !== '', onClick: clearCache }, busy === 'cache' ? '清理中…' : '清理明文缓存'))),
          h('div', { className: 'wneur-actions' },
            h('button', { className: 'wneur-btn', onClick: onClose }, '关闭'),
            h('button', { className: 'wneur-btn primary', onClick: () => { onRefresh(); onClose() } }, '应用并刷新')),
        ))
    }

    /* ------------------------------------------------------------------ *
     * 主面板
     * ------------------------------------------------------------------ */

    function PanelInner() {
      const canvasRef = useRef(null)
      const rendererRef = useRef(null)
      const [status, setStatus] = useState(null)
      const [graph, setGraph] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [selected, setSelected] = useState(null)
      const [hover, setHover] = useState(null)
      const [toast, setToast] = useState('')
      const [showSettings, setShowSettings] = useState(false)
      const [showLegend, setShowLegend] = useState(false)
      const [harvesting, setHarvesting] = useState(false)
      const [search, setSearch] = useState('')
      const [timeIndex, setTimeIndex] = useState(-1)
      const [playing, setPlaying] = useState(false)
      const [view, setView] = useState({
        layout: 'galaxy', showTopics: true, showGroups: true, showCooccurrence: true,
        minTier: 'weak', pulse: true, glow: 6, autoRotate: true, labels: true,
      })

      // 外观主题必须在任何依赖它的渲染/依赖数组之前取值（否则触发 TDZ）
      const scheme = useScheme()

      const showToast = useCallback((message) => {
        setToast(message)
        window.setTimeout(() => setToast(current => (current === message ? '' : current)), 2600)
      }, [])

      const loadGraph = useCallback(async (options = {}) => {
        setLoading(true)
        setError('')
        try {
          const [statusValue, graphValue] = await Promise.all([
            api('status'),
            api('graph', { refresh: options.refresh === true }),
          ])
          setStatus(statusValue)
          setGraph(graphValue.graph)
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { loadGraph() }, [loadGraph])

      // 一键：微信保持登录运行 -> 从进程内存里反推 SQLCipher 密钥 -> 重新构建图谱
      const autoKey = useCallback(async () => {
        setHarvesting(true)
        try {
          // Host 侧是后台任务：这里拿到 jobId 后轮询，避免长请求把按钮卡死。
          const started = await api('harvestKey', {})
          if (started?.ok !== true) {
            showToast(started?.message ?? `自动获取失败：${started?.reason ?? '未知原因'}`)
            return
          }
          showToast('正在从微信进程内存定向提取数据库密钥（每个库一把），通常几秒…')
          let result = null
          for (let round = 0; round < 120; round += 1) {
            await new Promise(resolve => setTimeout(resolve, 1500))
            const state = await api('harvestStatus', {})
            if (state?.state === 'done') { result = state.result; break }
            if (state?.state === 'idle') break
            const secs = Math.round(Number(state?.elapsedMs ?? 0) / 1000)
            if (round % 4 === 3) showToast(`正在提取密钥…已用 ${secs}s`)
          }
          if (result === null) { showToast('提取仍在后台进行，稍后点「刷新」查看结果'); return }
          if (result.ok === true) {
            const got = Number(result.keys ?? 0)
            const total = Number(result.total ?? 0)
            showToast(got > 0
              ? `已获取并验证 ${got}${total > 0 ? `/${total}` : ''} 个数据库的密钥，正在读取本地聊天记录…`
              : '已自动获取并验证密钥，正在读取本地聊天记录…')
            await loadGraph({ refresh: true })
          } else if (result.reason === 'TIMEOUT') {
            showToast('本次在时间/预算上限内没扫完（不代表没有密钥）。可再点一次继续扫描，或直接在设置里粘贴密钥。')
          } else {
            showToast(result.message ?? `自动获取失败：${result.reason ?? '未知原因'}`)
          }
        } catch (cause) {
          showToast(String(cause && cause.message ? cause.message : cause))
        } finally {
          setHarvesting(false)
        }
      }, [loadGraph, showToast])

      // 渲染引擎
      useEffect(() => {
        if (canvasRef.current === null) return undefined
        const renderer = new NeuronRenderer(canvasRef.current, {
          onHover: (info) => setHover(info),
          onPick: (info) => {
            setSelected(info === null ? null : info.id)
            if (info === null) { setDetail(null); return }
            setDetailLoading(true)
            api('node', { id: info.id })
              .then(value => setDetail(value))
              .catch(cause => showToast(String(cause.message)))
              .finally(() => setDetailLoading(false))
          },
          onFocus: (id) => {
            setSelected(id)
            rendererRef.current?.setFocus(id)
            setDetailLoading(true)
            api('node', { id }).then(value => setDetail(value)).catch(() => {}).finally(() => setDetailLoading(false))
          },
        })
        renderer.attach()
        renderer.setScheme(runtime.scheme)
        rendererRef.current = renderer
        return () => {
          renderer.detach()
          rendererRef.current = null
        }
      }, [showToast])

      useEffect(() => {
        if (graph !== null) rendererRef.current?.setGraph(graph)
      }, [graph])

      useEffect(() => {
        rendererRef.current?.setScheme(scheme)
      }, [scheme])

      useEffect(() => {
        rendererRef.current?.setView({ ...view, search, timeIndex })
      }, [view, search, timeIndex])

      useEffect(() => {
        rendererRef.current?.setSelected(selected)
      }, [selected])

      // 时间轴播放
      useEffect(() => {
        if (!playing || graph === null) return undefined
        const total = graph.timeline?.length ?? 0
        if (total === 0) { setPlaying(false); return undefined }
        const timer = window.setInterval(() => {
          setTimeIndex(current => {
            const next = current + 1
            if (next >= total) { setPlaying(false); return total - 1 }
            return next
          })
        }, 420)
        return () => window.clearInterval(timer)
      }, [playing, graph])

      // 快捷键
      useEffect(() => {
        const onKey = (event) => {
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
          if (event.code === 'Space') { event.preventDefault(); setPlaying(value => !value) }
          if (event.code === 'Escape') { setSelected(null); setDetail(null) }
          if (event.key === 'r' || event.key === 'R') rendererRef.current?.reset()
          if (event.key === 'f' || event.key === 'F') rendererRef.current?.setFocus(selected ?? 's')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selected])

      const timeline = graph?.timeline ?? []
      const nodes = graph?.nodes ?? []
      const edges = graph?.edges ?? []
      const counts = graph?.meta?.counts ?? { nodes: 0, edges: 0, messages: 0 }
      const tierCounts = useMemo(() => {
        const map = { core: 0, friend: 0, regular: 0, weak: 0, silent: 0, topic: 0 }
        for (const node of nodes) map[node.tier] = (map[node.tier] ?? 0) + 1
        return map
      }, [nodes])
      const ranking = useMemo(
        () => nodes.filter(node => node.type === 'person' || node.type === 'group').sort((a, b) => b.score - a.score).slice(0, 12),
        [nodes],
      )
      const buckets = timeline.length
      const currentBucket = timeIndex >= 0 && timeIndex < buckets ? timeline[timeIndex] : null

      const patchView = useCallback((patch) => setView(current => ({ ...current, ...patch })), [])

      const exportJson = useCallback(() => {
        if (graph === null) return
        const payload = { exportedAt: new Date().toISOString(), preferences: view, graph }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `wechat-neuron-${new Date().toISOString().slice(0, 10)}.json`
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 4000)
        showToast('图谱已导出为 JSON')
      }, [graph, view, showToast])

      const importJson = useCallback(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json,.json'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (file === undefined) return
          try {
            const text = await file.text()
            const parsed = JSON.parse(text)
            const candidate = parsed.graph ?? parsed
            const result = await api('importGraph', { graph: candidate })
            if (result.ok !== true) throw new Error(result.error?.message ?? '导入失败')
            await loadGraph()
            showToast(`已导入 ${result.counts.nodes} 个节点 / ${result.counts.edges} 条边`)
          } catch (cause) { showToast(`导入失败：${String(cause.message)}`) }
        }
        input.click()
      }, [loadGraph, showToast])

      return h('div', { className: 'wneur', 'data-scheme': scheme },
        h('header', { className: 'wneur-head' },
          h(IconNeuron, { size: 20 }),
          h('div', { className: 'wneur-title' },
            h('h1', null, '神经元图谱',
              h('span', { className: `wneur-badge ${graph?.meta?.source === 'demo' ? 'demo' : 'real'}` },
                graph?.meta?.source === 'demo' ? '演示' : '本地')),
            h('small', null,
              `${fmtNum(counts.nodes)} 节点 · ${fmtNum(counts.edges)} 关系 · ${fmtNum(counts.messages)} 消息`,
              graph?.meta?.timeRange ? ` · ${fmtDate(graph.meta.timeRange[0])} → ${fmtDate(graph.meta.timeRange[1])}` : '')),
          h('div', { className: 'wneur-grow' }),
          h('div', { className: 'wneur-search' },
            h('span', null, '⌕'),
            h('input', {
              value: search, placeholder: '搜索联系人 / 群 / 话题',
              onChange: (event) => setSearch(event.target.value),
            })),
          h('button', { className: 'wneur-btn', onClick: () => loadGraph({ refresh: true }), title: '重新读取本地数据' }, '刷新'),
          h('button', { className: 'wneur-btn', onClick: exportJson }, '导出'),
          h('button', { className: 'wneur-btn', onClick: importJson }, '导入'),
          h('button', { className: 'wneur-btn', onClick: () => setShowSettings(true) }, '设置')),
        (() => {
          const isDemo = graph?.meta?.source === 'demo'
          const roots = status?.settings?.manualRoots ?? []
          const hasKey = status?.key?.hasKey === true
          const accounts = status?.discovery?.accounts ?? []
          if (graph === null) return null
          if (!isDemo) {
            return h('div', { className: 'wneur-banner', 'data-kind': 'ok' },
              h('b', null, '本地数据已解密'),
              h('span', null, `共 ${accounts.length} 个微信账号 · 全部内容仅在本机处理`))
          }
          if (roots.length > 0 || accounts.length > 0) {
            const dbCount = accounts.reduce((sum, item) => sum + (item.databases?.length ?? 0), 0)
            return h('div', { className: 'wneur-banner' },
              h('b', null, hasKey ? '密钥已载入，但还没读到消息' : '已找到微信数据目录，但数据库是加密的'),
              h('span', null, hasKey
                ? '请点「刷新」重试；若仍为空，可用「设置 → 诊断」查看表结构。'
                : `检测到 ${accounts.length} 个账号 / ${dbCount} 个加密库。点右侧从运行中的微信读取密钥（需保持微信登录）。`),
              h('span', { className: 'spacer' }),
              !hasKey && h('button', {
                className: 'wneur-btn primary', disabled: harvesting, onClick: autoKey,
              }, harvesting ? '正在读取…' : '自动获取密钥'),
              h('button', { className: 'wneur-btn', onClick: () => setShowSettings(true) }, '设置'))
          }
          return h('div', { className: 'wneur-banner', 'data-kind': 'error' },
            h('b', null, '还没找到微信数据目录'),
            h('span', null, '默认会扫描 文档\\xwechat_files 与 文档\\WeChat Files；也可在设置里手动指定。'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'wneur-btn primary', onClick: () => setShowSettings(true) }, '选择数据目录'))
        })(),
        h('div', { className: 'wneur-main' },
          h('div', { className: 'wneur-rail' },
            h('div', { className: 'wneur-card' },
              h('h3', null, '布局'),
              h('div', { className: 'wneur-seg', style: { gridTemplateColumns: '1fr 1fr' } },
                LAYOUTS.map(layout => h('button', {
                  key: layout.id, title: layout.hint,
                  'aria-pressed': view.layout === layout.id,
                  onClick: () => patchView({ layout: layout.id }),
                }, layout.label)))),
            h('div', { className: 'wneur-card' },
              h('h3', null, '重要度分层'),
              TIERS.filter(tier => tier.id !== 'topic').map(tier => h('label', { className: 'wneur-check', key: tier.id },
                h('input', {
                  type: 'checkbox',
                  checked: (TIER_ORDER[view.minTier] ?? 4) >= (TIER_ORDER[tier.id] ?? 4),
                  onChange: (event) => {
                    if (!event.target.checked) patchView({ minTier: tier.id })
                  },
                }),
                h('i', { className: 'wneur-dot', style: { color: tier.color, width: 7, height: 7 } }),
                tier.label,
                h('em', null, tierCounts[tier.id] ?? 0)))),
            h('div', { className: 'wneur-card' },
              h('h3', null, '显示'),
              [
                ['showTopics', '话题节点'],
                ['showGroups', '群聊节点'],
                ['showCooccurrence', '共同群聊关系'],
                ['labels', '节点标签'],
                ['pulse', '信号脉冲'],
                ['autoRotate', '自动旋转'],
              ].map(([key, label]) => h('label', { className: 'wneur-check', key },
                h('input', {
                  type: 'checkbox', checked: view[key] === true,
                  onChange: (event) => patchView({ [key]: event.target.checked }),
                }), label))),
            h('div', { className: 'wneur-card' },
              h('h3', null, '重要度榜',
                h('button', { className: 'wneur-btn', style: { padding: '1px 6px', fontSize: 10 }, onClick: () => { setSelected('s'); rendererRef.current?.setFocus('s') } }, '聚焦我')),
              h('div', { className: 'wneur-rank' },
                ranking.map((node, index) => h('button', {
                  key: node.id,
                  onClick: () => {
                    setSelected(node.id)
                    rendererRef.current?.setFocus(node.id)
                    setDetailLoading(true)
                    api('node', { id: node.id }).then(value => setDetail(value)).catch(() => {}).finally(() => setDetailLoading(false))
                  },
                },
                  h('i', null, index + 1),
                  h('b', null, shortLabel(node.label, 10)),
                  h(TierPill, { tier: node.tier, score: node.score }))))),
          ),
          h('div', { className: 'wneur-canvas-wrap' },
            h('canvas', { ref: canvasRef, className: 'wneur-canvas' }),
            showLegend && h(Legend, { onClose: () => setShowLegend(false) }),
            !showLegend && h('button', {
              className: 'wneur-btn', style: { position: 'absolute', left: 14, top: 14, zIndex: 2 },
              onClick: () => setShowLegend(true),
            }, '图例'),
            h('div', { className: 'wneur-stat' },
              h('div', null, h('b', null, fmtNum(counts.nodes)), h('span', null, '节点')),
              h('div', null, h('b', null, fmtNum(counts.edges)), h('span', null, '关系')),
              h('div', null, h('b', null, fmtNum(counts.messages)), h('span', null, '消息'))),
            h('div', { className: 'wneur-hint' },
              '拖拽旋转 · 滚轮缩放 · 单击查看画像 · 双击聚焦 · ',
              h('span', { className: 'wneur-kbd' }, '空格'), ' 播放时间轴 · ',
              h('span', { className: 'wneur-kbd' }, 'R'), ' 复位'),
            hover !== null && h('div', {
              className: 'wneur-tip',
              style: { left: Math.min((hover.x ?? 0) + 16, 9999), top: (hover.y ?? 0) + 16 },
            },
              h('b', null, hover.label), h('br'),
              h('span', null, `${TIERS.find(item => item.id === hover.tier)?.label ?? hover.tier} · 重要度 ${hover.score}`)),
            loading && h('div', { className: 'wneur-loading' }, h('div', { className: 'wneur-spin' }), '正在读取本地数据并构建图谱…'),
            error !== '' && !loading && h('div', { className: 'wneur-empty' },
              h('b', null, '读取失败'),
              h('span', null, error),
              h('button', { className: 'wneur-btn', onClick: () => loadGraph({ refresh: true }) }, '重试')),
          ),
          (selected !== null) && h(DetailDrawer, {
            detail: detail, loading: detailLoading,
            onClose: () => { setSelected(null); setDetail(null) },
            onFocus: (id) => { setSelected(id); rendererRef.current?.setFocus(id) },
            onKeyword: (word) => { setSearch(word); showToast(`已高亮「${word}」`) },
          }),
        ),
        h('footer', { className: 'wneur-timeline' },
          h('button', {
            className: 'wneur-btn', 'aria-pressed': playing,
            onClick: () => setPlaying(value => !value), disabled: buckets === 0,
          }, playing ? '暂停' : '播放'),
          h('button', { className: 'wneur-btn', onClick: () => { setPlaying(false); setTimeIndex(-1) }, disabled: timeIndex < 0 }, '全部'),
          h('input', {
            type: 'range', min: 0, max: Math.max(0, buckets - 1), value: Math.max(0, timeIndex),
            onChange: (event) => { setPlaying(false); setTimeIndex(Number(event.target.value)) },
            disabled: buckets === 0,
          }),
          h('span', { className: 'meta' },
            currentBucket === null
              ? (buckets === 0 ? '无时间轴数据' : `全部时间 · ${buckets} 个时间桶`)
              : `${currentBucket.t} · ${fmtNum(currentBucket.messages)} 条 · ${currentBucket.activeNodes} 个活跃节点`),
          h('span', { className: 'wneur-kbd', title: '空格播放/暂停' }, 'Space')),
        showSettings && h(SettingsModal, {
          status, onClose: () => setShowSettings(false),
          onRefresh: () => loadGraph({ refresh: true }),
          onToast: showToast,
        }),
        toast !== '' && h('div', { className: 'wneur-toast' }, toast),
      )
    }

    function Panel(props) {
      try {
        return PanelInner(props)
      } catch (cause) {
        const detail = cause && (cause.stack || cause.message) ? (cause.stack || cause.message) : String(cause)
        window.__wnrPanelError = detail
        return h('pre', { style: { color: '#ff9b9b', background: '#1a0d12', padding: '16px', margin: '16px', borderRadius: '10px', whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: 1.5 } }, 'WNEUR_RENDER_ERROR:\n' + detail)
      }
    }

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */

    const exported = {
      inject: ['slots'],
      apply(ctx) {
        runtime.ctx = ctx
        const style = document.createElement('style')
        style.dataset.pluginCss = 'wechat-neuron'
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove())

        // 跟随 DSH 外观主题：主题服务的事件 + 系统配色偏好双保险
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const republish = () => publishScheme(detectScheme())
            runtime.scheme = detectScheme()
            const disposers = []
            try {
              const theme = typeof ctx.get === 'function' ? ctx.get('theme') : null
              if (theme !== null && typeof ctx.on === 'function') {
                disposers.push(ctx.on('theme/change', republish))
              }
            } catch { /* ignore */ }
            if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
              const media = window.matchMedia('(prefers-color-scheme: light)')
              const onMedia = () => republish()
              if (typeof media.addEventListener === 'function') {
                media.addEventListener('change', onMedia)
                disposers.push(() => media.removeEventListener('change', onMedia))
              }
            }
            return () => {
              for (const dispose of disposers) {
                try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
              }
            }
          }, 'wechat-neuron: theme follow')
        }

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'wechat-neuron',
            order: 50,
            label: '神经元图谱',
            icon: IconNeuron,
          }, function SidebarEntry() { return h(IconNeuron, { size: 18 }) })), 'wechat-neuron: sidebar entry')

          ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'wechat-neuron',
          }, Panel)), 'wechat-neuron: main panel')
        }
      },
    }

    if (globalThis.__WNEUR_TEST__ === true) {
      exported.__test = { NeuronRenderer, GALAXY, galaxyMath }
    }

    return exported
  },
})
