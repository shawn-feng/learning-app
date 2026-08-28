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
"""

# ==================== 首页 ====================
_INDEX_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>权益认证中台 · 为 App 提供认证与权益服务</title>
<style>%CSS%</style>
</head>
<body>
<!-- 顶部导航 -->
<div class="nav">
  <div class="nav-inner">
    <div class="brand"><div class="brand-badge">益</div>权益认证中台</div>
    <div class="nav-actions">
      <a class="btn btn-outline" href="#features">服务介绍</a>
      <button class="btn btn-primary" id="navLoginBtn">登 录</button>
    </div>
  </div>
</div>

<!-- Hero -->
<header class="hero">
  <div class="hero-badge">🚀 面向第三方 App 的一站式认证中台</div>
  <h1>一个账号，完成各平台任务<br>领取 <span class="grad">专属权益</span></h1>
  <p class="lead">
    权益认证中台为你的 App 提供统一的用户认证、营销任务发布与权益发放能力。
    用户扫码登录后，按任务说明完成互动，即可领取 App 发放的权益；App 通过开放接口随时查询与核销。
  </p>
  <div class="hero-actions">
    <button class="btn btn-primary" id="heroLoginBtn" style="height:48px;padding:0 30px;font-size:15px">扫码登录领取权益</button>
    <a class="btn btn-outline" href="#features" style="height:48px;padding:0 30px;font-size:15px">了解服务</a>
  </div>
</header>

<!-- 能力卡片 -->
<section class="section" id="features">
  <h2>核心能力</h2>
  <p class="sub2">从认证到兑付，全流程托管</p>
  <div class="cards">
    <div class="card">
      <div class="icon">🔐</div>
      <h3>统一认证</h3>
      <p>用户通过抖音等自媒体平台扫码即可登录，无需单独注册。中台统一管理用户身份与平台账号绑定。</p>
    </div>
    <div class="card">
      <div class="icon">📋</div>
      <h3>营销任务</h3>
      <p>App 自主创建任务（关注、发布、点赞评论等），配置完成条件与奖励，任务状态实时可见、可人工审核。</p>
    </div>
    <div class="card">
      <div class="icon">🎁</div>
      <h3>权益发放</h3>
      <p>任务完成自动发放权益并安全存储，App 通过开放接口查询用户权益，按权益情况提供服务与核销。</p>
    </div>
    <div class="card">
      <div class="icon">⚙️</div>
      <h3>开放接入</h3>
      <p>App 注册即得 app_id / app_secret，通过标准 REST API 创建任务、查询权益，几分钟完成对接。</p>
    </div>
    <div class="card">
      <div class="icon">🔍</div>
      <h3>智能验证</h3>
      <p>关注、发布等任务由平台开放 API 自动验证；点赞评论等提交凭证后人工审核，杜绝刷单。</p>
    </div>
    <div class="card">
      <div class="icon">🛡️</div>
      <h3>安全合规</h3>
      <p>JWT 双 Token（App/用户）隔离权限，密钥哈希存储，HTTPS 全链路加密，权益记录可追溯。</p>
    </div>
  </div>
</section>

<!-- 已支持平台 -->
<section class="section">
  <h2>支持登录的平台</h2>
  <p class="sub2">更多平台接入中</p>
  <div class="platforms" id="platWall">
    <div class="plat-chip on"><span class="dot"></span>抖音</div>
    <div class="plat-chip soon"><span class="dot"></span>快手</div>
    <div class="plat-chip soon"><span class="dot"></span>小红书</div>
    <div class="plat-chip soon"><span class="dot"></span>B 站</div>
    <div class="plat-chip soon"><span class="dot"></span>微信</div>
  </div>
</section>

<footer class="footer">© 2026 权益认证中台 · 为你的 App 提供认证与权益服务</footer>

<!-- 登录弹层 -->
<div class="overlay" id="loginOverlay">
  <div class="modal">
    <div class="modal-head">
      <h3 id="modalTitle">选择登录平台</h3>
      <button class="modal-close" id="closeBtn">✕</button>
    </div>
    <div class="modal-body">
      <div class="msg" id="msg"></div>
      <!-- 视图1：平台列表 -->
      <div id="viewPlats">
        <div class="plat-grid">
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
        <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:16px">首次登录将自动创建账号 · 登录即同意《用户协议》</p>
      </div>
      <!-- 视图2：二维码 -->
      <div id="viewQr" style="display:none">
        <div class="back-link" id="backBtn">← 返回平台选择</div>
        <div class="qr-box" id="qrBox"></div>
      </div>
    </div>
  </div>
</div>

<script>
const overlay = document.getElementById('loginOverlay');
const msg = document.getElementById('msg');
const viewPlats = document.getElementById('viewPlats');
const viewQr = document.getElementById('viewQr');
const qrBox = document.getElementById('qrBox');

function openLogin() { overlay.classList.add('show'); msg.className='msg'; msg.textContent=''; showPlats(); }
function closeLogin() { overlay.classList.remove('show'); stopPolling(); }
function showPlats() { viewQr.style.display='none'; viewPlats.style.display='block'; document.getElementById('modalTitle').textContent='选择登录平台'; }
function showMsg(text, type) { msg.className='msg '+(type||'error'); msg.textContent=text; }

document.getElementById('navLoginBtn').addEventListener('click', openLogin);
document.getElementById('heroLoginBtn').addEventListener('click', openLogin);
document.getElementById('closeBtn').addEventListener('click', closeLogin);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLogin(); });
document.getElementById('backBtn').addEventListener('click', showPlats);

// /login 直接展开登录
if (location.pathname === '/login') openLogin();

// ---------- 二维码登录 ----------
let pollTimer = null;
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

document.querySelectorAll('.plat-item[data-platform]').forEach(btn => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    viewPlats.style.display='none'; viewQr.style.display='block';
    document.getElementById('modalTitle').textContent='扫码登录 · 抖音';
    qrBox.innerHTML = '<div class="spin"></div><p class="qr-hint" style="margin-top:10px">正在生成二维码…</p>';
    try {
      const res = await fetch('/api/oauth/douyin/qrcode');
      const data = await res.json();
      if (!res.ok) {
        qrBox.innerHTML = '<p style="color:#94a3b8;font-size:14px;padding:20px 0">⚠️ ' + (data.detail || '二维码生成失败') + '</p>';
        return;
      }
      qrBox.innerHTML =
        '<img src="' + data.qr_data_url + '" alt="登录二维码">' +
        '<div class="qr-title">打开抖音 App 扫码登录</div>' +
        '<div class="qr-hint">使用抖音「扫一扫」扫描二维码，<br>在手机上确认授权后自动登录</div>';
      startPolling(data.qr_code);
    } catch (err) {
      qrBox.innerHTML = '<p style="color:#94a3b8;font-size:14px;padding:20px 0">网络错误，请重试</p>';
    } finally {
      btn.disabled = false;
    }
  });
});

async function startPolling(qrCode) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/oauth/douyin/status?qr_code=' + encodeURIComponent(qrCode));
      const data = await res.json();
      if (data.status === 'complete') {
        stopPolling();
        localStorage.setItem('benefit_token', data.token);
        qrBox.innerHTML = '<div class="qr-title">✅ 登录成功！</div><div class="qr-hint">正在跳转个人中心…</div>';
        setTimeout(() => location.href = '/me', 800);
      }
    } catch (e) { /* 忽略瞬时错误 */ }
  }, 2000);
}
</script>
</body>
</html>
"""

