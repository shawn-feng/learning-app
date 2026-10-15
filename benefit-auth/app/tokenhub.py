"""腾讯云 TokenHub 管控 API 客户端（TC3-HMAC-SHA256 签名）+ 家长 Key 发放逻辑。

凭证：环境变量 TOKENHUB_SECRET_ID / TOKENHUB_SECRET_KEY（腾讯云 CAM 子用户密钥，
已授 QcloudTokenHubFullAccess；管控域名 tokenhub.tencentcloudapi.com，限频 20 次/秒）。
Key 模型（实测 2026-10-09，ISSUE-174）：普通密钥 CreateApiKey 创建、DescribeApiKey 查详情
（含明文 ApiKey 与 QuotaSet 用量）、ModifyApiKeyInfo 调额（即时生效）、ModifyApiKeyStatus 启停
（约 8 秒生效）、DeleteApiKey 删除。数据面无音频端点（ASR 不可用）。
"""
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone

import httpx
import aiosqlite

from .database import DB_PATH, get_setting, set_setting

HOST = "tokenhub.tencentcloudapi.com"
SERVICE = "tokenhub"
VERSION = "2026-03-22"
REGION = os.environ.get("TOKENHUB_REGION", "ap-guangzhou")
PLATFORM = "maas"
DEFAULT_DAILY_CREDITS = 5_000_000          # 每家长默认日配额（tokens，2026-10-09 拍板）
DEFAULT_QUOTA_SETTING_KEY = "tokenhub_default_daily_credits"

# ---------------- 默认模型（管理页四下拉，2026-10-09 第二轮需求） ----------------
# 存储 settings 键 default_models：JSON {"text","vision","asr","tts"}，值为模型 ID。
# - text/vision：TokenHub 数据面模型 → ① 新建 Key 时绑定（Bindings）② app 服务端作各模块默认模型
# - asr/tts：TokenHub 数据面无音频端点（实测 404），当前可用项为 DashScope ASR（走服务端 env 兜底
#   Key）与 Edge TTS（免费）；其余选项为预留，选中后服务端自动回落可用通道。
DEFAULT_MODELS_SETTING_KEY = "default_models"
DEFAULT_VALIDITY_DAYS = 365                 # 新用户 Key 有效期（天）；到期后台自动禁用，管理页可续期
VALIDITY_SETTING_KEY = "tokenhub_validity_days"
QUOTA_UNIT_SETTING_KEY = "tokenhub_quota_cycle_unit"    # d（按日重置）/ m（按月重置）/ lifetime（总量不重置）
MONTH_START_SETTING_KEY = "tokenhub_month_start_day"    # m 周期的每月起始日（1~31）
DEFAULT_QUOTA_UNIT = "d"
DEFAULT_MONTH_START_DAY = 1
DEFAULT_MODELS = {
    "text": "deepseek/deepseek-flash",                        # 已实测（工具调用 ✅）
    "vision": "deepseek/deepseek-v4-flash-vision-exp",        # 已实测 ✅
    "asr": "qwen-audio-3.0-asr-flash",                        # DashScope（当前可用）
    "tts": "edge-tts",                                        # 免费（当前可用）
    "voice": "minimax_55e81114-ce7e-4ca1",                    # 合成音色（TTS=minimax-speech-* 时生效，管理页可选）
}
# 建 Key 绑定时始终包含的模型：向量检索（ISSUE-111/120）走同 Key 的 /embeddings，
# 若只绑 text/vision 会把向量调用一并拦掉，故恒定加入。
ALWAYS_BOUND_MODELS = ["kinfra-text-embedding-0.6b"]


class TokenHubError(Exception):
    """管控 API 返回 Response.Error 或调用失败"""

    def __init__(self, code: str, message: str):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


# 运行时凭证覆盖（ISSUE-174 管理页配置）：DB settings 的 tokenhub_ak/tokenhub_sk 优先于 env。
# 单进程内由 async 路由在调用 ops 前通过 set_runtime_config 同步（事件循环串行，无竞态）。
_cfg: dict[str, str] = {"sid": "", "sk": "", "region": ""}


