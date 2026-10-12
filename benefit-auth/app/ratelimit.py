"""登录防撞库 / 防滥用限流（内存滑动窗 + SQLite 账号锁 + 全局熔断 + 统一失败延迟）。

分层原则：**昂贵操作（密码哈希、验证码挑战生成）之前先检查**，超限直接 429/423，
不让攻击者消耗服务端 CPU。

- 滑动窗 / 熔断 → 进程内存（单 worker 单进程天然共享；扩多 worker 需换集中存储）
- 账号 / app_id 锁定 → SQLite `login_lockouts`（重启不掉锁）
- 阈值全部可经 env 覆盖

使用方式（登录端点标准三段）：
    ip = ratelimit.client_ip(request)
    if ratelimit.ip_exceeded(f"login:{ip}", ratelimit.IP_WINDOW_S, ratelimit.IP_LOGIN_MAX):
        raise HTTPException(429, "请求过于频繁，请稍后再试")
    if ratelimit.fuse_tripped():
        raise HTTPException(429, "系统繁忙，请稍后再试")
    ... 密码校验 ...
    失败：ratelimit.fuse_record_fail(); await ratelimit.acct_record_fail(db, subject); ratelimit.fail_delay()
    成功：await ratelimit.acct_reset(db, subject)
"""
import os
import random
import time

from .database import get_setting

# ---- 阈值（env 可调） ----
IP_LOGIN_MAX = int(os.environ.get("RL_IP_LOGIN_MAX", "10"))          # 每 IP 登录请求数
IP_WINDOW_S = int(os.environ.get("RL_IP_WINDOW_S", "900"))           # 滑动窗 15 分钟
VERIFY_HOURLY_MAX = int(os.environ.get("RL_VERIFY_HOURLY_MAX", "20"))  # 每 IP 每小时验证尝试
CHALLENGE_DAILY_MAX = int(os.environ.get("RL_CHALLENGE_DAILY_MAX", "20"))  # 每 IP 每日验证码挑战数
CHALLENGE_DAY_S = 86400
ACCT_FAILS = int(os.environ.get("RL_ACCT_FAILS", "5"))               # 连续失败 N 次
ACCT_LOCK_S = int(os.environ.get("RL_ACCT_LOCK_S", "900"))           # 锁 15 分钟
FUSE_FAILS = int(os.environ.get("RL_FUSE_FAILS", "30"))              # 全局失败熔断阈值
FUSE_WINDOW_S = int(os.environ.get("RL_FUSE_WINDOW_S", "60"))
FUSE_LOCK_S = int(os.environ.get("RL_FUSE_LOCK_S", "600"))           # 熔断 10 分钟
APP_TOKEN_FAILS = int(os.environ.get("RL_APP_TOKEN_FAILS", "5"))     # app_secret 错 N 次
APP_TOKEN_LOCK_S = int(os.environ.get("RL_APP_TOKEN_LOCK_S", "900"))

_buckets: dict[str, list[float]] = {}
_fuse = {"fails": [], "locked_until": 0.0}


def _now() -> float:
    return time.monotonic()


def client_ip(request) -> str:
    """真客户端 IP：nginx 已设 X-Real-IP（9001 仅绑 127.0.0.1，外部无法伪造该头）。"""
    return (request.headers.get("x-real-ip") or "").strip() or (request.client.host if request.client else "unknown")


def _prune(key: str, window_s: int) -> list[float]:
    ts = _buckets.setdefault(key, [])
    cut = _now() - window_s
    while ts and ts[0] < cut:
        ts.pop(0)
    return ts


def ip_exceeded(key: str, window_s: int, max_n: int) -> bool:
    """检查（不计数）：滑动窗内是否已达上限。"""
    return len(_prune(key, window_s)) >= max_n


def hit(key: str, window_s: int, max_n: int) -> bool:
    """计数 + 返回是否超限。"""
    ts = _prune(key, window_s)
    ts.append(_now())
    return len(ts) > max_n


def fuse_tripped() -> bool:
    return _now() < _fuse["locked_until"]


def fuse_record_fail() -> None:
    f = _fuse
    cut = _now() - FUSE_WINDOW_S
    f["fails"] = [t for t in f["fails"] if t > cut]
    f["fails"].append(_now())
    if len(f["fails"]) >= FUSE_FAILS:
        f["locked_until"] = _now() + FUSE_LOCK_S


def fail_delay() -> None:
    """失败后统一随机延迟：拉平时序指纹 + 减速脚本。"""
    time.sleep(random.uniform(0.3, 0.8))


# ---------------- 账号 / app_id 锁定（SQLite 持久） ----------------

async def acct_status(db, subject: str, max_fails: int, lock_s: int) -> tuple[bool, int]:
    """返回 (是否锁定, 剩余秒数)。锁定且未到期 → True。（locked_until 用 epoch，重启有效）"""
    rows = await db.execute_fetchall("SELECT fails, locked_until FROM login_lockouts WHERE subject=?", (subject,))
    if not rows:
        return False, 0
    fails, locked_until = int(rows[0]["fails"]), float(rows[0]["locked_until"])
    now = time.time()
    if locked_until > now:
        return True, int(locked_until - now)
    if fails >= max_fails and locked_until <= now:
        # 锁定期已过：自动解封清零
        await db.execute("DELETE FROM login_lockouts WHERE subject=?", (subject,))
        await db.commit()
    return False, 0


async def acct_record_fail(db, subject: str, max_fails: int, lock_s: int) -> tuple[bool, int]:
    """记一次失败；达到阈值即锁定。返回 (是否锁定, 剩余秒数)。"""
    rows = await db.execute_fetchall("SELECT fails, locked_until FROM login_lockouts WHERE subject=?", (subject,))
    fails = int(rows[0]["fails"]) + 1 if rows else 1
    now = time.time()
    if fails >= max_fails:
        until = now + lock_s
        await db.execute(
            "INSERT INTO login_lockouts (subject, fails, locked_until, updated_at) VALUES (?,?,?,datetime('now')) "
            "ON CONFLICT(subject) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until, "
            "updated_at=excluded.updated_at",
            (subject, fails, until))
        await db.commit()
        return True, lock_s
    await db.execute(
        "INSERT INTO login_lockouts (subject, fails, locked_until, updated_at) VALUES (?,?,0,datetime('now')) "
        "ON CONFLICT(subject) DO UPDATE SET fails=excluded.fails, updated_at=excluded.updated_at",
        (subject, fails))
    await db.commit()
    return False, 0


async def acct_reset(db, subject: str) -> None:
    await db.execute("DELETE FROM login_lockouts WHERE subject=?", (subject,))
    await db.commit()
