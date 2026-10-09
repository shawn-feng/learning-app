"""平台 Provider 注册表

路由层只通过 get_provider(platform) 获取实现，新增平台只需在此注册。
"""
from __future__ import annotations

from .base import PlatformProvider
from .douyin import DouyinProvider

_PROVIDERS: dict[str, PlatformProvider] = {
    "douyin": DouyinProvider(),
    # 后续接入：wechat / xhs ...
}

SUPPORTED_PLATFORMS = list(_PROVIDERS.keys())


def get_provider(platform: str) -> PlatformProvider | None:
    return _PROVIDERS.get(platform)


def list_platforms() -> list[str]:
    return SUPPORTED_PLATFORMS


def is_supported(platform: str) -> bool:
    return platform in _PROVIDERS