def set_runtime_config(secret_id: str, secret_key: str, region: str | None = None) -> None:
    _cfg["sid"] = (secret_id or "").strip()
    _cfg["sk"] = (secret_key or "").strip()
    if region:
        _cfg["region"] = region.strip()


def get_config() -> tuple[str, str, str]:
    """返回 (secret_id, secret_key, region)：页面配置优先，env 兜底。"""
    sid = _cfg["sid"] or os.environ.get("TOKENHUB_SECRET_ID", "")
    sk = _cfg["sk"] or os.environ.get("TOKENHUB_SECRET_KEY", "")
    region = _cfg["region"] or os.environ.get("TOKENHUB_REGION", "ap-guangzhou")
    return sid.strip(), sk.strip(), region.strip()


def configured() -> bool:
    sid, sk, _ = get_config()
    return bool(sid and sk)


def mask_secret_id(sid: str) -> str:
    """SecretId 打码：显示前 8 位 + **** + 后 4 位（管理页凭证状态用）。"""
    sid = (sid or "").strip()
    if not sid:
        return ""
    if len(sid) <= 12:
        return f"{sid[:4]}****"
    return f"{sid[:8]}****{sid[-4:]}"


def mask_key_prefix(key: str) -> str:
    """Key 只显示前几位（管理后台列表用——按需求不回显任何后缀）。"""
    key = (key or "").strip()
    if not key:
        return ""
    return f"{key[:10]}****" if len(key) > 10 else "****"


def _sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def call(action: str, params: dict, timeout: float = 30.0) -> dict:
    """签名调用管控 API，返回 Response 字典；Error 时抛 TokenHubError。"""
    secret_id, secret_key, region = get_config()
    if not (secret_id and secret_key):
        raise TokenHubError("NotConfigured", "TokenHub 凭证未配置（管理页或 env 均未设置）")

    ts = int(datetime.now(timezone.utc).timestamp())
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    body = json.dumps(params, separators=(",", ":"), ensure_ascii=False)
    canonical = (
        "POST\n/\n\n"
        + f"content-type:application/json; charset=utf-8\nhost:{HOST}\n"
        + f"x-tc-action:{action.lower()}\n"
        + "\ncontent-type;host;x-tc-action\n"
        + _sha256hex(body)
    )
    sts = f"TC3-HMAC-SHA256\n{ts}\n{date}/{SERVICE}/tc3_request\n" + _sha256hex(canonical)
    k = _hmac(_hmac(_hmac(("TC3" + secret_key).encode("utf-8"), date), SERVICE), "tc3_request")
    sig = hmac.new(k, sts.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "Authorization": (
            f"TC3-HMAC-SHA256 Credential={secret_id}/{date}/{SERVICE}/tc3_request, "
            f"SignedHeaders=content-type;host;x-tc-action, Signature={sig}"
        ),
        "Content-Type": "application/json; charset=utf-8",
        "Host": HOST,
        "X-TC-Action": action,
        "X-TC-Version": VERSION,
        "X-TC-Region": region,
        "X-TC-Timestamp": str(ts),
    }
    try:
        r = httpx.post(f"https://{HOST}/", content=body.encode("utf-8"), headers=headers, timeout=timeout)
    except httpx.HTTPError as e:
        raise TokenHubError("NetworkError", f"管控 API 网络错误: {e}") from e
    try:
        resp = r.json().get("Response", {})
    except Exception as e:  # noqa: BLE001
        raise TokenHubError("BadResponse", f"管控 API 响应异常: HTTP {r.status_code}") from e
    err = resp.get("Error")
    if err:
        raise TokenHubError(err.get("Code", "Unknown"), err.get("Message", ""))
    return resp


# ---------------- 基础操作封装 ----------------

