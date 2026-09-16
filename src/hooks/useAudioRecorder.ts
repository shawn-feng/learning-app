import { useRef, useState } from "react";

// 可复用的录音 hook：start 开始录音，stop 停止并返回音频 Blob（webm/opus）
// Web（window.api.__web，Phase 5）：start/stop 时并行驱动 shim 的 SpeechRecognition 听写会话
// （voiceDictationStart/Stop），录音 blob 仍由 MediaRecorder 产出——播放/上传/合并链路不变；
// 识别文本由 voiceTranscribe 消费（web/src/shim/voice/stt.ts）。Electron 路径零改动。
export function useAudioRecorder() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // 同步标记，避免 React state 异步导致的「按下就松开」竞态
  const recordingRef = useRef(false);
  // 标记录音被取消（用户松手时 getUserMedia 还没完成）
  const cancelledRef = useRef(false);
  const [recording, setRecording] = useState(false);

  async function start(): Promise<void> {
    if (recordingRef.current) return;
    recordingRef.current = true;
    cancelledRef.current = false;
    setRecording(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        // 用户已松手（录音被取消）：释放流，不创建 recorder，避免「幽灵录音」
        stream.getTracks().forEach((t) => t.stop());
        recordingRef.current = false;
        setRecording(false);
        return;
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        recordingRef.current = false;
        setRecording(false);
      };
      // 每 250ms 产出数据块：即使录音较短也有数据累积，避免 stop 时才一次性输出
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      // Web：并行起浏览器听写（识别文本与录音并行采集）。失败不影响录音（降级为只录不识别）
      if ((window as any).api?.__web) {
        Promise.resolve((window as any).api.voiceDictationStart?.()).catch(() => {});
      }
    } catch (e) {
      recordingRef.current = false;
      setRecording(false);
      throw e;
    }
  }

  // 停止录音。没有活跃录音时返回 null（调用方应静默处理，不视为错误）
  function stop(): Promise<Blob | null> {
    cancelledRef.current = true;
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        // 录音还没真正开始（getUserMedia 未完成）或已停止（重复调用）
        recordingRef.current = false;
        setRecording(false);
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        recorder.stream.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        recordingRef.current = false;
        setRecording(false);
        // Web：先收尾并行听写会话（把最后一批识别结果落账）再返回，
        // 后续 voiceTranscribe 才能取到本次录音的文本；内部 1s 兜底不挂起
        if ((window as any).api?.__web && (window as any).api?.voiceDictationStop) {
          Promise.resolve((window as any).api.voiceDictationStop())
            .catch(() => {})
            .finally(() => resolve(blob));
          return;
        }
        resolve(blob);
      };
      recorder.stop();
    });
  }

  return { recording, start, stop };
}