# ==================== 个人页 ====================
_ME_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>个人中心 · 权益认证中台</title>
<style>%CSS%</style>
</head>
<body>
<div class="container">
  <div class="panel" id="app" style="display:none">
    <div class="brand" style="justify-content:center;margin-bottom:16px"><div class="brand-badge">益</div>个人中心</div>
    <div class="user">
      <img id="avatar" alt="avatar">
      <div><div class="name" id="nickname">…</div>
      <div class="meta" id="accountMeta">未绑定平台账号</div></div>
    </div>

    <h2 style="margin:18px 0 10px">🔗 平台账号</h2>
    <div id="bindList"><div class="task">加载中…</div></div>

    <h2 style="margin:18px 0 10px">🎬 我的抖音视频</h2>
    <div id="videoList"><div class="task">加载中…</div></div>

    <h2 style="margin:18px 0 10px">📋 各应用任务</h2>
    <div id="taskList"><div class="task">加载中…</div></div>

    <h2 style="margin:18px 0 10px">🎁 我的权益</h2>
    <div id="entList"><div class="task">加载中…</div></div>

    <a class="logout" href="#" id="logout">退出登录</a>
  </div>
</div>
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
  document.getElementById('avatar').src = me.avatar_url || '';
  const acc = me.platform_accounts || [];
  document.getElementById('accountMeta').textContent =
    acc.length ? '已绑定：' + acc.map(a => a.platform + ' · ' + (a.nickname||'')).join('、') : '未绑定平台账号';

  loadBindings(acc);
  loadVideos(acc);

  const t = await api('/api/me/tasks');
  const tl = document.getElementById('taskList'); tl.innerHTML = '';
  (t.tasks || []).forEach(task => {
    const statusMap = { claimed:['已领取','claimed'], submitted:['待审核','submitted'], granted:['已完成','granted'], rejected:['未通过','rejected'], null:['未领取','none'] };
    const [label, cls] = statusMap[task.my_status || 'null'];
    const div = document.createElement('div'); div.className = 'task';
    div.innerHTML = `
      <div class="row">
        <div><div class="t-title">${task.title}</div><div class="t-app">来自 ${task.app_name} · ${task.platform||''}</div></div>
        <span class="badge ${cls}">${label}</span>
      </div>
      <div class="t-desc">${task.description || ''}</div>
      <div class="t-reward">🎁 ${rewardText(task.reward_config)}</div>`;
    if (task.can_claim) {
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
  const el = document.getElementById('entList'); el.innerHTML = '';
  (e.entitlements || []).forEach(ent => {
    const d = document.createElement('div'); d.className = 'ent';
    d.innerHTML = `<div><b>${ent.task_title || '权益'}</b><br><span style="color:#64748b">${ent.app_name||''} · ${ent.status}</span></div>
      <div style="color:#7c3aed;font-weight:600">${rewardText(ent.reward_code)}</div>`;
    el.appendChild(d);
  });
  if (!(e.entitlements||[]).length) el.innerHTML = '<div class="task" style="color:#94a3b8">暂无权益</div>';
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
    const hasVideo = scopes.includes('video.list.bind');
    const row = document.createElement('div'); row.className = 'bind-row';
    row.innerHTML = `<span class="bind-name">${a.platform} · ${a.nickname||''}</span>`
      + `<span class="bind-scope">${scopes.join(', ') || '无'}</span>`;
    const up = document.createElement('button');
    up.className = 'btn-mini ghost'; up.textContent = hasVideo ? '刷新授权' : '升级视频权限'; up.style.marginLeft = '8px';
    up.onclick = () => { location.href = '/api/oauth/' + a.platform + '/authorize?mode=upgrade&scopes=' + encodeURIComponent('user_info,video.list.bind,trial.whitelist') + '&token=' + encodeURIComponent(TOKEN); };
    row.appendChild(up);
    const un = document.createElement('button');
    un.className = 'btn-mini ghost'; un.textContent = '解绑'; un.style.marginLeft='4px';
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

async function loadVideos(acc) {
  const vl = document.getElementById('videoList'); vl.innerHTML = '';
  const douyin = (acc||[]).find(a => a.platform === 'douyin');
  if (!douyin) { vl.innerHTML = '<div class="task" style="color:#94a3b8">请先绑定抖音</div>'; return; }
  const scopes = (douyin.scopes||'').split(',');
  if (!scopes.includes('video.list.bind')) {
    const wrap = document.createElement('div');
    wrap.className = 'task'; wrap.style.textAlign = 'center'; wrap.style.padding = '18px';
    wrap.innerHTML = '<div style="font-size:14px;font-weight:600;margin-bottom:6px">还没有视频读取权限</div>'
      + '<div style="font-size:12.5px;color:#64748b;margin-bottom:12px">授权后可查看你的抖音视频列表（请用电脑打开授权页并扫码）</div>';
    const btn = document.createElement('button');
    btn.className = 'btn-mini primary'; btn.textContent = '授权获取视频权限';
    btn.onclick = () => { location.href = '/api/oauth/douyin/authorize?mode=upgrade&scopes=' + encodeURIComponent('user_info,video.list.bind,trial.whitelist') + '&token=' + encodeURIComponent(TOKEN); };
    wrap.appendChild(btn);
    vl.appendChild(wrap);
    return;
  }
  try {
    const v = await api('/api/me/douyin/videos');
    const list = v.videos || [];
    if (!list.length) { vl.innerHTML = '<div class="task" style="color:#94a3b8">暂无视频</div>'; return; }
    list.forEach(item => {
      const div = document.createElement('div'); div.className = 'video';
      const cover = item.cover_url || (item.video && item.video.cover) || '';
      const when = item.create_time ? new Date(item.create_time * 1000).toLocaleDateString() : '';
      div.innerHTML = `<img src="${cover}" alt="cover"><div><div class="vtitle">${(item.title||'未命名视频').slice(0,40)}</div>`
        + `<div class="vmeta">${when}</div></div>`;
      vl.appendChild(div);
    });
  } catch(e) {
    vl.innerHTML = '<div class="task" style="color:#b91c1c">' + (e.message || '加载失败') + '</div>';
  }
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
<title>登录 · 权益认证中台</title>
<style>%CSS%
/* 首页登录页扩展样式 */
.home-wrap { max-width:440px; margin:0 auto; padding:9vh 20px 40px; }
.home-brand { display:flex; align-items:center; justify-content:center; gap:10px; font-weight:700; font-size:18px; margin-bottom:6px; }
.home-h { text-align:center; font-size:22px; font-weight:800; margin:4px 0 6px; }
.home-sub { text-align:center; color:var(--muted); font-size:14px; margin-bottom:24px; }
.home-qr { text-align:center; min-height:236px; }
.home-qr img { width:210px; height:210px; border:1px solid var(--line); border-radius:14px; padding:8px; background:#fff; }
.home-qr .qr-title { font-weight:600; font-size:15px; margin-top:14px; }
</style>
</head>
<body>
<div class="home-wrap">
  <div class="home-brand"><div class="brand-badge">益</div>权益认证中台</div>
  <div class="home-h">登录</div>
  <div class="home-sub">选择一个平台，扫码即可登录</div>

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
  <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:18px">首次登录将自动创建账号 · 登录即同意《用户协议》</p>
</div>
<script>
// 标准 OAuth 登录：点击平台后浏览器直接跳转到抖音授权页（302），
// 在 PC 页面扫码（或 App 内确认），授权后回跳到本站 /me。
document.querySelectorAll('.plat-item[data-platform]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    location.href = '/api/oauth/douyin/authorize?mode=login';
  });
});
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
