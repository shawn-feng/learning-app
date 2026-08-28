"""平台 Provider 抽象层

每个第三方平台（抖音/微信/小红书…）实现一个 PlatformProvider，
负责本平台的 OAuth 登录、换码、刷新、拉取用户信息与视频等。

路由层只通过 registry.get_provider(platform) 调用，不直接耦合具体平台，
后续接入微信/小红书只需新增一个 Provider 并在 registry 注册即可。
"""
from .base import PlatformProvider, PlatformError
from .douyin import DouyinProvider
from .registry import get_provider, list_platforms, is_supported, SUPPORTED_PLATFORMS

__all__ = [
    "PlatformProvider",
    "PlatformError",
    "DouyinProvider",
    "get_provider",
    "list_platforms",
    "is_supported",
    "SUPPORTED_PLATFORMS",
]
