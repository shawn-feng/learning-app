"""平台 Provider 基类

子类只需实现与具体平台开放平台对接的少数方法；
通用的状态管理、错误封装在基类。
"""
from __future__ import annotations

import abc
import os
from urllib.parse import quote

import httpx


class PlatformError(Exception):
    """平台开放平台返回错误时抛出"""


class PlatformProvider(abc.ABC):
    """一个第三方平台（如抖音）的对接实现"""

    #: 平台标识（douyin / wechat / xhs ...）
    platform: str = ""
    #: 展示名
    display_name: str = ""
    #: 用户首次登录默认申请的 scope
    default_scopes: list[str] = []
    #: 用于“获取用户视频信息”等高级能力时额外申请的 scope
    advanced_scopes: list[str] = []
    #: 授权页面 base URL
    authorize_base: str = ""
    #: 开放平台 API base URL
    api_base: str = ""

    def __init__(self):
        self.client_key = os.environ.get(self._env("CLIENT_KEY", "CLIENT_KEY"), "")
        self.client_secret = os.environ.get(self._env("CLIENT_SECRET", "CLIENT_SECRET"), "")
        # 统一 base（如 DOUYIN_API_BASE），缺省用各平台默认
        self.api_base = os.environ.get(self._env("API_BASE", "API_BASE"), self.api_base)

    # ---------------- 配置辅助 ----------------
    def _env(self, suffix: str, _default: str) -> str:
        """子类可通过覆盖提供前缀，默认用平台名大写 + _ + suffix"""
        prefix = self.platform.upper().replace("-", "_")
        return f"{prefix}_{suffix}"

    def is_configured(self) -> bool:
        return bool(self.client_key and self.client_secret)

    def all_scopes(self) -> list[str]:
        """登录 + 高级能力合并后的完整 scope 列表"""
        merged = list(self.default_scopes)
        for s in self.advanced_scopes:
            if s not in merged:
                merged.append(s)
        return merged

    # ---------------- OAuth 授权页 ----------------
    def authorize_url(self, redirect_uri: str, state: str, scopes: list[str] | None = None) -> str:
        scopes = scopes or self.default_scopes
        # 抖音文档：redirect_uri 仅对 # 等特殊符号做 urlEncode；普通 https 地址须保持原样。
        # 自 2023-06-12 起开放平台对「域名+path」做精确字符串比对（不标准化），
        # 若把 : / 也编码成 %3A %2F，会与控制台「授权回调地址」逐字节不符 → 报
        # “当前链接不合法 / 授权不合法”。safe=':/' 保留 : 与 /，仅编码 ? & # 等真正需编码的字符。
        return (
            f"{self.authorize_base}"
            f"?client_key={self.client_key}"
            f"&response_type=code"
            f"&scope={','.join(scopes)}"
            f"&redirect_uri={quote(redirect_uri, safe=':/')}"
            f"&state={state}"
        )

    # ---------------- 开放平台调用 ----------------
    async def exchange_code(self, code: str, redirect_uri: str) -> dict:
        """用授权码换取 access_token / open_id 等"""
        return await self._post(
            "/oauth/access_token/",
            data={
                "client_key": self.client_key,
                "client_secret": self.client_secret,
                "code": code,
                "grant_type": "authorization_code",
            },
        )

    async def refresh(self, refresh_token: str) -> dict:
        """用 refresh_token 续期 access_token"""
        return await self._post(
            "/oauth/refresh_token/",
            data={
                "client_key": self.client_key,
                "client_secret": self.client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )

    @abc.abstractmethod
    async def user_info(self, access_token: str, open_id: str) -> dict:
        """拉取平台用户公开信息（昵称/头像等）"""

    @abc.abstractmethod
    async def video_list(self, access_token: str, open_id: str, cursor: int = 0) -> dict:
        """拉取用户视频列表（需 video.list 类 scope）"""

    # ---------------- HTTP 封装 ----------------
    @staticmethod
    def _parse_json(resp) -> dict:
        """解析平台响应；非 JSON（如旧接口路径返回的 HTML 兜底页）抛清晰错误而非 JSONDecodeError 500"""
        try:
            return resp.json()
        except Exception:
            raise PlatformError(
                f"{resp.request.url.path} returned non-JSON "
                f"(HTTP {resp.status_code}, content-type={resp.headers.get('content-type', '')}): {resp.text[:200]!r}"
            )

    async def _post(self, path: str, data: dict) -> dict:
        async with httpx.AsyncClient(base_url=self.api_base, timeout=15) as client:
            resp = await client.post(path, data=data)
            resp.raise_for_status()
            body = self._parse_json(resp)
            # error_code 兼容 int 0 / 字符串 "0"（抖音部分接口成功时返回字符串 "0"）
            if str(body.get("data", {}).get("error_code", 0)) != "0":
                raise PlatformError(f"{self.platform} API error: {body.get('data', {})}")
            return body.get("data", {})

    async def _get(self, path: str, params: dict) -> dict:
        async with httpx.AsyncClient(base_url=self.api_base, timeout=15) as client:
            resp = await client.get(path, params=params)
            resp.raise_for_status()
            body = self._parse_json(resp)
            if str(body.get("data", {}).get("error_code", 0)) != "0":
                raise PlatformError(f"{self.platform} API error: {body.get('data', {})}")
            return body.get("data", {})
