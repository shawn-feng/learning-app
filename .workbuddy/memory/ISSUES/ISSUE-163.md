# ISSUE-163：所有密钥输入处回显已存密钥的打码前缀（知道现在用的是哪把 key）

- **类型**：可用性 / 密钥回显
- **记录时间**：2026-09-27
- **状态**：✅ 已实施（见实施记录）

## 需求（用户原话）

「在模型配置界面，以及所有要填写密钥 key 的位置，都把密钥的前几位显示出来，这样好知道现在用的是什么密钥。」

## 现状盘点（实施前）

| 密钥入口 | 存储 | 回显现状 |
|---|---|---|
| 模型配置（Settings models tab，8 provider） | 服务端 settings 表 `auth` 封套（加密落盘） | **无**——input 恒空，只有 `sk-...` placeholder，无法知道是否已配/配的哪把 |
| 飞书绑定 App Secret | 服务端 settings 表 | 仅 `hasSecret` 布尔，placeholder 固定「App Secret 已保存，留空保持不变」 |
| 语音输入/合成 apiKey | 客户端本地 voice/tts-config.json | 已有 maskSecret（前3+****+后4）回填 input，patch 含 `*` 视为未改 |
| 发音评测 SecretId/SecretKey | 服务端 AES 加密 settings | 已有 maskSecret（前2+***+后2）回填 input |

视觉配置无独立 key（复用模型 provider key），不涉及；登录密码不回显（原则）。

## 方案

统一打码格式升级为 **前 6 + `****` + 后 4**（如 `sk-ab12****x9zw`）：只露前几位对 `sk-`/`tp-` 类统一前缀的 key 无区分度，补后 4 位才能分辨「是哪把 key」。长度 ≤8 的短密钥全打码。

1. **打码函数统一**：`server/src/assessment/config.ts`、`electron/lib/voice/tts-config.ts`、`electron/lib/voice/voice-config.ts` 三处 maskSecret 对齐 6/4 语义（patch「含 * 即未修改」的判定不受影响）。
2. **服务端** `/models/settings`：providers 数组增加 `keyMasked`（从 `auth[provider].key` 打码，绝不回明文）；`/wechat/feishu-config` GET 增加 `secretMasked`。
3. **Electron**：新 IPC `pi:get_settings`（透传 /models/settings 的 providers+appSettings）；preload 暴露 `piGetSettings`。
4. **UI**：
   - 模型配置：挂载/切 provider/保存后显示「已保存 Key：`sk-ab12****x9zw`」或「未配置」；provider chip 加 ✓ 标记已配。
   - 飞书绑定：placeholder 改「已保存（`ab12****w9xz`），留空保持不变」。
   - 语音/评测：无需 UI 改动（maskSecret 加长自动生效）。
5. **web shim**：models 域加 `piGetSettings`（http /models/settings）；auth/wechat 域的 feishu get 透传新字段。

## 隐私

打码只露首尾共 10 字符且中间必含 `****`，接口仍绝不返回明文 key（与既有原则一致）。

## 实施（2026-09-27）

- 打码统一：三处 maskSecret → 6/4；新增 `server/src/util/mask.ts`（服务端 models/feishu 共用）。
- `server/src/routes/models.ts`：/models/settings providers +keyMasked；`server/src/routes/wechat.ts`：feishu-config GET +secretMasked。
- `electron/lib/ipc-handlers.ts` +`pi:get_settings`；`electron/preload.ts` +`piGetSettings`。
- `src/pages/Settings.tsx`：keyMasked 状态 + input 下方回显行 + chip ✓；`src/components/FeishuBindPanel.tsx` placeholder 带前缀。
- web shim：`domains/models.ts` +piGetSettings；`domains/wechat.ts`（feishu get 透传 secretMasked，如该域有对应方法）。
- 回归：`test/issue163-key-mask.test.ts`（/models/settings keyMasked 形状+不含明文；feishu secretMasked；mask 边界：短 key 全 *、长 key 6+****+4）。
