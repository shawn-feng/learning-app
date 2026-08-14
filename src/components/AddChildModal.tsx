import { useState } from "react";

interface Props {
  avatars: string[];
  onClose: () => void;
  onAdded: () => void;
}

const AI_EMOJIS = ["🤖", "🦊", "🐱", "🐶", "🦉", "🐲", "🦄", "🌟", "🎓", "📚"];

export default function AddChildModal({ avatars, onClose, onAdded }: Props) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(avatars[0]);
  const [password, setPassword] = useState("");
  const [age, setAge] = useState("");
  const [grade, setGrade] = useState("");
  const [interests, setInterests] = useState("");
  const [aiName, setAiName] = useState("");
  const [aiEmoji, setAiEmoji] = useState(AI_EMOJIS[0]);
  const [aiPersonality, setAiPersonality] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleAdd() {
    setError("");
    if (!name || !password || !age || !aiName) {
      setError("请填写姓名、密码、年龄和AI伙伴名字");
      return;
    }

    setLoading(true);
    try {
      const result = await window.api.childAdd({
        name,
        avatar,
        password,
        age: parseInt(age) || 0,
        grade,
        interests,
        aiName,
        aiEmoji,
        aiPersonality,
      });
      if (result.success) {
        onAdded();
      } else {
        setError(result.error || "添加失败");
      }
    } catch (e: any) {
      setError(e.message || "添加失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>添加孩子</h2>
        {error && <div style={{ color: "red", marginBottom: 12 }}>{error}</div>}

        <label>孩子姓名</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：小明"
        />

        <label>选择头像</label>
        <div className="avatar-picker">
          {avatars.map((a) => (
            <div
              key={a}
              className={`avatar-option ${avatar === a ? "selected" : ""}`}
              onClick={() => setAvatar(a)}
            >
              {a}
            </div>
          ))}
        </div>

        <div className="row">
          <div>
            <label>年龄</label>
            <input
              type="number"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="如：8"
            />
          </div>
          <div>
            <label>年级</label>
            <input
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="如：二年级"
            />
          </div>
        </div>

        <label>兴趣爱好</label>
        <input
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="如：恐龙、画画"
        />

        <label>登录密码（仅存本地）</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <label>AI伙伴名字</label>
        <input
          value={aiName}
          onChange={(e) => setAiName(e.target.value)}
          placeholder="如：知识狐"
        />

        <label>AI伙伴 Emoji</label>
        <div className="avatar-picker">
          {AI_EMOJIS.map((e) => (
            <div
              key={e}
              className={`avatar-option ${aiEmoji === e ? "selected" : ""}`}
              onClick={() => setAiEmoji(e)}
            >
              {e}
            </div>
          ))}
        </div>

        <label>AI伙伴性格</label>
        <textarea
          value={aiPersonality}
          onChange={(e) => setAiPersonality(e.target.value)}
          placeholder="如：温和耐心，喜欢用故事引导"
          style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 12, minHeight: 60 }}
        />

        <div className="modal-actions">
          <button className="cancel" onClick={onClose}>
            取消
          </button>
          <button className="confirm" onClick={handleAdd} disabled={loading}>
            {loading ? "添加中..." : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
