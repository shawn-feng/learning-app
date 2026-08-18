"""学习伙伴云服务 - 网页认证页面

渲染登录 / 注册 / 个人页 HTML，与 /api/auth/* API 配合实现网页登录。
页面使用纯内联 CSS/JS，无外部依赖，可离线渲染。
"""

# ---------- 通用样式 ----------
_PAGE_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  min-height: 100vh;
  background: linear-gradient(135deg, #eef2ff 0%, #f8fafc 50%, #ecfeff 100%);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px;
}
.card {
  background: #ffffff; border-radius: 20px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
  padding: 40px 36px; width: 100%; max-width: 400px;
}
.logo { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 8px; }
.logo-badge {
  width: 44px; height: 44px; border-radius: 12px; flex: none;
  background: linear-gradient(135deg, #4f46e5, #06b6d4);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 22px; font-weight: 700;
}
h1 { font-size: 22px; font-weight: 700; color: #0f172a; text-align: center; }
.sub { color: #64748b; font-size: 14px; text-align: center; margin: 8px 0 28px; }
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px; }
.field input {
  width: 100%; height: 44px; padding: 0 14px; border: 1.5px solid #e2e8f0; border-radius: 10px;
  font-size: 15px; color: #0f172a; outline: none; transition: border-color .15s, box-shadow .15s;
  background: #f8fafc;
}
.field input:focus { border-color: #4f46e5; background: #fff; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12); }
.btn {
  width: 100%; height: 46px; border: none; border-radius: 10px; cursor: pointer;
  font-size: 15px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, #4f46e5, #06b6d4);
  transition: opacity .15s, transform .1s; margin-top: 8px;
}
.btn:hover { opacity: .92; }
.btn:active { transform: scale(.99); }
.btn:disabled { opacity: .6; cursor: not-allowed; }
.footer { text-align: center; font-size: 13px; color: #64748b; margin-top: 20px; }
.footer a { color: #4f46e5; font-weight: 600; text-decoration: none; }
.footer a:hover { text-decoration: underline; }
.msg { display: none; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
.msg.error { display: block; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.msg.ok { display: block; background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
.hint { font-size: 12px; color: #94a3b8; margin-top: 4px; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px;
  background: #eef2ff; color: #4f46e5; font-weight: 600; }
"""

# ---------- 登录页 ----------
LOGIN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · 学习伙伴</title>
<style>%CSS%</style>
</head>
<body>
  <div class="card">
    <div class="logo"><div class="logo-badge">学</div><h1>学习伙伴</h1></div>
    <p class="sub">登录你的账号，管理学习旅程</p>
    <div class="msg" id="msg"></div>
    <form id="loginForm" novalidate>
      <div class="field">
        <label for="email">邮箱</label>
        <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" placeholder="请输入密码" autocomplete="current-password" required>
      </div>
      <button class="btn" type="submit" id="btn">登 录</button>
    </form>
    <div class="footer">还没有账号？<a href="/auth/register">立即注册</a></div>
  </div>
<script>
const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('btn');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg'; msg.textContent = '';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { msg.className = 'msg error'; msg.textContent = '请输入邮箱和密码'; return; }
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '登录失败，请检查邮箱和密码');
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('parent_id', data.parent_id);
    window.location.href = '/me';
  } catch (err) {
    msg.className = 'msg error'; msg.textContent = err.message;
    btn.disabled = false; btn.textContent = '登 录';
  }
});
</script>
</body>
</html>
"""

# ---------- 注册页 ----------
REGISTER_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>注册 · 学习伙伴</title>
<style>%CSS%</style>
</head>
<body>
  <div class="card">
    <div class="logo"><div class="logo-badge">学</div><h1>创建账号</h1></div>
    <p class="sub">注册学习伙伴家长账号</p>
    <div class="msg" id="msg"></div>
    <form id="regForm" novalidate>
      <div class="field">
        <label for="email">邮箱</label>
        <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" placeholder="至少 6 位" autocomplete="new-password" minlength="6" required>
      </div>
      <div class="field">
        <label for="password2">确认密码</label>
        <input type="password" id="password2" name="password2" placeholder="再次输入密码" autocomplete="new-password" required>
      </div>
      <button class="btn" type="submit" id="btn">注 册</button>
    </form>
    <div class="footer">已有账号？<a href="/auth/login">直接登录</a></div>
  </div>
<script>
const form = document.getElementById('regForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('btn');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg'; msg.textContent = '';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  if (!email || !password) { msg.className = 'msg error'; msg.textContent = '请填写邮箱和密码'; return; }
  if (password.length < 6) { msg.className = 'msg error'; msg.textContent = '密码至少需要 6 位'; return; }
  if (password !== password2) { msg.className = 'msg error'; msg.textContent = '两次输入的密码不一致'; return; }
  btn.disabled = true; btn.textContent = '注册中…';
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '注册失败，请稍后重试');
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('parent_id', data.parent_id);
    window.location.href = '/me';
  } catch (err) {
    msg.className = 'msg error'; msg.textContent = err.message;
    btn.disabled = false; btn.textContent = '注 册';
  }
});
</script>
</body>
</html>
"""

# ---------- 个人页（空壳，待建设） ----------
ME_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>个人中心 · 学习伙伴</title>
<style>%CSS%</style>
</head>
<body>
  <div class="card" style="max-width:520px">
    <div class="logo"><div class="logo-badge">学</div><h1>个人中心</h1></div>
    <p class="sub" id="welcome">加载中…</p>
    <div class="msg ok" id="msg" style="display:none"></div>
    <div style="border:1.5px dashed #cbd5e1; border-radius:12px; padding:28px; text-align:center; color:#64748b; margin:16px 0 8px;">
      <div style="font-size:15px; font-weight:600; color:#334155; margin-bottom:6px;">🚧 个人页面建设中</div>
      <div style="font-size:13px;">这里将展示你的账号信息、孩子管理与学习数据，敬请期待。</div>
    </div>
    <div class="footer" style="margin-top:16px">
      <span class="badge" id="email-badge" style="margin-right:8px">—</span>
      <a href="#" id="logout" style="color:#dc2626">退出登录</a>
    </div>
  </div>
<script>
const token = localStorage.getItem('auth_token');
if (!token) { window.location.href = '/auth/login'; }
else {
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(async (res) => {
      if (res.status === 401) { localStorage.removeItem('auth_token'); window.location.href = '/auth/login'; return; }
      const data = await res.json();
      if (res.ok && data.email) {
        document.getElementById('welcome').textContent = '欢迎回来 👋';
        document.getElementById('email-badge').textContent = data.email;
      }
    })
    .catch(() => {});
}
document.getElementById('logout').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem('auth_token');
  localStorage.removeItem('parent_id');
  window.location.href = '/auth/login';
});
</script>
</body>
</html>
"""


def _render(template: str) -> str:
    """注入公共 CSS，返回完整 HTML 页面。"""
    return template.replace("%CSS%", _PAGE_CSS)


def login_page() -> str:
    return _render(LOGIN_PAGE)


def register_page() -> str:
    return _render(REGISTER_PAGE)


def me_page() -> str:
    return _render(ME_PAGE)
