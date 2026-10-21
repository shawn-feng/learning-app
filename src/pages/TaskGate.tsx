import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    api: any;
  }
}

interface Props {
  email: string;
  /** benefit-auth 个人中心地址（完成任务/查看权益） */
  meUrl: string;
  /** ISSUE-188：true = 已登录但 VIP 到期（不是新账号待解锁）——文案不同，且强调无需重新扫码 */
  expired?: boolean;
  /** 轮询到权益生效（license 有效）后回调，App 跳转主页 */
  onUnlocked: (email: string) => void;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 5000;

/**
 * 「任务门禁」页（两种进入方式）：
 * 1. 抖音新家长（无权益）登录后；
 * 2. **ISSUE-188：已登录家长的 VIP 到期**——此时不要求重新登录/扫码，只需完成当日任务，
 *    本页每 5 秒检测一次（服务端每次都会向 benefit-auth 重新取 license），有效即自动进主页。
 */
export default function TaskGate({ email, meUrl, expired = false, onUnlocked, onBack }: Props) {
  const [checking, setChecking] = useState(false);
  const [opened, setOpened] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      setChecking(true);
      try {
        const result = await window.api.authCheck();
        if (!cancelled && result.authenticated) {
          stop();
          onUnlocked(result.license?.email || email);
          return;
        }
      } catch {
        /* 网络抖动下一轮继续 */
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    function start() {
      if (timer.current) return;
      void poll();
      timer.current = window.setInterval(poll, POLL_INTERVAL_MS);
    }
    function stop() {
      if (timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    }

    start();
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openTaskCenter() {
    setOpened(true);
    if (!meUrl) return; // 服务端未返回地址（旧服务端）——按钮仍显示，但点了不跳转
    await window.api.openExternal(meUrl);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{expired ? "学习权益已到期" : "完成任务，解锁使用"}</h1>
        <p className="subtitle">
          {expired
            ? "完成今天的抖音互动任务即可恢复使用——账号仍处于登录状态，不需要重新扫码登录"
            : "当前账号还没有可用权益，完成抖音互动任务后即可解锁学习伙伴"}
        </p>

        <button className="douyin-btn" onClick={openTaskCenter} style={{ background: "#161823", color: "#fff" }}>
          {opened ? "再次打开任务中心" : "去完成任务"}
        </button>

        <div className="hint" style={{ marginTop: 14 }}>
          {checking ? "🔄 正在自动检测任务完成情况…" : "等待检测中…"}
          <br />
          {expired
            ? "在任务中心完成任务后，本页面会自动进入应用（无需重新登录/扫码）"
            : "在任务中心完成任务并获得权益后，本页面会自动进入应用（无需手动刷新）"}
        </div>

        <div className="switch" onClick={onBack}>
          {expired ? "退出当前账号（需要重新扫码）" : "返回登录页"}
        </div>
      </div>
    </div>
  );
}