def create_api_key(name: str, remark: str = "", daily_credits: int | None = None) -> dict:
    """创建普通密钥（BindType=all 全模型；daily_credits 为日配额 tokens，None=不限额）。"""
    params: dict = {"ApiKeyName": name[:128], "Platform": PLATFORM, "BindType": "all", "Remark": remark[:200]}
    if daily_credits:
        params["Quotas"] = [{"CycleUnit": "d", "CycleCredits": str(int(daily_credits))}]
    return call("CreateApiKey", params)


def describe_api_key(api_key_id: str) -> dict:
    """查询密钥详情：Status / QuotaSet(CycleCredits/CycleUsed) / QuotaStatus / ApiKey 明文。"""
    return call("DescribeApiKey", {"Platform": PLATFORM, "ApiKeyId": api_key_id})


def modify_quota(api_key_id: str, credits: int, unit: str = "d", month_start_day: int = 1) -> dict:
    """调整配额（设置总量，即时生效）。unit：d/m/lifetime。"""
    qd = {"CycleUnit": unit, "CycleCredits": str(int(credits))}
    if unit == "m":
        qd["MonthStartDay"] = min(31, max(1, int(month_start_day)))
    return call("ModifyApiKeyInfo", {
        "Platform": PLATFORM, "ApiKeyId": api_key_id, "QuotasDesired": [qd],
    })


def set_status(api_key_id: str, enable: bool) -> dict:
    return call("ModifyApiKeyStatus", {"Platform": PLATFORM, "ApiKeyId": api_key_id,
                                       "Status": "enable" if enable else "disable"})


def delete_api_key(api_key_id: str) -> dict:
    return call("DeleteApiKey", {"Platform": PLATFORM, "ApiKeyId": api_key_id})


def list_api_keys(limit: int = 1) -> int:
    """连通性测试：列 Key 返回总数（DescribeApiKeyList，不抛即凭证有效）。"""
    resp = call("DescribeApiKeyList", {"Platform": PLATFORM, "Limit": max(1, min(int(limit), 100))})
    return int(resp.get("TotalCount") or 0)


def usage_by_models(days: int = 14) -> dict:
    """按模型维度的账号整体用量（DescribeUsageRankList Dimension=model，官方口径有延迟）。

    返回 {startTime, endTime, rows: [{model, input, output, total}]}，按 total 降序（API 原生排序）。
    注意口径：这是整个腾讯云账号（所有用户 Key 合并）的数据，用于管理员总览，不能按家长拆分。
    """
    days = max(1, min(int(days), 90))
    end = datetime.now(timezone(timedelta(hours=8)))
    start = end - timedelta(days=days)
    # Period=3600：日粒度聚合视图延迟大（实测近 24h 只出零头），小时视图新鲜；Stats 仍为区间总量
    resp = call("DescribeUsageRankList", {
        "Dimension": "model",
        "StartTime": start.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "EndTime": end.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "Period": 3600,
    })
    rows = []
    for item in resp.get("TopList") or []:
        stats = item.get("Stats") or {}
        rows.append({
            "model": item.get("Key", ""),
            "input": int(stats.get("InputTotalToken") or 0),
            "output": int(stats.get("OutputTotalToken") or 0),
            "total": int(stats.get("TotalToken") or 0),
        })
    return {
        "startTime": start.strftime("%Y-%m-%d"),
        "endTime": end.strftime("%Y-%m-%d"),
        "rows": rows,
    }


# ---------------- 平台模型列举（管理页默认模型下拉动态数据源） ----------------

_platform_models_cache: tuple[float, list] | None = None


def list_platform_models() -> list[dict]:
    """全量平台模型（DescribeModelList 分页，Limit 必须 <100；10 分钟缓存）。
    返回 [{id, name, type}]，type ∈ Text / Vision(图视频生成) / Multimodal / Embedding / Speech。"""
    global _platform_models_cache
    now = time.time()
    if _platform_models_cache and now - _platform_models_cache[0] < 600:
        return _platform_models_cache[1]
    out: list[dict] = []
    offset = 0
    while True:
        resp = call("DescribeModelList", {"Limit": 99, "Offset": offset})
        ms = resp.get("ModelSet") or []
        for m in ms:
            out.append({
                "id": m.get("ModelId", ""),
                "name": m.get("ModelName") or m.get("DisplayName") or m.get("ModelId", ""),
                "type": m.get("ModelType", ""),
            })
        if len(ms) < 99 or offset > 500:
            break
        offset += 99
    _platform_models_cache = (now, out)
    return out


