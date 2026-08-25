#!/usr/bin/env python3
"""ISSUE-040: 发布 electron-builder 产物到阿里云 OSS + 可选云端登记版本。

用法（在仓库根目录执行）：
  python scripts/publish-update.py                    # 上传 dist/ 的 latest.yml + 安装包 + blockmap
  python scripts/publish-update.py --dry-run          # 只打印将要上传的文件，不实际上传
  python scripts/publish-update.py --bucket my-bucket --endpoint oss-cn-beijing.aliyuncs.com
  python scripts/publish-update.py --register 0.1.1 --release-notes "..." --admin-token xxx

说明：
- AK/SK 从仓库根 aliyun-aksk.txt 读取（accessKeyId/accessKeySecret 那组，OSS 子账号）。
- 若目标 bucket 不存在会自动创建（公共读），仅用于公开分发安装包。
- --register 会在上传成功后调用云端 POST /api/version 登记版本（download_url 指向 OSS 直链）。
"""
import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
AKSK_FILE = ROOT / "aliyun-aksk.txt"

DEFAULT_ENDPOINT = "oss-cn-hangzhou.aliyuncs.com"
DEFAULT_BUCKET = "aixuexihao-app"
PREFIX = "learning-app/"


def load_aksk(path: Path):
    """从 aliyun-aksk.txt 提取 accessKeyId / accessKeySecret（OSS 用，忽略 QIANWEN_*）。"""
    if not path.exists():
        sys.exit(f"[publish-update] 找不到 {path}，请先在仓库根创建（含 accessKeyId/accessKeySecret）")
    ak = sk = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("QIANWEN"):
            continue
        m = re.match(r"^accessKeyId\s+(.+)$", line)
        if m:
            ak = m.group(1).strip()
        m = re.match(r"^accessKeySecret\s+(.+)$", line)
        if m:
            sk = m.group(1).strip()
    if not ak or not sk:
        sys.exit("[publish-update] aliyun-aksk.txt 中未找到 accessKeyId/accessKeySecret")
    return ak, sk


def collect_artifacts(dist_dir: Path):
    """收集待上传产物：latest.yml + 安装包 + blockmap（electron-builder NSIS 输出）。"""
    files = []
    if not dist_dir.exists():
        sys.exit(f"[publish-update] 目录不存在：{dist_dir}（先运行 npm run dist:win）")
    for name in sorted(dist_dir.iterdir()):
        if not name.is_file():
            continue
        if name.name == "latest.yml" or name.name.endswith((".exe", ".exe.blockmap")):
            files.append(name)
    if not files:
        sys.exit(f"[publish-update] {dist_dir} 下没有 latest.yml / *.exe / *.exe.blockmap")
    return files


def main():
    ap = argparse.ArgumentParser(description="上传 electron-builder 产物到阿里云 OSS")
    ap.add_argument("--dry-run", action="store_true", help="只打印待上传文件")
    ap.add_argument("--dist", type=Path, default=DIST, help="electron-builder 输出目录（默认 dist/）")
    ap.add_argument("--bucket", default=DEFAULT_BUCKET)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--register", metavar="VERSION", help="上传后登记版本到云端 POST /api/version")
    ap.add_argument("--release-notes", default="")
    ap.add_argument("--release-date", default="")
    ap.add_argument("--admin-token", default=os.environ.get("ADMIN_TOKEN", ""), help="云端 X-Admin-Token")
    ap.add_argument("--cloud-url", default=os.environ.get("CLOUD_API_URL", "https://www.aixuexihao.top"))
    args = ap.parse_args()

    ak, sk = load_aksk(AKSK_FILE)
    dist_dir = args.dist
    files = collect_artifacts(dist_dir)

    if args.dry_run:
        print("[publish-update] dry-run，将上传：")
        for f in files:
            print(f"  {PREFIX}{f.name}  ({f.stat().st_size / 1024 / 1024:.1f} MB)")
        return

    import oss2
    from oss2 import Bucket, Auth, BUCKET_ACL_PUBLIC_READ
    from oss2.exceptions import NoSuchBucket

    endpoint = f"https://{args.endpoint}"
    auth = Auth(ak, sk)
    bucket = Bucket(auth, endpoint, args.bucket)

    # 桶不存在则创建并设置公共读（安装包需公开下载）
    def _bucket_exists(b: Bucket) -> bool:
        try:
            b.get_bucket_info()
            return True
        except NoSuchBucket:
            return False

    if not _bucket_exists(bucket):
        print(f"[publish-update] 创建 bucket {args.bucket} ...")
        bucket.create_bucket()
    # 无论新建还是已存在，都显式设置公共读（安装包需公开下载）
    try:
        bucket.put_bucket_acl(BUCKET_ACL_PUBLIC_READ)
    except Exception as e:  # noqa: BLE001
        print(f"[publish-update] 设置公共读失败（忽略）: {e}")

    base_url = f"https://{args.bucket}.{args.endpoint}/{PREFIX}"
    for f in files:
        key = PREFIX + f.name
        content_type = "application/octet-stream"
        if f.name == "latest.yml":
            content_type = "text/yaml"
        print(f"[publish-update] 上传 {key} ...")
        bucket.put_object_from_file(key, str(f), headers={"Content-Type": content_type})
        print(f"  -> {base_url}{f.name}")

    print("[publish-update] 上传完成。")

    # 可选：登记版本到云端
    if args.register:
        if not args.admin_token:
            sys.exit("[publish-update] --register 需要 --admin-token（或环境变量 ADMIN_TOKEN）")
        import urllib.request

        version = args.register
        download_url = f"{base_url}{download_name_for_version(dist_dir, version)}"
        payload = (
            '{"version":"%s","release_date":"%s","release_notes":"%s","download_url":"%s","min_version":"0.1.0"}'
            % (
                version,
                args.release_date or _today(),
                (args.release_notes or "").replace('"', '\\"'),
                download_url,
            )
        )
        req = urllib.request.Request(
            f"{args.cloud_url}/api/version",
            data=payload.encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Admin-Token": args.admin_token},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
                print(f"[publish-update] 云端登记 {version}: {resp.status} {body}")
        except urllib.error.HTTPError as e:
            sys.exit(f"[publish-update] 云端登记失败: HTTP {e.code} {e.read().decode('utf-8', 'replace')}")


def download_name_for_version(dist: Path, version: str) -> str:
    """安装包文件名：`学习伙伴 Setup <version>.exe`（与 latest.yml 中 path 一致）。"""
    for name in sorted(dist.iterdir()):
        if name.name.endswith(".exe") and not name.name.endswith(".blockmap"):
            if version in name.name:
                return name.name
    return f"学习伙伴 Setup {version}.exe"


def _today() -> str:
    import datetime

    return datetime.date.today().isoformat()


if __name__ == "__main__":
    main()
