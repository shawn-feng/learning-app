"""Cloud sync API tests"""
import urllib.request
import urllib.error
import json
import base64
import sys
import os

BASE = "http://127.0.0.1:8006"
PASS = 0
FAIL = 0

def test(name, method, path, body=None, headers=None, expected_status=200, form_fields=None, files=None):
    global PASS, FAIL
    url = f"{BASE}{path}"
    headers = headers or {}

    try:
        if form_fields:
            # multipart/form-data
            from urllib.parse import urlencode
            boundary = "----testboundary"
            body_bytes = b""
            for key, val in form_fields.items():
                body_bytes += f"--{boundary}\r\n".encode()
                body_bytes += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
                body_bytes += val.encode() + b"\r\n"
            if files:
                for field_name, (filename, content) in files.items():
                    body_bytes += f"--{boundary}\r\n".encode()
                    body_bytes += f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n\r\n'.encode()
                    body_bytes += content + b"\r\n"
            body_bytes += f"--{boundary}--\r\n".encode()
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
            data = body_bytes
        else:
            data = json.dumps(body).encode() if body else None
            if data:
                headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            resp_body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            resp_body = json.loads(e.read().decode())
        except:
            resp_body = str(e)

    if status == expected_status:
        print(f"  ✅ {name} (HTTP {status})")
        PASS += 1
        return resp_body
    else:
        print(f"  ❌ {name}: expected {expected_status}, got {status}")
        FAIL += 1
        return None

# Setup: register and get token
print("=== 同步 API 测试 ===\n")
reg = test("注册测试用户", "POST", "/api/auth/register",
          {"email": f"sync-{os.getpid()}@test.com", "password": "pass123"})
if not reg:
    print("Cannot proceed without token")
    sys.exit(1)

token = reg["token"]
auth = {"Authorization": f"Bearer {token}"}
CHILD = "sync-child-001"

# Test 1: Get sync status (empty)
print("\n1. 空同步状态:")
test("获取空状态", "GET", f"/api/sync/status/{CHILD}", headers=auth)

# Test 2: Upload a file
print("\n2. 上传文件:")
test_content = "# 测试日志\n今天学习了论语第一章"
status = test("上传文件", "POST", f"/api/sync/upload/{CHILD}",
              form_fields={"file_path": "daily-logs/2026-08-12.md"},
              files={"file": ("2026-08-12.md", test_content.encode())},
              headers=auth)

# Test 3: Get sync status (with file)
print("\n3. 查询同步状态:")
files_resp = test("查询文件列表", "GET", f"/api/sync/status/{CHILD}", headers=auth)
if files_resp:
    assert len(files_resp["files"]) >= 1, "Should have at least 1 file"
    print(f"   文件数: {len(files_resp['files'])}")

# Test 4: Download file
print("\n4. 下载文件:")
download = test("下载文件", "POST", f"/api/sync/download/{CHILD}",
                form_fields={"file_path": "daily-logs/2026-08-12.md"},
                headers=auth)
if download:
    decoded = base64.b64decode(download["content_base64"]).decode()
    assert decoded == test_content, f"Content mismatch: {decoded}"
    print(f"   文件大小: {download['size']} bytes, 内容一致")

# Test 5: Upload another file and verify list
print("\n5. 多文件同步:")
test("上传 profile.json", "POST", f"/api/sync/upload/{CHILD}",
     form_fields={"file_path": "profile.json"},
     files={"file": ("profile.json", b'{"name":"test"}')},
     headers=auth)

files2 = test("查询2个文件", "GET", f"/api/sync/status/{CHILD}", headers=auth)
if files2:
    assert len(files2["files"]) >= 2, f"Should have at least 2 files, got {len(files2['files'])}"
    print(f"   文件数: {len(files2['files'])}")

# Test 6: Unauthorized access
print("\n6. 无认证访问:")
test("无认证下载(应401)", "POST", f"/api/sync/download/{CHILD}",
     form_fields={"file_path": "test.md"}, expected_status=401)

print(f"\n{'='*30}")
print(f"结果: {PASS} 通过, {FAIL} 失败, 共 {PASS+FAIL} 项")
if FAIL > 0:
    sys.exit(1)