def group_platform_models() -> dict[str, list[dict]]:
    """按管理页四类分组：text / vision / asr / tts。
    分类规则：ModelType=Speech 里含 asr → asr，含 tts/speech/indextts → tts；
    Multimodal → vision；Text 里名字含 vision/-vl/-5v/4v → vision，其余 → text。
    Vision 类型是图/视频**生成**模型（非读图理解）、Embedding、音乐/配音/音色设计等不进四类下拉。"""
    groups: dict[str, list[dict]] = {"text": [], "vision": [], "asr": [], "tts": []}
    for m in list_platform_models():
        mid = (m.get("id") or "").lower()
        mtype = (m.get("type") or "").lower()
        cat: str | None = None
        if "asr" in mid:
            cat = "asr"
        elif mtype == "speech":
            if any(w in mid for w in ("tts", "speech", "indextts")):
                cat = "tts"
        elif mtype == "multimodal":
            cat = "vision"
        elif mtype == "text":
            if any(w in mid for w in ("vision", "-vl", "vl-", "-5v", "4v")):
                cat = "vision"
            else:
                cat = "text"
        if cat:
            groups[cat].append(m)
    return groups


def mask_key(key: str) -> str:
    if not key or len(key) <= 14:
        return "***"
    return f"{key[:10]}****{key[-4:]}"


def quota_of(detail: dict) -> dict:
    """从 DescribeApiKey 响应提取配额摘要（QuotaSet 首项）。"""
    qs = (detail.get("QuotaSet") or [{}])
    q = qs[0] if qs else {}
    return {
        "cycleUnit": q.get("CycleUnit", ""),
        "cycleCredits": int(q.get("CycleCredits") or 0),
        "cycleUsed": int(q.get("CycleUsed") or 0),
        "quotaStatus": detail.get("QuotaStatus", ""),
        "keyStatus": detail.get("Status", ""),
    }


# ---------------- 家长 Key 发放（DB 层，async） ----------------

async def get_default_daily_credits(db) -> int:
    rows = await db.execute_fetchall("SELECT value FROM settings WHERE key=?", (DEFAULT_QUOTA_SETTING_KEY,))
    try:
        return int(rows[0]["value"])
    except Exception:  # noqa: BLE001
        return DEFAULT_DAILY_CREDITS


async def set_default_daily_credits(db, credits: int):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (DEFAULT_QUOTA_SETTING_KEY, str(int(credits))),
    )
    await db.commit()


async def get_default_models(db) -> dict:
    """管理页配置的四类默认模型；缺项回落内置默认。"""
    import json as _json
    rows = await db.execute_fetchall("SELECT value FROM settings WHERE key=?", (DEFAULT_MODELS_SETTING_KEY,))
    try:
        stored = _json.loads(rows[0]["value"]) if rows else {}
    except Exception:  # noqa: BLE001
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    return {k: str(stored.get(k) or DEFAULT_MODELS.get(k, "")) for k in DEFAULT_MODELS}


async def set_default_models(db, models: dict):
    import json as _json
    merged = await get_default_models(db)
    for k in DEFAULT_MODELS:
        v = str(models.get(k) or "").strip()
        if v:
            merged[k] = v
    await set_setting(db, DEFAULT_MODELS_SETTING_KEY, _json.dumps(merged, ensure_ascii=False))
    await db.commit()


async def get_default_validity_days(db) -> int:
    return int(await get_setting(db, VALIDITY_SETTING_KEY, "") or DEFAULT_VALIDITY_DAYS)


