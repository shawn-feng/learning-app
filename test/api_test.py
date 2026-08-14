"""Cloud service API tests"""
import urllib.request
import urllib.error
import json
import sys

BASE = "http://127.0.0.1:8005"
PASS = 0
FAIL = 0

def test(name, method, path, body=None, headers=None, expected_status=200):
    global PASS, FAIL
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = headers or {}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            resp_body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            resp_body = json.loads(e.read().decode())
        except:
            resp_body = e.reason

    if status == expected_status:
        print(f"  ✅ {name} (HTTP {status})")
        PASS += 1
        return resp_body
    else:
        print(f"  ❌ {name}: expected {expected_status}, got {status} -> {resp_body}")
        FAIL += 1
        return None

print("=== 云端服务 API 测试 ===\n")

# 1. Register
print("1. 注册/登录/许可证流程:")
reg = test("注册新用户", "POST", "/api/auth/register",
          {"email": "api-test@example.com", "password": "pass123"}, expected_status=200)
if reg:
    token = reg["token"]
    parent_id = reg["parent_id"]
    print(f"   parent_id: {parent_id}")

    # 2. Login
    login = test("登录", "POST", "/api/auth/login",
                 {"email": "api-test@example.com", "password": "pass123"})

    # 3. Get license
    lic = test("获取许可证", "GET", "/api/license",
               headers={"Authorization": f"Bearer {token}"})
    if lic:
        print(f"   计划: {lic.get('plan')}, 最多孩子: {lic.get('max_children')}, 过期: {lic.get('expires_at')[:10]}")

    # 4. Verify license
    test("校验许可证", "POST", "/api/license/verify",
         headers={"Authorization": f"Bearer {token}"})

    # 5. Duplicate registration (should 409)
    test("重复注册(应409)", "POST", "/api/auth/register",
         {"email": "api-test@example.com", "password": "pass123"}, expected_status=409)

    # 6. Wrong password (should 401)
    test("错误密码(应401)", "POST", "/api/auth/login",
         {"email": "api-test@example.com", "password": "wrong"}, expected_status=401)

    # 7. No auth header (should 401)
    test("无认证token(应401)", "GET", "/api/license", expected_status=401)

# Health check
print("\n2. 健康检查:")
test("health endpoint", "GET", "/health")

# Summary
print(f"\n{'='*30}")
print(f"结果: {PASS} 通过, {FAIL} 失败, 共 {PASS+FAIL} 项")
if FAIL > 0:
    sys.exit(1)
