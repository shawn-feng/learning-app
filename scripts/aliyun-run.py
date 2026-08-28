"""阿里云 ECS 云助手执行命令（发布/运维用）。
用法: python scripts/aliyun-run.py "<shell 命令>" [--name NAME] [--timeout 60]
读取 scripts/_ali-creds.json 的 AK/SK，在 ECS 上执行命令并输出结果。
"""
import argparse, base64, json, os, sys, time
from aliyunsdkcore.client import AcsClient
from aliyunsdkecs.request.v20140526.RunCommandRequest import RunCommandRequest
from aliyunsdkecs.request.v20140526.DescribeInvocationResultsRequest import DescribeInvocationResultsRequest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IID = 'i-bp15zfctbt147ktl39pk'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", help="shell 命令")
    ap.add_argument("--name", default="ops")
    ap.add_argument("--timeout", type=int, default=120, help="等待秒数")
    args = ap.parse_args()
    import re as _re
    _d = {}
    for _ln in open(os.path.join(ROOT, "aliyun-aksk.txt"), encoding="utf-8").read().splitlines():
        _m = _re.match(r"^accessKey(Id|Secret)\s+(.+)$", _ln.strip())
        if _m:
            _d[_m.group(1)] = _m.group(2).strip()
    client = AcsClient(_d["Id"], _d["Secret"], "cn-hangzhou")

    req = RunCommandRequest()
    req.set_CommandContent(args.cmd)
    req.set_InstanceIds([IID])
    req.set_Type("RunShellScript")
    req.set_Name(args.name)
    req.set_Timeout(120)
    inv = json.loads(client.do_action_with_exception(req)).get("InvokeId")
    print("INVOKE:", inv)

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(6)
        r2 = DescribeInvocationResultsRequest()
        r2.set_InvokeId(inv)
        res = json.loads(client.do_action_with_exception(r2))
        results = res.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
        if not results:
            continue
        st = results[0].get("InvocationStatus")
        if st in ("Success", "Failed", "Timeout", "PartialFailed"):
            print("STATUS:", st)
            out = results[0].get("Output", "")
            if out:
                try:
                    print("OUTPUT:", base64.b64decode(out).decode("utf-8", "replace"))
                except Exception:
                    print("OUTPUT(raw):", out)
            sys.exit(0 if st == "Success" else 1)
    print("TIMEOUT waiting result")
    sys.exit(1)

if __name__ == "__main__":
    main()