async def get_quota_cycle(db) -> tuple[str, int]:
    """重置周期：返回 (unit, month_start_day)。unit ∈ d/m/lifetime。"""
    unit = (await get_setting(db, QUOTA_UNIT_SETTING_KEY, "") or DEFAULT_QUOTA_UNIT).strip()
    if unit not in ("d", "m", "lifetime"):
        unit = "d"
    try:
        msd = int(await get_setting(db, MONTH_START_SETTING_KEY, "") or DEFAULT_MONTH_START_DAY)
    except ValueError:
        msd = DEFAULT_MONTH_START_DAY
    msd = min(31, max(1, msd))
    return unit, msd


async def get_default_settings(db) -> dict:
    """新用户初始配额与有效期（管理页可配）。"""
    unit, msd = await get_quota_cycle(db)
    return {
        "dailyCredits": await get_default_daily_credits(db),
        "validityDays": await get_default_validity_days(db),
        "cycleUnit": unit,
        "monthStartDay": msd,
    }


async def set_default_settings(db, daily_credits: int, validity_days: int,
                               cycle_unit: str = "d", month_start_day: int = 1):
    await set_setting(db, DEFAULT_QUOTA_SETTING_KEY, str(int(daily_credits)))
    await set_setting(db, VALIDITY_SETTING_KEY, str(int(validity_days)))
    if cycle_unit in ("d", "m", "lifetime"):
        await set_setting(db, QUOTA_UNIT_SETTING_KEY, cycle_unit)
    if cycle_unit == "m":
        await set_setting(db, MONTH_START_SETTING_KEY, str(min(31, max(1, int(month_start_day)))))
    await db.commit()


async def get_user_key_row(db, user_id: str) -> dict | None:
    rows = await db.execute_fetchall(
        "SELECT * FROM tokenhub_keys WHERE user_id=? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1",
        (user_id,),
    )
    return dict(rows[0]) if rows else None


async def ensure_user_key(db, user_id: str, *, daily_credits: int | None = None) -> dict:
    """幂等发放该用户的 TokenHub Key（无则创建并落库），返回 tokenhub_keys 行。

    daily_credits 传入时（管理员建 Key）覆盖默认配额；发放失败抛 TokenHubError，不落半截数据。
    """
    row = await get_user_key_row(db, user_id)
    if row:
        return row
    credits = daily_credits or await get_default_daily_credits(db)
    unit, msd = await get_quota_cycle(db)

    params: dict = {
        "ApiKeyName": f"learn-{user_id[:12]}"[:128],
        "Platform": PLATFORM,
        "BindType": "all",
        "Remark": f"学习伙伴家长配额Key user={user_id}",
    }
    if credits:
        quota = {"CycleUnit": unit, "CycleCredits": str(int(credits))}
        if unit == "m":
            quota["MonthStartDay"] = msd
        params["Quotas"] = [quota]

    # 2026-10-10 晚：改回 BindType=all（不再按模型绑定）——实测按模型 ID 绑定会让语音服务
    # （hy-asr-3.0-preview）路由解析失败（400「模型或服务不存在」），而全模型 Key 一切正常；
    # 模型调用全部由服务端发起，Key 只需承担配额限额，绑定并无安全收益。
    try:
        resp = create_params(params)
    except TokenHubError:
        # 创建失败（如配额参数不被接受等）→ 去掉限额保底重试，保证家长可用
        fallback = {k: v for k, v in params.items() if k != "Quotas"}
        resp = create_params(fallback)

    key_id = resp.get("ApiKeyId") or ""
    if not key_id:
        raise TokenHubError("BadResponse", "CreateApiKey 未返回 ApiKeyId")
    validity_days = await get_default_validity_days(db)
    expires_at = (datetime.now(_TZ) + timedelta(days=validity_days)).strftime("%Y-%m-%d") if validity_days > 0 else ""
    await db.execute(
        """INSERT INTO tokenhub_keys
           (id, user_id, api_key_id, api_key, status, quota_cycle_unit, quota_cycle_credits, note, expires_at)
           VALUES (?,?,?,?, 'active', ?, ?, '', ?)""",
        (f"tk_{user_id[:8]}_{key_id[-8:]}", user_id, key_id, "", unit, credits, expires_at),
    )
    # 建完立刻拉取明文落库（DescribeApiKey 返回 ApiKey 明文；避免二次依赖）
    try:
        detail = describe_api_key(key_id)
        await db.execute("UPDATE tokenhub_keys SET api_key=? WHERE user_id=? AND api_key_id=?",
                         (detail.get("ApiKey") or "", user_id, key_id))
    except TokenHubError:
        pass  # 明文拉取失败不阻断发放（服务端下次可经 /key 端点重试拉取）
    await db.commit()
    return await get_user_key_row(db, user_id)  # type: ignore[return-value]


