"""用户管理数据服务（ISSUE-176 后续：管理后台「用户管理」菜单）。

聚合三层数据：
- 本地 DB：users（账号）、tokenhub_keys（Key 发放/轮换状态）、legacy_parents（201 parent_id 映射）
- 腾讯 DescribeApiKey（每 Key）：启停、当期配额已用/档位、限额包时间、绑定模型、IP 白名单、更新时间
- 腾讯 DescribeUsageRankList（按天扫描近 14 天）：每天哪些 Key 有调用 → 最近使用日期/活跃天数/14 天用量
  （这是"最近使用时间"的唯一云端来源；注意用量管道有分钟级以上延迟，日期粒度展示）

性能：远端 describe 与用量扫描均带进程内缓存（60s / 600s）；用户量级为家庭规模，内存内过滤排序。
"""
import time
from datetime import datetime, timedelta, timezone

from .database import get_setting
from . import tokenhub

_TZ = timezone(timedelta(hours=8))
USAGE_DAYS = 14

# describe 缓存：api_key_id -> (ts, quota+status 摘要)
_describe_cache: dict[str, tuple[float, dict]] = {}
_DESCRIBE_TTL = 60.0
# 用量扫描缓存：全局
_usage_cache: dict[str, tuple[float, dict]] = {}
_USAGE_TTL = 600.0


async def sync_cfg(db) -> None:
    sid = await get_setting(db, "tokenhub_ak", "")
    sk = await get_setting(db, "tokenhub_sk", "")
    if sid or sk:
        tokenhub.set_runtime_config(sid, sk)


