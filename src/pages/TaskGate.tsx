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
  /** 轮询到权益生效（license 有效）后回调，App 跳转主页 */
  onUnlocked: (email: string) => void;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 5000;

/**
 * 抖音登录后的「任务门禁」页：
 * 没有可用权益时引导家长打开 benefit-auth 个人中心完成任务；
 * 本页每 5 秒检测一次有效期（云端会在每次检测时自动把新完成的任务
 * 折算进有效期），检测到有效即自动进入主页。
 */
export default function TaskGate({ email, meUrl, onUnlocked, onBack }: Props) {
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
    await window.api.openExternal(meUrl);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>完成任务，解锁使用</h1>
        <p className="subtitle">
          当前账号还没有可用权益，完成抖音互动任务后即可解锁学习伙伴
        </p>

        <button onClick={openTaskCenter} style={{ background: "#161823", color: "#fff" }}>
          {opened ? "再次打开任务中心" : "去完成任务"}
        </button>

        <div className="hint" style={{ marginTop: 14 }}>
          {checking ? "🔄 正在自动检测任务完成情况…" : "等待检测中…"}
          <br />
          在任务中心完成任务并获得权益后，本页面会自动进入应用（无需手动刷新）
        </div>

        <div className="switch" onClick={onBack}>
          返回登录页
        </div>
      </div>
    </div>
  );
}