def create_params(params: dict) -> dict:
    """CreateApiKey 薄封装（便于 ensure_user_key 的绑定失败回落重试）。"""
    return call("CreateApiKey", params)


# ---------------- 模型轮换（2026-10-10：改默认模型 → 批量换 Key，继承剩余配额） ----------------
# 背景：普通 Key 的模型绑定创建后不可改（ModifyApiKeyInfo 无 Bindings 参数）→ 换模型 = 换 Key。
# 平滑策略（双 Key）：先建新 Key（绑定新默认模型）并写入 DB → server 物化循环 5 分钟内自动切换
# → 旧 Key 延迟 30 分钟由后台循环回收（期间新旧并存，家长不断服）。
# 配额继承：新 Key 当期配额 = 旧 Key 剩余量（credits - used，腾讯不转移已用量，只能这么精确）；
# 原档位记入 pending_restore_credits，次日起由后台循环调回（否则全员降档到当天剩余）。

from zoneinfo import ZoneInfo  # noqa: E402

_TZ = ZoneInfo("Asia/Shanghai")
OLD_KEY_GRACE_MINUTES = 30


def _today_str() -> str:
    return datetime.now(_TZ).strftime("%Y-%m-%d")


def _next_cycle_start_str(month_start_day: int) -> str:
    """m 周期的下个周期起始日（YYYY-MM-DD）：本月/下月的 MonthStartDay。"""
    from datetime import timedelta
    today = datetime.now(_TZ).date()
    msd = min(31, max(1, int(month_start_day)))
    y, m = today.year, today.month
    for _ in range(2):
        try:
            cand = datetime(y, m, msd, tzinfo=_TZ).date()
        except ValueError:
            cand = (datetime(y, m, 1, tzinfo=_TZ) + timedelta(days=32)).date()
            cand = datetime(cand.year, cand.month, 1, tzinfo=_TZ).date()
        if cand > today:
            return cand.isoformat()
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return today.isoformat()


def _tomorrow_str() -> str:
    from datetime import timedelta
    return (datetime.now(_TZ) + timedelta(days=1)).strftime("%Y-%m-%d")