def _mask_key(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    return f"{key[:10]}****" if len(key) > 10 else "****"


def _mask_secret_id(sid: str) -> str:
    sid = (sid or "").strip()
    if not sid:
        return ""
    return f"{sid[:8]}****{sid[-4:]}" if len(sid) > 12 else f"{sid[:4]}****"


async def quota_summary(db, api_key_id: str, use_cache: bool = True) -> dict:
    """远端配额/状态摘要（带缓存）。失败返回 reachable=False。"""
    now = time.time()
    if use_cache and api_key_id in _describe_cache:
        ts, data = _describe_cache[api_key_id]
        if now - ts < _DESCRIBE_TTL:
            return data
    try:
        detail = tokenhub.describe_api_key(api_key_id)
    except tokenhub.TokenHubError as e:
        data = {"reachable": False, "error": str(e), "quota": None}
        _describe_cache[api_key_id] = (now, data)
        return data
    q = tokenhub.quota_of(detail)
    data = {
        "reachable": True,
        "keyStatus": q.get("keyStatus", ""),
        "quotaStatus": q.get("quotaStatus", ""),
        "cycleCredits": int(q.get("cycleCredits") or 0),
        "cycleUsed": int(q.get("cycleUsed") or 0),
        "pkgStart": ((detail.get("QuotaSet") or [{}])[0].get("StartTime") if detail.get("QuotaSet") else "") or "",
        "pkgExpire": ((detail.get("QuotaSet") or [{}])[0].get("ExpireTime") if detail.get("QuotaSet") else "") or "",
        "bindType": detail.get("BindType", ""),
        "boundModels": [b.get("ResourceId") for b in (detail.get("BindingItems") or []) if b.get("ResourceId")],
        "ipWhitelist": detail.get("IpWhitelist") or [],
        "remoteUpdateTime": detail.get("UpdateTime", ""),
        "quota": q,
    }
    _describe_cache[api_key_id] = (now, data)
    return data


async def usage_index(db, force: bool = False) -> dict:
    """近 14 天用量索引：{api_key_id: {last, days, tokens, per_day:{date:tokens}}}。

    按天调 DescribeUsageRankList（Dimension=apikey, Period=86400），全局缓存 10 分钟。
    """
    now = time.time()
    if not force and _usage_cache.get("data") and now - _usage_cache["at"] < _USAGE_TTL:
        return _usage_cache["data"]
    await sync_cfg(db)
    index: dict[str, dict] = {}
    if tokenhub.configured():
        base = datetime.now(_TZ)
        for d in range(USAGE_DAYS - 1, -1, -1):  # 旧 → 新，last 覆盖为最新
            day = (base - timedelta(days=d)).date().isoformat()
            params = {
                "Dimension": "apikey",
                "StartTime": f"{day}T00:00:00+08:00",
                "EndTime": f"{day}T23:59:59+08:00",
                "Period": 86400,
                "Limit": 100,
            }
            try:
                resp = tokenhub.call("DescribeUsageRankList", params)
            except tokenhub.TokenHubError:
                continue
            for item in resp.get("TopList") or []:
                kid = ""
                for f in ("ApiKeyId", "DimKey", "ApiKey", "Key", "Name"):
                    if item.get(f):
                        kid = str(item[f])
                        break
                if not kid:
                    continue
                metrics = item.get("Metrics") or item
                toks = int(metrics.get("TotalToken") or 0)
                e = index.setdefault(kid, {"last": day, "days": 0, "tokens": 0, "per_day": {}})
                e["last"] = day
                e["days"] += 1
                e["tokens"] += toks
                e["per_day"][day] = toks
    _usage_cache["data"] = index
    _usage_cache["at"] = now
    return index


async def collect_rows(db) -> dict:
    """全部用户 + Key 全量信息（远端带缓存）。返回 {rows, summary}。"""
    await sync_cfg(db)
    users = await db.execute_fetchall(
        "SELECT id, email, nickname, status AS user_status, created_at FROM users ORDER BY created_at DESC")
    keys = {r["user_id"]: dict(r) for r in await db.execute_fetchall(
        "SELECT * FROM tokenhub_keys WHERE status != 'deleted'")}
    lp = {r["email"]: r["parent_id"] for r in await db.execute_fetchall("SELECT email, parent_id FROM legacy_parents")}
    usage = await usage_index(db)

    rows = []
    for u in users:
        u = dict(u)
        kid_row = keys.get(u["id"])
        row = {
            "userId": u["id"],
            "email": u.get("email") or "",
            "nickname": u.get("nickname") or "",
            "userLabel": u.get("email") or u.get("nickname") or u["id"][:12],
            "registeredAt": u.get("created_at") or "",
            "parentRef": lp.get(u.get("email") or "", ""),
            "hasKey": bool(kid_row),
        }
        if kid_row:
            row.update({
                "keyId": kid_row["api_key_id"],
                "keyMasked": _mask_key(kid_row.get("api_key")),
                "keyDbStatus": kid_row["status"],
                "keyCreatedAt": kid_row["created_at"],
                "quotaCycleUnit": kid_row.get("quota_cycle_unit") or "d",
                "credits": int(kid_row["quota_cycle_credits"] or 0),
                "rotatedAt": kid_row.get("rotated_at") or "",
                "pendingRestore": int(kid_row.get("pending_restore_credits") or 0),
                "pendingDeleteOld": kid_row.get("pending_delete_key_id") or "",
                "expiresAt": kid_row.get("expires_at") or "",
            })
            qd = await quota_summary(db, kid_row["api_key_id"])
            row["remote"] = qd
            used = int((qd.get("quota") or {}).get("cycleUsed") or 0)
            credits = int((qd.get("quota") or {}).get("cycleCredits") or qd.get("cycleCredits") or kid_row["quota_cycle_credits"] or 0)
            row["usedToday"] = used
            row["credits"] = credits
            row["remain"] = max(0, credits - used)
            row["usageRate"] = round(used / credits * 100) if credits else 0
            uidx = usage.get(kid_row["api_key_id"]) or {}
            row["lastActive"] = uidx.get("last", "")
            row["activeDays14d"] = int(uidx.get("days") or 0)
            row["tokens14d"] = int(uidx.get("tokens") or 0)
            # 有效期
            exp = row.get("expiresAt", "")
            days_left = None
            if exp:
                try:
                    days_left = (datetime.strptime(exp, "%Y-%m-%d").date() - datetime.now(_TZ).date()).days
                except ValueError:
                    days_left = None
            row["expiresAt"] = exp
            row["daysLeft"] = days_left

            # 综合状态（到期优先于其他）
            if days_left is not None and days_left < 0:
                st = "expired"
            elif qd.get("quotaStatus") == "inactive" or (credits and used >= credits):
                st = "exhausted"
            elif row["keyDbStatus"] in ("disabled", "expired") or qd.get("keyStatus") == "disable":
                st = "disabled"
            elif not qd.get("reachable"):
                st = "abnormal"
            else:
                st = "active"
            row["state"] = st
        else:
            row.update({
                "keyId": "", "keyMasked": "", "keyDbStatus": "", "keyCreatedAt": "",
                "credits": 0, "usedToday": 0, "remain": 0, "usageRate": 0,
                "lastActive": "", "activeDays14d": 0, "tokens14d": 0,
                "expiresAt": "", "daysLeft": None,
                "state": "nokey", "remote": None,
            })
        rows.append(row)

    summary = {
        "total": len(rows),
        "withKey": sum(1 for r in rows if r["hasKey"]),
        "todayUsed": sum(r.get("usedToday", 0) for r in rows),
        "abnormal": sum(1 for r in rows if r["state"] in ("abnormal", "exhausted")),
        "tokens14d": sum(r.get("tokens14d", 0) for r in rows),
    }
    return {"rows": rows, "summary": summary}


def apply_query(rows: list[dict], q: dict) -> list[dict]:
    """内存过滤 + 排序（用户量级小，服务端一次给出全量符合条件的行）。"""
    out = rows
    kw = (q.get("q") or "").strip().lower()
    if kw:
        def hit_kw(r):
            hay = " ".join([r.get("email", ""), r.get("nickname", ""), r.get("userId", ""),
                            r.get("keyId", ""), r.get("keyMasked", ""), r.get("parentRef", "")]).lower()
            return kw in hay
        out = [r for r in out if hit_kw(r)]
    st = (q.get("state") or "").strip()
    if st:
        out = [r for r in out if r.get("state") == st or (st == "withkey" and r["hasKey"]) or (st == "nokey" and not r["hasKey"])]

    def in_range(v, lo, hi):
        v = v or 0
        if lo not in (None, "") and v < float(lo):
            return False
        if hi not in (None, "") and v > float(hi):
            return False
        return True

    used_lo, used_hi = q.get("used_min"), q.get("used_max")
    out = [r for r in out if in_range(r.get("usedToday"), used_lo, used_hi)] if (used_lo or used_hi) else out
    rem_lo, rem_hi = q.get("remain_min"), q.get("remain_max")
    out = [r for r in out if in_range(r.get("remain"), rem_lo, rem_hi)] if (rem_lo or rem_hi) else out
    cr_lo, cr_hi = q.get("credits_min"), q.get("credits_max")
    out = [r for r in out if in_range(r.get("credits"), cr_lo, cr_hi)] if (cr_lo or cr_hi) else out

    exp_f = (q.get("expiry") or "").strip()
    if exp_f == "expiring":
        out = [r for r in out if r.get("daysLeft") is not None and 0 <= r["daysLeft"] <= 7]
    elif exp_f == "expired":
        out = [r for r in out if r.get("daysLeft") is not None and r["daysLeft"] < 0]

    last = (q.get("last_active") or "").strip()
    if last == "7d":
        out = [r for r in out if r.get("lastActive") and r["lastActive"] >= _days_ago(7)]
    elif last == "14d":
        out = [r for r in out if r.get("lastActive") and r["lastActive"] >= _days_ago(14)]
    elif last == "stale":
        out = [r for r in out if r["hasKey"] and (not r.get("lastActive") or r["lastActive"] < _days_ago(14))]
    elif last == "never":
        out = [r for r in out if r["hasKey"] and not r.get("lastActive")]

    sort_key = q.get("sort") or "usedToday"
    desc = (q.get("order") or "desc").lower() != "asc"
    keymap = {
        "usedToday": lambda r: r.get("usedToday", 0),
        "remain": lambda r: r.get("remain", 0),
        "credits": lambda r: r.get("credits", 0),
        "tokens14d": lambda r: r.get("tokens14d", 0),
        "lastActive": lambda r: r.get("lastActive", ""),
        "created": lambda r: r.get("registeredAt", "") or r.get("keyCreatedAt", ""),
        "expiresAt": lambda r: (r.get("expiresAt") or "9999-12-31") if r.get("hasKey") else "9999-12-31",
    }
    if sort_key in keymap:
        out = sorted(out, key=keymap[sort_key], reverse=desc)
    return out


def _days_ago(n: int) -> str:
    from datetime import timedelta
    return (datetime.now(_TZ) - timedelta(days=n)).date().isoformat()


async def user_detail(db, user_id: str) -> dict | None:
    """单用户全量信息（详情弹窗）：绕过缓存拉最新远端数据。"""
    users = await db.execute_fetchall("SELECT * FROM users WHERE id=?", (user_id,))
    if not users:
        return None
    u = dict(users[0])
    row_set = await collect_rows_fresh(db)
    row = next((r for r in row_set["rows"] if r["userId"] == user_id), None)
    kid_row = (await db.execute_fetchall("SELECT * FROM tokenhub_keys WHERE user_id=? AND status != 'deleted'", (user_id,)))
    detail = {
        "user": {k: u.get(k) for k in ("id", "email", "nickname", "avatar_url", "status", "created_at")},
        "row": row,
        "keyRow": (dict(kid_row[0]) if kid_row else None),
    }
    if detail["keyRow"]:
        kr = detail["keyRow"]
        try:
            full = tokenhub.describe_api_key(kr["api_key_id"])
            detail["full"] = {
                "BindType": full.get("BindType"),
                "BindingItems": full.get("BindingItems"),
                "IpWhitelist": full.get("IpWhitelist"),
                "Editable": full.get("Editable"),
                "AppId": full.get("AppId"),
                "Uin": full.get("Uin"),
                "SubUin": full.get("SubUin"),
                "CreateTime": full.get("CreateTime"),
                "UpdateTime": full.get("UpdateTime"),
                "QuotaSet": full.get("QuotaSet"),
                "QuotaStatus": full.get("QuotaStatus"),
                "Platform": full.get("Platform"),
            }
        except tokenhub.TokenHubError as e:
            detail["full_error"] = str(e)
    return detail


async def collect_rows_fresh(db) -> dict:
    """绕过缓存的强制刷新版本（详情弹窗用）。"""
    _describe_cache.clear()
    _usage_cache["at"] = 0.0
    return await collect_rows(db)
