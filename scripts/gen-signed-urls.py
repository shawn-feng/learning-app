"""生成 OSS 签名 URL（发布中转：服务器云助手 curl 这些 URL 覆盖 /download/）。
用法: python scripts/gen-signed-urls.py <dist目录> [过期秒数]
输出 dist目录/signed-urls.json：{文件名: 签名URL}
"""
import json, os, sys, glob
import oss2

def main():
    dist_dir = sys.argv[1] if len(sys.argv) > 1 else "dist-release"
    expire = int(sys.argv[2]) if len(sys.argv) > 2 else 3600
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    import re as _re
    _lines = open(os.path.join(root, "aliyun-aksk.txt"), encoding="utf-8").read().splitlines()
    _d = {}
    for _ln in _lines:
        _m = _re.match(r"^accessKey(Id|Secret)\s+(.+)$", _ln.strip())
        if _m:
            _d[_m.group(1)] = _m.group(2).strip()
    auth = oss2.Auth(_d["Id"], _d["Secret"])
    bucket = oss2.Bucket(auth, "https://oss-cn-hangzhou.aliyuncs.com", "aixuexihao-app")
    prefix = "learning-app/"

    names = ["latest.yml"] + [os.path.basename(p) for p in sorted(glob.glob(os.path.join(dist_dir, "*.exe")) + glob.glob(os.path.join(dist_dir, "*.exe.blockmap")))]
    urls = {}
    for n in names:
        key = prefix + n
        url = bucket.sign_url("GET", key, expire)
        urls[n] = url
        print(n, "->", url[:80] + "...")
    out = os.path.join(dist_dir, "signed-urls.json")
    json.dump(urls, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("written:", out)

if __name__ == "__main__":
    main()