async def rotate_user_key(db, row: dict, new_text: str, new_vision: str) -> dict:
    """轮换单个用户的 Key：继承剩余配额（双 Key 平滑）。new_text/new_vision 保留兼容签名（不再用于绑定）。"""
    old_kid = row["api_key_id"]
    _, msd = await get_quota_cycle(db)

    # 1) 读旧 Key 配额（拿不到剩余 = 不可达/已删 → 按原档位重建）
    old_credits = int(row["quota_cycle_credits"] or 0)
    remaining = None
    try:
        q = quota_of(describe_api_key(old_kid))
        old_credits = int(q.get("cycleCredits") or old_credits)
        remaining = max(0, old_credits - int(q.get("cycleUsed") or 0))
    except TokenHubError:
        pass

    # 2) 建新 Key：BindType=all（2026-10-10 晚，同 ensure_user_key：按模型绑定会破坏语音路由）；
    #    当期配额 = 继承的剩余量（保持原重置周期）
    unit = (row.get("quota_cycle_unit") or "d").strip()
    quota_now = remaining if remaining is not None else old_credits
    quota = {"CycleUnit": unit, "CycleCredits": str(max(quota_now, 0))}
    if unit == "m":
        try:
            quota["MonthStartDay"] = min(31, max(1, int(await get_setting(db, MONTH_START_SETTING_KEY, "1"))))
        except Exception:  # noqa: BLE001
            quota["MonthStartDay"] = 1
    base: dict = {
        "ApiKeyName": f"learn-{row['user_id'][:12]}"[:128],
        "Platform": PLATFORM,
        "BindType": "all",
        "Remark": f"学习伙伴家长配额Key user={row['user_id']} (rotated)",
        "Quotas": [quota],
    }
    try:
        resp = call("CreateApiKey", base)
    except TokenHubError:
        # 配额参数被拒 → 1 token 占位重试（次日恢复档位）
        try:
            fallback = dict(base)
            fallback["Quotas"] = [{"CycleUnit": "d", "CycleCredits": "1"}]
            resp = call("CreateApiKey", fallback)
        except TokenHubError:
            base["Quotas"] = [{"CycleUnit": "d", "CycleCredits": "1"}]
            resp = call("CreateApiKey", base)
    new_kid = resp.get("ApiKeyId") or ""
    if not new_kid:
        raise TokenHubError("BadResponse", "CreateApiKey 未返回 ApiKeyId")

    # 3) 更新 DB 行：指向新 Key；原档位在下一周期起恢复（lifetime 无重置概念 → 不恢复）；旧 Key 30 分钟后回收
    new_plain = ""
    try:
        new_plain = describe_api_key(new_kid).get("ApiKey") or ""
    except TokenHubError:
        pass
    pending_restore = 0
    restore_after = ""
    if unit in ("d", "m") and remaining is not None and remaining < old_credits:
        pending_restore = old_credits
        restore_after = _tomorrow_str() if unit == "d" else _next_cycle_start_str(msd)
    await db.execute(
        """UPDATE tokenhub_keys SET
             api_key_id=?, api_key=?, quota_cycle_credits=?,
             pending_restore_credits=?, restore_after_date=?,
             pending_delete_key_id=?, rotated_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP
           WHERE id=?""",
        (new_kid, new_plain, old_credits,
         pending_restore, restore_after,
         old_kid, row["id"]),
    )
    await db.commit()
    return {
        "userId": row["user_id"], "oldKeyId": old_kid, "newKeyId": new_kid,
        "inheritedCredits": remaining if remaining is not None else old_credits,
        "restoreCredits": pending_restore,
    }


async def rotate_all_keys(db, new_text: str, new_vision: str) -> dict:
    """批量轮换所有 active Key（跳过 30 分钟内刚轮换过的）。"""
    rows = await db.execute_fetchall(
        "SELECT * FROM tokenhub_keys WHERE status='active' AND pending_delete_key_id='' "
        "ORDER BY created_at")
    rotated, failed, skipped = [], [], []
    for row in rows:
        try:
            rotated.append(await rotate_user_key(db, dict(row), new_text, new_vision))
        except TokenHubError as e:
            failed.append({"userId": row["user_id"], "error": str(e)})
    return {"rotatedCount": len(rotated), "rotated": rotated, "failed": failed, "skipped": skipped}


