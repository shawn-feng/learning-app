"""权益认证中台 - 网页页面

- `/`     首页：服务介绍 + 折叠登录（平台列表 → 二维码）
- `/login` 登录页（复用首页，自动展开登录面板）
- `/me`    个人界面（任务 + 权益）
"""

# ==================== 公共样式 ====================
_BASE_CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --primary:#7c3aed; --primary2:#06b6d4; --ink:#0f172a; --muted:#64748b;
  --line:#e2e8f0; --bg-soft:#f8fafc; --radius:16px;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background:#f5f6fa; color:var(--ink); min-height:100vh;
}
a { color:var(--primary); text-decoration:none; }
/* ---------- 顶部导航 ---------- */
.nav {
  position:sticky; top:0; z-index:50; backdrop-filter:blur(12px);
  background:rgba(255,255,255,.82); border-bottom:1px solid var(--line);
}
.nav-inner { max-width:1080px; margin:0 auto; padding:12px 24px; display:flex; align-items:center; justify-content:space-between; }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; }
.brand-badge {
  width:34px; height:34px; border-radius:10px; flex:none;
  background:linear-gradient(135deg,var(--primary),var(--primary2));
  display:flex; align-items:center; justify-content:center; color:#fff; font-size:17px;
}
.nav-actions { display:flex; gap:10px; align-items:center; }
/* ---------- 按钮 ---------- */
.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  height:44px; padding:0 22px; border:none; border-radius:12px; cursor:pointer;
  font-size:14px; font-weight:600; transition:opacity .15s, transform .1s;
}
.btn:active { transform:scale(.98); }
.btn-primary { background:linear-gradient(135deg,var(--primary),var(--primary2)); color:#fff; }
.btn-outline { background:#fff; color:var(--ink); border:1.5px solid var(--line); }
.btn-ghost { background:transparent; color:var(--muted); }
.btn:hover { opacity:.9; }
.btn:disabled { opacity:.55; cursor:not-allowed; }
/* ---------- 首页 hero ---------- */
.hero {
  max-width:1080px; margin:0 auto; padding:64px 24px 40px; text-align:center;
}
.hero-badge {
  display:inline-flex; align-items:center; gap:6px; padding:6px 14px; border-radius:999px;
  background:#eef2ff; color:var(--primary); font-size:13px; font-weight:600; margin-bottom:18px;
}
.hero h1 { font-size:42px; font-weight:800; letter-spacing:-.5px; line-height:1.2; }
.hero h1 .grad { background:linear-gradient(135deg,var(--primary),var(--primary2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.hero p.lead { color:var(--muted); font-size:17px; max-width:640px; margin:18px auto 30px; line-height:1.7; }
.hero-actions { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }
/* ---------- 能力卡片 ---------- */
.section { max-width:1080px; margin:0 auto; padding:28px 24px; }
.section h2 { font-size:24px; font-weight:700; text-align:center; margin-bottom:6px; }
.section .sub2 { color:var(--muted); text-align:center; margin-bottom:28px; font-size:14px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:18px; }
.card {
  background:#fff; border:1px solid var(--line); border-radius:var(--radius);
  padding:24px; box-shadow:0 4px 18px rgba(15,23,42,.04); transition:transform .15s, box-shadow .15s;
}
.card:hover { transform:translateY(-3px); box-shadow:0 12px 30px rgba(15,23,42,.08); }
.card .icon {
  width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center;
  font-size:22px; margin-bottom:14px; background:linear-gradient(135deg,#eef2ff,#ecfeff);
}
.card h3 { font-size:16px; margin-bottom:8px; }
.card p { color:var(--muted); font-size:13.5px; line-height:1.65; }
/* ---------- 平台墙 ---------- */
.platforms { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; margin-top:6px; }
.plat-chip {
  display:flex; align-items:center; gap:8px; padding:10px 18px; border-radius:999px;
  background:#fff; border:1px solid var(--line); font-size:14px; font-weight:600;
}
.plat-chip .dot { width:8px; height:8px; border-radius:50%; }
.plat-chip.on .dot { background:#22c55e; }
.plat-chip.soon .dot { background:#cbd5e1; }
.plat-chip.soon { color:#94a3b8; }
/* ---------- 页脚 ---------- */
.footer { text-align:center; color:#94a3b8; font-size:12.5px; padding:40px 24px 30px; }
.icp { text-align:center; font-size:12.5px; padding:20px 24px 26px; }
.icp a { color:#94a3b8; }
.icp a:hover { color:var(--primary); }
.icp img { width:14px; height:14px; vertical-align:-2px; margin-right:3px; }
.icp .sep { margin:0 8px; color:#cbd5e1; }
.footer .icp-link { color:#94a3b8; }
.footer .icp-link img { width:14px; height:14px; vertical-align:-2px; margin-right:3px; }
.footer .icp-sep { margin:0 8px; color:#cbd5e1; }
/* ---------- 登录弹层 ---------- */
.overlay {
  position:fixed; inset:0; z-index:100; background:rgba(15,23,42,.45);
  display:none; align-items:center; justify-content:center; padding:20px;
}
.overlay.show { display:flex; }
.modal {
  background:#fff; border-radius:22px; width:100%; max-width:420px;
  box-shadow:0 30px 80px rgba(15,23,42,.25); overflow:hidden;
}
.modal-head { padding:22px 24px 0; display:flex; align-items:center; justify-content:space-between; }
.modal-head h3 { font-size:18px; }
.modal-close { border:none; background:#f1f5f9; width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:14px; color:#475569; }
.modal-body { padding:18px 24px 24px; }
/* 平台网格 */
.plat-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.plat-item {
  display:flex; align-items:center; gap:10px; padding:14px; border:1.5px solid var(--line);
  border-radius:14px; cursor:pointer; transition:border-color .15s, background .15s; background:#fff;
}
.plat-item:hover { border-color:var(--primary); background:#faf7ff; }
.plat-item:disabled { opacity:.5; cursor:not-allowed; }
.plat-item .plogo { width:32px; height:32px; border-radius:9px; flex:none; display:flex; align-items:center; justify-content:center; font-size:16px; color:#fff; }
.plat-item .pname { font-size:14px; font-weight:600; }
.plat-item .pstatus { font-size:11px; color:var(--muted); }
/* 二维码区 */
.qr-box { text-align:center; padding-top:6px; }
.qr-box img { width:200px; height:200px; border:1px solid var(--line); border-radius:14px; padding:8px; background:#fff; }
.qr-title { font-weight:600; font-size:15px; margin-top:14px; }
.qr-hint { color:var(--muted); font-size:12.5px; margin-top:6px; line-height:1.6; }
.back-link { display:inline-flex; align-items:center; gap:4px; color:var(--primary); font-size:13px; font-weight:600; cursor:pointer; margin-bottom:12px; }
.spin {
  width:36px; height:36px; border:3px solid #e2e8f0; border-top-color:var(--primary);
  border-radius:50%; margin:30px auto; animation:rot 1s linear infinite;
}
@keyframes rot { to { transform:rotate(360deg); } }
.msg { display:none; padding:10px 14px; border-radius:10px; font-size:13px; margin:12px 0; }
.msg.error { display:block; background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }
.msg.ok { display:block; background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; }
/* ---------- 个人页 ---------- */
.user { display:flex; align-items:center; gap:12px; padding:14px; background:var(--bg-soft); border-radius:14px; margin-bottom:20px; }
.user img { width:44px; height:44px; border-radius:50%; background:#e2e8f0; }
.user .name { font-weight:700; }
.user .meta { font-size:12px; color:var(--muted); }
/* 未绑定平台提示横幅 */
.bind-hint {
  display:none; align-items:center; gap:10px; padding:12px 14px; border-radius:12px;
  background:#fffbeb; border:1px solid #fde68a; color:#92400e; font-size:13px; margin-bottom:14px;
}
.bind-hint .bind-hint-text { flex:1; line-height:1.5; }
.panel { background:#fff; border-radius:var(--radius); padding:20px; box-shadow:0 4px 18px rgba(15,23,42,.04); margin-bottom:16px; }
.panel h2 { font-size:15px; color:#334155; margin:0 0 12px; }
.task { border:1.5px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:10px; }
.task .row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.task .t-title { font-weight:600; font-size:14px; }
.task .t-app { font-size:12px; color:var(--muted); }
.task .t-desc { font-size:13px; color:#475569; margin-top:6px; }
.task .t-reward { font-size:12px; color:var(--primary); margin-top:6px; }
.badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; }
.badge.claimed { background:#fef3c7; color:#92400e; }
.badge.submitted { background:#e0f2fe; color:#0369a1; }
.badge.granted { background:#dcfce7; color:#15803d; }
.badge.rejected { background:#fee2e2; color:#b91c1c; }
.badge.none { background:#f1f5f9; color:#475569; }
.btn-mini { border:none; border-radius:8px; padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer; }
.btn-mini.primary { background:linear-gradient(135deg,var(--primary),var(--primary2)); color:#fff; }
.btn-mini.ghost { background:#f1f5f9; color:#334155; }
.ent { display:flex; align-items:center; justify-content:space-between; border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:8px; font-size:13px; }
.logout { display:block; text-align:center; color:#dc2626; font-size:13px; margin-top:24px; }
.container { max-width:640px; margin:0 auto; padding:40px 20px; }
/* 平台绑定 */
.bind-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); }
.bind-row:last-child { border-bottom:none; }
.bind-name { font-weight:600; font-size:14px; }
.bind-scope { font-size:11px; color:var(--muted); margin-left:auto; }
.bind-chip { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:#dcfce7; color:#15803d; }
.bind-chip.no { background:#f1f5f9; color:#64748b; }
/* 视频 */
.video { display:flex; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); }
.video:last-child { border-bottom:none; }
.video img { width:64px; height:88px; object-fit:cover; border-radius:8px; background:#e2e8f0; flex:none; }
.video .vtitle { font-size:13.5px; font-weight:600; }
.video .vmeta { font-size:12px; color:#64748b; margin-top:4px; }
.vstat { font-size:12px; color:#64748b; margin-top:4px; }
.vcmt { padding:2px 0 10px 6px; border-bottom:1px solid var(--line); }
.vcmt:last-child { border-bottom:none; }
.cmt { display:flex; gap:8px; padding:8px 0; border-bottom:1px dashed var(--line); }
.cmt:last-child { border-bottom:none; }
.cmt img { width:28px; height:28px; border-radius:50%; background:#e2e8f0; flex:none; }
.cmt .c-nick { font-size:12.5px; font-weight:600; }
.cmt .c-text { font-size:13px; color:#0f172a; margin-top:2px; line-height:1.5; word-break:break-all; }
.cmt .c-meta { font-size:11px; color:#94a3b8; margin-top:2px; word-break:break-all; }
.c-tag { display:inline-block; padding:1px 6px; border-radius:999px; font-size:10.5px; font-weight:600; margin-left:4px; vertical-align:1px; }
.c-tag.ok { background:#dcfce7; color:#15803d; }
.c-tag.me { background:#e0f2fe; color:#0369a1; }
"""

# ==================== 个人页 ====================
_ME_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>个人中心 · 南昌嗯吧嗯互动数据分析工具</title>
<style>%CSS%</style>
</head>
<body>
<div class="container">
  <div class="panel" id="app" style="display:none">
    <div class="brand" style="justify-content:center;margin-bottom:16px"><div class="brand-badge">嗯</div>个人中心</div>
    <div class="bind-hint" id="bindHint">
      <span class="bind-hint-text">📹 要进行视频互动数据分析，请先绑定平台账号</span>
      <button class="btn-mini primary" id="bindNowBtn">立即绑定</button>
    </div>
    <div class="user">
      <img id="avatar" alt="avatar">
      <div><div class="name" id="nickname">…</div>
      <div class="meta" id="accountMeta">未绑定平台账号</div></div>
    </div>

    <h2 style="margin:18px 0 10px">🔗 平台账号</h2>
    <div id="bindList"><div class="task">加载中…</div></div>

    <h2 style="margin:18px 0 10px">📋 最新任务</h2>
    <div id="taskList"><div class="task">加载中…</div></div>

    <h2 style="margin:18px 0 10px">🎁 我的权益</h2>
    <div id="vipSummary"></div>
    <h2 style="margin:18px 0 10px;font-size:14px;color:#475569">📜 权益获取记录</h2>
    <div id="entList"><div class="task">加载中…</div></div>

    <a class="logout" href="#" id="logout">退出登录</a>
  </div>
</div>
<footer class="icp"><a href="https://beian.miit.gov.cn/#/Integrated/recordQuery" target="_blank" rel="noopener noreferrer">赣ICP备2026020397号-1</a><span class="sep">|</span><a href="https://beian.mps.gov.cn/#/query/webSearch" target="_blank" rel="noopener noreferrer"><img src="https://beian.mps.gov.cn/web/assets/logo01.6189a29f.png" alt="公安备案">赣公网安备36011102001315号</a></footer>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('benefit_token');
if (!TOKEN) { location.href = '/login'; }
localStorage.setItem('benefit_token', TOKEN);
const H = { 'Authorization': 'Bearer ' + TOKEN };

async function api(path, opt) {
  const res = await fetch(path, { headers: Object.assign({}, H, opt && {'Content-Type':'application/json'}), ...opt });
  if (res.status === 401) { localStorage.removeItem('benefit_token'); location.href = '/login'; }
  return res.json();
}

async function load() {
  const me = await api('/api/me');
  document.getElementById('app').style.display = 'block';
  document.getElementById('nickname').textContent = me.nickname || '用户 ' + me.user_id.slice(0,6);
  const av = document.getElementById('avatar');
  if (me.avatar_url) { av.src = me.avatar_url; } else { av.style.display = 'none'; }
  const acc = me.platform_accounts || [];
  document.getElementById('accountMeta').textContent =
    acc.length ? '已绑定：' + acc.map(a => a.platform + ' · ' + (a.nickname||'')).join('、') : '未绑定平台账号';

  // 未绑定任何平台：提示需要先绑定才能做视频互动数据分析
  const bindHint = document.getElementById('bindHint');
  bindHint.style.display = acc.length ? 'none' : 'flex';
  document.getElementById('bindNowBtn').onclick = () => openBind('douyin');

  loadBindings(acc);

  const t = await api('/api/me/tasks');
  const tl = document.getElementById('taskList'); tl.innerHTML = '';
  const acts = (t.tasks || []).slice().sort((a, b) =>
    ((a.my_status === 'granted' || a.my_status === 'rejected') ? 1 : 0) -
    ((b.my_status === 'granted' || b.my_status === 'rejected') ? 1 : 0));
  const BT_LABELS = { bt_like:'点赞视频', bt_follow:'关注账号', bt_finish:'完播视频', bt_share:'转发视频', bt_comment:'评论视频', bt_interact:'互动任务' };
  const GO_TEXT = { bt_like:'去点赞', bt_follow:'去关注', bt_finish:'去看完', bt_share:'去转发', bt_comment:'去评论', bt_interact:'去完成' };
  // 最新任务：只展示最近一条（可做的排最前），历史任务不再罗列
  acts.slice(0, 1).forEach(task => {
    const statusMap = { claimed:['已领取','claimed'], submitted:['待审核','submitted'], granted:['已完成','granted'], rejected:['未通过','rejected'], null:['未领取','none'] };
    const [label, cls] = statusMap[task.my_status || 'null'];
    const typeLabel = BT_LABELS[task.task_type] || task.task_type;
    const tc = task.target_config || {};
    // 官方账号二维码：码即入口，右侧只说扫码后做什么 + 显著权益
    const qrGuide = task.task_type === 'bt_interact' ? `
      <div style="display:flex;gap:14px;margin-top:12px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:12px;padding:12px">
        <img src="/static/douyin-account-qr.jpg" alt="官方账号抖音二维码"
             style="width:120px;height:auto;border-radius:10px;flex-shrink:0">
        <div style="display:flex;flex-direction:column;justify-content:space-between;min-width:0;flex:1">
          <div style="font-size:13.5px;color:#334155;line-height:2.05">
            扫码进入「${tc.target_name || '官方账号'}」主页，任选一条视频<br>
            <b>完播 · 点赞 · 评论 · 转发</b>，四件事都做完<br>
            回来点「我完成了，验证」，自动检测通过即解锁
          </div>
          <div style="margin-top:8px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;
                      border-radius:10px;padding:9px 12px;font-size:16px;font-weight:700;text-align:center">
            🎁 完成即得 ${rewardText(task.reward_config)}
          </div>
        </div>
      </div>` : '';
    const rewardLine = task.task_type === 'bt_interact' ? '' :
      `<div class="t-reward">🎁 ${rewardText(task.reward_config)}</div>`;
    const div = document.createElement('div'); div.className = 'task';
    div.innerHTML = `
      <div class="row">
        <div><div class="t-title">${task.title}</div><div class="t-app">来自 ${task.app_name} · ${typeLabel}${task.platform? ' · '+task.platform : ''}</div></div>
        <span class="badge ${cls}">${label}</span>
      </div>
      <div style="margin-top:10px">${qrGuide}${rewardLine}</div>`;
    const targetUrl = (task.target_config && task.target_config.target_url) || '';
    const isBT = String(task.task_type || '').startsWith('bt_') && task.verify_mode === 'auto';
    const hasFallback = !!(task.target_config && task.target_config.manual_fallback);
    const proofForm = () => {
      const form = document.createElement('div'); form.style.marginTop = '8px';
      form.innerHTML = `<input placeholder="做的是转发？粘贴转发凭证（截图说明/分享链接）" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">
        <button class="btn-mini" style="margin-top:6px">提交凭证人工审核</button>`;
      form.querySelector('button').onclick = async () => {
        const val = form.querySelector('input').value.trim();
        if (!val) return;
        await api('/api/me/tasks/' + task.task_instance_id + '/submit', { method:'POST', body: JSON.stringify({ proof_url: val }) });
        load();
      };
      return form;
    };
    const verifyBtn = () => {
      const btn = document.createElement('button');
      btn.className = 'btn-mini primary'; btn.textContent = '我完成了，验证'; btn.style.marginTop = '8px';
      btn.onclick = async () => {
        const r = await api('/api/me/tasks/' + task.task_id + '/direct-verify', { method: 'POST' });
        const note = (r.verify && r.verify.detail && r.verify.detail.note) ? ('\\n' + r.verify.detail.note) : '';
        if (r.detail) alert(r.detail);
        else if (r.status === 'claimed') alert('还没查到完成记录（完播/点赞/评论任一即可）' + note + (hasFallback ? '\\n若你做的是转发，请在下方提交凭证。' : ''));
        load();
      };
      return btn;
    };
    if (isBT && (task.can_claim || task.my_status === 'claimed')) {
      if (targetUrl) {
        const go = document.createElement('button');
        go.className = 'btn-mini primary'; go.textContent = GO_TEXT[task.task_type] || '去完成'; go.style.marginTop = '8px'; go.style.marginRight = '8px';
        go.onclick = () => window.open(targetUrl, '_blank');
        div.appendChild(go);
      }
      div.appendChild(verifyBtn());
      if (hasFallback) div.appendChild(proofForm());
    } else if (task.can_claim && targetUrl) {
      const go = document.createElement('button');
      go.className = 'btn-mini primary'; go.textContent = GO_TEXT[task.task_type] || '去完成'; go.style.marginTop = '8px'; go.style.marginRight = '8px';
      go.onclick = () => window.open(targetUrl, '_blank');
      const btn = document.createElement('button');
      btn.className = 'btn-mini'; btn.textContent = '领取任务'; btn.style.marginTop = '8px';
      btn.onclick = async () => { await api('/api/me/tasks/' + task.task_id + '/claim', { method:'POST' }); load(); };
      div.appendChild(go); div.appendChild(btn);
    } else if (task.can_claim) {
      const btn = document.createElement('button');
      btn.className = 'btn-mini primary'; btn.textContent = '领取任务'; btn.style.marginTop = '8px';
      btn.onclick = async () => { await api('/api/me/tasks/' + task.task_id + '/claim', { method:'POST' }); load(); };
      div.appendChild(btn);
    } else if (task.my_status === 'claimed' && task.verify_mode === 'manual') {
      const form = document.createElement('div'); form.style.marginTop = '8px';
      form.innerHTML = `<input id="proof-${task.task_instance_id}" placeholder="粘贴完成凭证链接或说明" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">
        <button class="btn-mini primary" style="margin-top:6px">提交凭证</button>`;
      form.querySelector('button').onclick = async () => {
        const val = form.querySelector('input').value.trim();
        if (!val) return;
        await api('/api/me/tasks/' + task.task_instance_id + '/submit', { method:'POST', body: JSON.stringify({ proof_url: val }) });
        load();
      };
      div.appendChild(form);
    }
    tl.appendChild(div);
  });
  if (!(t.tasks||[]).length) tl.innerHTML = '<div class="task" style="color:#94a3b8">暂无任务</div>';

  const e = await api('/api/me/entitlements');

  // 当前权益摘要：VIP 剩余天数 + 到期时间
  const vs = document.getElementById('vipSummary'); vs.innerHTML = '';
  const vip = e.vip || {};
  if (vip.expires_at && !vip.is_expired) {
    const exp = new Date(vip.expires_at);
    const remain = (vip.remaining_days != null) ? vip.remaining_days
      : Math.max(0, Math.ceil((exp - new Date()) / 86400000));
    vs.innerHTML = '<div class="task" style="text-align:center;padding:16px">'
      + '<div style="font-size:26px;font-weight:700;color:#7c3aed">VIP · 剩余 ' + remain + ' 天</div>'
      + '<div style="color:#64748b;font-size:13px;margin-top:4px">到期时间：' + exp.toLocaleString('zh-CN', {hour12: false}) + '</div>'
      + '</div>';
  } else {
    vs.innerHTML = '<div class="task" style="text-align:center;color:#94a3b8;padding:14px">当前无可用 VIP 权益，完成上方任务即可获得</div>';
  }

  // 权益获取记录（每次完成任务获得的权益，按时间倒序）
  const el = document.getElementById('entList'); el.innerHTML = '';
  (e.entitlements || []).forEach(ent => {
    const when = ent.granted_at ? new Date(String(ent.granted_at).replace(' ', 'T') + 'Z').toLocaleString('zh-CN', {hour12: false}) : '';
    const d = document.createElement('div'); d.className = 'ent';
    d.innerHTML = `<div><b>${rewardText(ent.reward_code)}</b><br><span style="color:#64748b">${ent.task_title || ''}${ent.app_name ? ' · 来自 ' + ent.app_name : ''}</span></div>
      <div style="color:#94a3b8;font-size:12px">${when}</div>`;
    el.appendChild(d);
  });
  if (!(e.entitlements||[]).length) el.innerHTML = '<div class="task" style="color:#94a3b8">暂无获取记录</div>';
}

async function loadBindings(acc) {
  const bl = document.getElementById('bindList'); bl.innerHTML = '';
  let b;
  try { b = await api('/api/me/bindings'); } catch(e) { bl.innerHTML = '<div class="task" style="color:#94a3b8">加载失败</div>'; return; }
  const bound = b.bindings || [];
  if (!bound.length) {
    bl.innerHTML = '<div class="bind-row"><span class="bind-name">尚未绑定任何平台</span>'
      + '<button class="btn-mini primary" onclick="location.href=&#39;/login&#39;">去绑定</button></div>';
  }
  bound.forEach(a => {
    const scopes = (a.scopes||'').split(',').filter(Boolean);
    const row = document.createElement('div'); row.className = 'bind-row';
    row.innerHTML = `<span class="bind-name">${a.platform} · ${a.nickname||''}</span>`
      + `<span class="bind-scope">${scopes.join(', ') || '无'}</span>`;
    const un = document.createElement('button');
    un.className = 'btn-mini ghost'; un.textContent = '解绑'; un.style.marginLeft='8px';
    un.onclick = async () => { if (confirm('确认解绑 '+a.platform+'？')) { await api('/api/me/bindings/'+a.platform, {method:'DELETE'}); loadBindings(acc); } };
    row.appendChild(un);
    bl.appendChild(row);
  });
  const boundSet = new Set(bound.map(a => a.platform));
  (b.supported_platforms || []).forEach(p => {
    if (!boundSet.has(p)) {
      const row = document.createElement('div'); row.className = 'bind-row';
      row.innerHTML = `<span class="bind-name">${p}</span><span class="bind-chip no">未绑定</span>`;
      const btn = document.createElement('button'); btn.className = 'btn-mini primary'; btn.textContent = '绑定'; btn.style.marginLeft = 'auto';
      btn.onclick = () => openBind(p);
      row.appendChild(btn); bl.appendChild(row);
    }
  });
}

function openBind(platform) {
  // 弹窗走扫码登录（mode=bind，需已登录；带 token 保证跨子域/无 Cookie 也能识别）
  window.open('/api/oauth/' + platform + '/authorize?mode=bind&token=' + encodeURIComponent(TOKEN), '_blank', 'width=480,height=560');
  const iv = setInterval(async () => {
    try { await api('/api/me/bindings'); clearInterval(iv); loadBindings(); } catch(e) {}
  }, 3000);
}

function rewardText(rc) {
  const r = rc || {};
  if (r.type === 'vip_days') return 'VIP ' + (r.days||1) + ' 天';
  if (r.type === 'points') return (r.points||0) + ' 积分';
  if (r.type === 'coupon') return '优惠券：' + (r.name || '');
  if (r.type === 'custom') return r.name || '自定义权益';
  return JSON.stringify(rc || {});
}

document.getElementById('logout').addEventListener('click', (e) => {
  e.preventDefault(); localStorage.removeItem('benefit_token'); location.href = '/login';
});
load();
</script>
</body>
</html>
"""


# ==================== 首页登录页（www 入口） ====================
_HOME_LOGIN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · 南昌嗯吧嗯互动数据分析工具</title>
<style>%CSS%
/* 首页布局：左功能简介 + 右登录区域 */
.home-layout {
  display:flex; align-items:center; justify-content:center; gap:64px;
  max-width:1080px; margin:0 auto; padding:8vh 24px 48px; min-height:72vh;
}
.intro { flex:1.1; min-width:0; }
.intro .brand { font-size:20px; margin-bottom:24px; }
.intro h1 { font-size:34px; font-weight:800; letter-spacing:-.5px; line-height:1.25; margin-bottom:14px; }
.intro h1 .grad { background:linear-gradient(135deg,var(--primary),var(--primary2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.intro .lead { color:var(--muted); font-size:15.5px; line-height:1.8; margin-bottom:22px; }
.intro ul.feat { list-style:none; }
.intro ul.feat li { display:flex; gap:10px; align-items:flex-start; padding:7px 0; color:#334155; font-size:14.5px; line-height:1.65; }
.intro ul.feat .fi { flex:none; }
/* 右侧登录卡片 */
.login-panel {
  flex:0 0 400px; background:#fff; border:1px solid var(--line); border-radius:22px;
  box-shadow:0 18px 50px rgba(15,23,42,.08); padding:26px 26px 20px;
}
.lp-title { font-size:20px; font-weight:800; text-align:center; margin-bottom:4px; }
.lp-sub { text-align:center; color:var(--muted); font-size:13px; margin-bottom:18px; }
.lp-sec-h { font-size:13px; font-weight:700; color:#334155; margin-bottom:10px; }
.lp-divider { display:flex; align-items:center; gap:10px; color:#94a3b8; font-size:12px; margin:18px 0 14px; }
.lp-divider::before, .lp-divider::after { content:""; flex:1; height:1px; background:var(--line); }
/* 账号密码登录 / 注册 */
.acct-input { width:100%; padding:11px 12px; border:1.5px solid var(--line); border-radius:10px; font-size:14px; margin-bottom:10px; background:#fff; }
.acct-input:focus { outline:none; border-color:var(--primary); }
.acct-btn { width:100%; }
.acct-switch { text-align:center; font-size:12.5px; color:var(--muted); margin-top:12px; }
.acct-switch a { cursor:pointer; font-weight:600; }
.acct-tip { font-size:12px; color:#94a3b8; text-align:center; margin-top:14px; line-height:1.6; }
@media (max-width: 920px) {
  .home-layout { flex-direction:column; gap:32px; padding-top:5vh; }
  .login-panel { flex:none; width:100%; max-width:440px; }
  .intro { text-align:center; }
  .intro .brand { justify-content:center; }
  .intro ul.feat { display:inline-block; text-align:left; }
}
</style>
</head>
<body>
<div class="home-layout">
  <!-- 左：网站功能简介 -->
  <section class="intro">
    <div class="brand"><div class="brand-badge">嗯</div>南昌嗯吧嗯互动数据分析工具</div>
    <h1>一个账号，完成各平台的<br><span class="grad">互动数据分析</span></h1>
    <p class="lead">
      登录并绑定你的平台账号，即可自动完成各平台的视频互动数据分析，任务进度与结果实时可见。
    </p>
    <ul class="feat">
      <li><span class="fi">🔐</span><span><b>统一认证</b>：支持账号注册登录，也可用抖音等平台账号扫码快捷登录</span></li>
      <li><span class="fi">📹</span><span><b>视频互动数据分析</b>：绑定平台账号后，自动分析你的视频互动数据</span></li>
      <li><span class="fi">📋</span><span><b>任务中心</b>：任务领取、进度与审核状态实时可见</span></li>
      <li><span class="fi">🎁</span><span><b>权益兑付</b>：任务完成自动发放权益，App 内直接使用</span></li>
    </ul>
  </section>

  <!-- 右：登录区域 -->
  <section class="login-panel">
    <div class="lp-title">登录</div>
    <div class="lp-sub">选择账号登录，或使用平台账号快捷登录</div>

    <!-- 上：账号登录（仅登录；注册已下线，新用户抖音扫码自动注册） -->
    <div class="lp-sec-h">账号登录</div>
    <div id="acctLogin">
      <input class="acct-input" type="email" id="liEmail" placeholder="邮箱" autocomplete="email">
      <input class="acct-input" type="password" id="liPwd" placeholder="密码" autocomplete="current-password">
      <button class="btn btn-primary acct-btn" id="liBtn">登 录</button>
      <div class="acct-switch">没有账号？<span style="cursor:default">使用下方抖音扫码，自动注册</span></div>
    </div>
    <div class="msg" id="acctMsg"></div>

    <div class="lp-divider">或</div>

    <!-- 下：平台账号登录 -->
    <div class="lp-sec-h">平台账号登录</div>
    <div id="viewPlats" class="plat-grid">
      <button class="plat-item" data-platform="douyin">
        <span class="plogo" style="background:#111827">抖</span>
        <span><span class="pname">抖音</span><br><span class="pstatus">扫码快捷登录</span></span>
      </button>
      <button class="plat-item" disabled>
        <span class="plogo" style="background:#ff6a00">快</span>
        <span><span class="pname">快手</span><br><span class="pstatus">即将上线</span></span>
      </button>
      <button class="plat-item" disabled>
        <span class="plogo" style="background:#ff2442">红</span>
        <span><span class="pname">小红书</span><br><span class="pstatus">即将上线</span></span>
      </button>
      <button class="plat-item" disabled>
        <span class="plogo" style="background:#00a1d6">B</span>
        <span><span class="pname">哔哩哔哩</span><br><span class="pstatus">即将上线</span></span>
      </button>
    </div>
    <p class="acct-tip">首次使用平台扫码登录将自动创建账号 · 登录即同意《用户协议》</p>
  </section>
</div>
<footer class="icp"><a href="https://beian.miit.gov.cn/#/Integrated/recordQuery" target="_blank" rel="noopener noreferrer">赣ICP备2026020397号-1</a><span class="sep">|</span><a href="https://beian.mps.gov.cn/#/query/webSearch" target="_blank" rel="noopener noreferrer"><img src="https://beian.mps.gov.cn/web/assets/logo01.6189a29f.png" alt="公安备案">赣公网安备36011102001315号</a></footer>
<script>
// 标准 OAuth 登录：点击平台后浏览器直接跳转到抖音授权页（302），
// 在 PC 页面扫码（或 App 内确认），授权后回跳到本站 /me。
document.querySelectorAll('.plat-item[data-platform]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    location.href = '/api/oauth/douyin/authorize?mode=login';
  });
});

// ---------- 账号登录（注册已下线：新用户抖音扫码自动注册） ----------
const acctMsg = document.getElementById('acctMsg');
const $id = (id) => document.getElementById(id);

async function acctPost(mode, body, btn, busyText) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = busyText;
  try {
    const res = await fetch('/api/account/' + mode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { acctMsg.className = 'msg error'; acctMsg.textContent = data.detail || '操作失败，请重试'; return; }
    localStorage.setItem('benefit_token', data.token);
    location.href = '/me';
  } catch (e) {
    acctMsg.className = 'msg error'; acctMsg.textContent = '网络错误，请重试';
  } finally { btn.disabled = false; btn.textContent = old; }
}

$id('liBtn').addEventListener('click', () => {
  const email = $id('liEmail').value.trim(), pwd = $id('liPwd').value;
  if (!email || !pwd) { acctMsg.className = 'msg error'; acctMsg.textContent = '请填写邮箱和密码'; return; }
  acctPost('login', { email, password: pwd }, $id('liBtn'), '登录中…');
});
$id('liPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $id('liBtn').click(); });
</script>
</body>
</html>
"""


def index_page() -> str:
    return _HOME_LOGIN_PAGE.replace("%CSS%", _BASE_CSS)


def login_page() -> str:
    """登录页：与首页登录页一致（选择平台 → 扫码 → 登录）"""
    return _HOME_LOGIN_PAGE.replace("%CSS%", _BASE_CSS)


def me_page() -> str:
    return _ME_PAGE.replace("%CSS%", _BASE_CSS)