async def renew_user_key(db, user_id: str, days: int) -> dict:
    """续期：从 max(今天, 当前到期日) 起延长 days 天；若 Key 因到期被禁用则同时重新启用。"""
    row = await get_user_key_row(db, user_id)
    if not row:
        raise TokenHubError("NotFound", "该用户尚无 TokenHub Key")
    from .database import get_setting as _gs
    validity_days = int(await _gs(db, VALIDITY_SETTING_KEY, "") or DEFAULT_VALIDITY_DAYS)
    days = int(days) if days and int(days) > 0 else validity_days
    today = datetime.now(_TZ).date()
    cur = row.get("expires_at") or ""
    base = today
    if cur:
        try:
            cur_date = datetime.strptime(cur, "%Y-%m-%d").date()
            if cur_date > today:
                base = cur_date
        except ValueError:
            pass
    new_exp = (base + timedelta(days=days)).strftime("%Y-%m-%d")
    was_expired = cur and cur < today.strftime("%Y-%m-%d")
    if was_expired:
        set_status(row["api_key_id"], True)  # 到期禁用过的 Key 重新启用（约 8 秒生效）
    await db.execute(
        "UPDATE tokenhub_keys SET expires_at=?, status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (new_exp, row["id"]))
    await db.commit()
    return {"userId": user_id, "expiresAt": new_exp, "reEnabled": bool(was_expired)}


async def expire_due_keys(db) -> int:
    """到期禁用：expires_at 早于今天（即昨日含当天为最后可用日）的 active Key 全部禁用。"""
    today = datetime.now(_TZ).strftime("%Y-%m-%d")
    rows = await db.execute_fetchall(
        "SELECT * FROM tokenhub_keys WHERE status='active' AND expires_at != '' AND expires_at < ?",
        (today,))
    n = 0
    for row in rows:
        r = dict(row)
        try:
            set_status(r["api_key_id"], False)
        except TokenHubError:
            continue  # 下轮重试
        await db.execute("UPDATE tokenhub_keys SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                         (r["id"],))
        n += 1
    return n


async def process_pending_rotations(db) -> dict:
    """后台循环（每 5 分钟）：① 次日恢复原档位 ② 回收 30 分钟窗口外的旧 Key。"""
    from datetime import datetime, timedelta
    today = _today_str()
    now = datetime.now(timezone.utc)
    expired_n = await expire_due_keys(db)
    restored, deleted_old = 0, 0
    if expired_n:
        print("[tokenhub] 到期禁用 Key 数:", expired_n, flush=True)
    rows = await db.execute_fetchall(
        "SELECT * FROM tokenhub_keys WHERE status != 'deleted' AND "
        "(pending_restore_credits > 0 OR pending_delete_key_id != '')")
    for row in rows:
        r = dict(row)
        # ① 档位恢复（下一周期起把配额调回原档位；按 Key 自身周期调额）
        if r["pending_restore_credits"] > 0 and r["restore_after_date"] and r["restore_after_date"] <= today:
            try:
                unit = (r.get("quota_cycle_unit") or "d").strip()
                _, msd = await get_quota_cycle(db)
                modify_quota(r["api_key_id"], r["pending_restore_credits"], unit, msd)
            except TokenHubError:
                continue  # 下轮重试
            await db.execute(
                "UPDATE tokenhub_keys SET quota_cycle_credits=?, pending_restore_credits=0, "
                "restore_after_date='', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (r["pending_restore_credits"], r["id"]))
            restored += 1
        # ② 回收旧 Key（平滑窗口 30 分钟）
        if r["pending_delete_key_id"] and r["rotated_at"]:
            try:
                rotated_at = datetime.strptime(r["rotated_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except ValueError:
                rotated_at = None
            if rotated_at and now - rotated_at >= timedelta(minutes=OLD_KEY_GRACE_MINUTES):
                try:
                    delete_api_key(r["pending_delete_key_id"])
                except TokenHubError as e:
                    if e.code != "ResourceNotFound":
                        continue  # 下轮重试
                await db.execute("UPDATE tokenhub_keys SET pending_delete_key_id='', "
                                 "updated_at=CURRENT_TIMESTAMP WHERE id=?", (r["id"],))
                deleted_old += 1
    await db.commit()
    return {"restored": restored, "oldKeysDeleted": deleted_old, "expired": expired_n}


async def restore_loop():
    """后台任务：每 5 分钟处理档位恢复与旧 Key 回收（main.py startup 启动）。"""
    import asyncio
    import aiosqlite
    while True:
        try:
            db = await aiosqlite.connect(str(DB_PATH))
            db.row_factory = aiosqlite.Row
            try:
                result = await process_pending_rotations(db)
                if result["restored"] or result["oldKeysDeleted"]:
                    print("[tokenhub] 轮换后续:", result, flush=True)
            finally:
                await db.close()
        except Exception as e:  # noqa: BLE001
            print("[tokenhub] restore loop error:", str(e)[:200], flush=True)
        await asyncio.sleep(300)
