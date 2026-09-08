/**
 * 学习考核 · 考试页面 HTML（应用内版本，与 assets/exam-template.html 设计稿同源）。
 * 渲染：宿主 <iframe sandbox="allow-scripts allow-modals allow-forms allow-same-origin" allow="microphone" srcDoc={buildExamHtml(...)}>。
 * 注意：sandbox 必须含 allow-same-origin（否则 srcDoc iframe 是不透明源、非安全上下文，getUserMedia 报 invalid security origin）。
 * 题目注入：开始考核时把本场题目 JSON 填入（服务端/宿主在考核开始时生成题目后调用本函数）。
 * 作答回传：iframe 内经 postMessage 上报 exam:asr（请求语音转写）/ exam:submit（提交全部作答）。
 *
 * 作答交互 v3（2026-09-03 用户多轮反馈收敛）：
 *  - 按住麦克风说话（push-to-talk，同聊天）：按下开始录音、松开停止并自动转写；可多次按住补充，文本追加拼接。
 *  - 录音停止即进入「识别中…」提示（防以为没录上）；识别文本追加到可编辑文本框；多段音频随提交由宿主合并为单个。
 *  - 顺序作答防偷看：当前题未回答不能进入下一题（后题可能是前题提示）；答完离开本题即锁定，回看只读。
 *  - 每题计时独立（只计本题实际作答时长，不累计别题）；总用时在右上角单独显示。
 */

export interface ExamTemplateQuestion {
  id: string;
  course: string;
  pointMax: number;
  stem: string;
  /** 口语/听说题题型（cn_recitation 等）；有值即背诵/跟读题，显示参考原文、不触发 ASR */
  questionType?: string;
  /** 标准原文（背诵/跟读参照） */
  refText?: string;
}

export function buildExamHtml(
  questions: ExamTemplateQuestion[],
  subject: string,
  title: string,
  /** 流式出题（ISSUE-049）：本场考核总课程数；>0 表示题目会由宿主在后台逐门生成后增量送达 */
  pendingCourses = 0
): string {
  const dataJson = JSON.stringify({ title, subject, questions, pendingCourses })
    .replace(/</g, "\\u003c") // 防题面注入 HTML（stem 来自 LLM 出卷，必须转义）
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>学习考核</title>
<style>
  :root{--bg:#f5f7fa; --card:#ffffff; --ink:#1f2733; --muted:#6b7686; --brand:#3b6ef5; --brand-d:#2c54c4; --rec:#e74c3c; --ok:#27ae60; --line:#e6eaf0; --soft:#eef2f8; --warn:#b9770a;}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg); color:var(--ink); font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; font-size:30px; line-height:1.5; -webkit-text-size-adjust:100%; display:flex; flex-direction:column; height:100vh; overflow:hidden;}
  .exam-top{flex:0 0 auto; background:var(--card); border-bottom:1px solid var(--line); padding:16px 22px; display:flex; align-items:center; gap:16px;}
  .exam-top .title{font-weight:700; font-size:30px}
  .exam-top .subject{font-size:22px; color:#fff; background:var(--brand); border-radius:999px; padding:4px 14px;}
  .exam-top .spacer{flex:1}
  .exam-top .clock{font-size:20px; color:var(--muted); font-variant-numeric:tabular-nums}
  .exam-top .lock{font-size:22px; color:var(--warn)}
  .progress{flex:0 0 auto; display:flex; gap:8px; padding:12px 22px; background:var(--soft)}
  .progress .dot{width:14px; height:14px; border-radius:50%; background:#cfd8e6; transition:.2s;}
  .progress .dot.done{background:var(--ok)}
  .progress .dot.cur{background:var(--brand); transform:scale(1.35)}
  .stage{flex:1 1 auto; overflow:auto; padding:22px}
  .q-card{background:var(--card); border:1px solid var(--line); border-radius:16px; padding:26px; max-width:880px; margin:0 auto; box-shadow:0 2px 10px rgba(20,40,80,.05);}
  .q-course{display:inline-block; font-size:20px; color:var(--brand-d); background:var(--soft); border-radius:8px; padding:4px 12px; margin-bottom:14px;}
  .q-stem{font-size:32px; font-weight:600; margin-bottom:20px}
  .q-hint{font-size:20px; color:var(--muted); margin:-10px 0 18px}
  .q-ref{font-size:30px; line-height:1.6; background:#fff8ec; border:1px solid #f0e2c0; border-radius:12px; padding:14px 16px; margin:-6px 0 18px; color:#8a5a00; white-space:pre-wrap; font-family:"KaiTi","STKaiti",serif;}
  .q-ref:empty{display:none}
  .answer{border-top:1px dashed var(--line); padding-top:18px; margin-top:6px}
  .mic-row{display:flex; align-items:center; gap:14px; flex-wrap:wrap}
  .mic-btn{border:none; border-radius:14px; padding:16px 26px; font-size:24px; font-weight:600; background:var(--brand); color:#fff; cursor:pointer; display:inline-flex; align-items:center; gap:10px; user-select:none; -webkit-user-select:none; touch-action:none;}
  .mic-btn.holding{background:var(--rec); animation:pulse 1.1s infinite}
  .mic-btn.recognizing{background:var(--warn); animation:none}
  .mic-btn:disabled{background:#aab6cc;cursor:not-allowed;animation:none}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(231,76,60,.5)}70%{box-shadow:0 0 0 14px rgba(231,76,60,0)}100%{box-shadow:0 0 0 0 rgba(231,76,60,0)}}
  .rec-time{font-size:22px; color:var(--rec); font-variant-numeric:tabular-nums; min-width:64px}
  .rec-status{font-size:20px; color:var(--warn); min-height:28px; margin:10px 0 0;}
  .play{width:100%; margin-top:12px}
  .asr-label{font-size:20px; color:var(--muted); margin:14px 0 6px}
  .asr{width:100%; min-height:96px; font-size:24px; font-family:inherit; color:var(--ink); border:1px solid var(--line); border-radius:12px; padding:12px 14px; resize:vertical; background:#fffdf7;}
  .asr:focus{outline:2px solid var(--brand)}
  .asr:disabled{background:#eef1f5;color:#555;cursor:not-allowed}
  .q-timer{font-size:18px; color:var(--muted); margin-top:12px; text-align:right}
  .exam-foot{flex:0 0 auto; background:var(--card); border-top:1px solid var(--line); padding:14px 22px; display:flex; align-items:center; gap:14px;}
  .nav{font-size:24px; border:1px solid var(--line); background:#fff; border-radius:12px; padding:12px 22px; cursor:pointer}
  .nav:disabled{opacity:.4; cursor:not-allowed}
  .foot-spacer{flex:1}
  .submit{font-size:26px; font-weight:700; border:none; border-radius:14px; padding:14px 34px; background:var(--ok); color:#fff; cursor:pointer;}
  .submit:disabled{opacity:.45; cursor:not-allowed}
  .done-tag{font-size:20px; color:var(--ok)}
  .lock-tag{font-size:20px;color:var(--warn);margin:8px 0 0;display:none}
  .stream-banner{flex:0 0 auto; background:#fff8ec; border-bottom:1px solid #f0e2c0; padding:10px 22px; font-size:20px; color:var(--warn); display:none;}
  .stream-banner b{font-weight:700}
  .stream-empty{padding:30px 22px; text-align:center; color:var(--muted); font-size:24px; display:none;}
</style>
</head>
<body>
  <div class="exam-top">
    <span class="title" id="examTitle">学习考核</span>
    <span class="subject" id="examSubject">科目</span>
    <span class="spacer"></span>
    <span class="lock">🔒 考核中（不可退出）</span>
    <span class="clock" id="elapsed" title="总用时">总用时 00:00</span>
  </div>
  <div class="progress" id="progress"></div>
  <div class="stream-banner" id="streamBanner"></div>
  <div class="stage">
    <div class="stream-empty" id="streamEmpty"></div>
      <div class="q-card" id="qCard">
        <span class="q-course" id="qCourse"></span>
        <div class="q-stem" id="qStem"></div>
        <div class="q-ref" id="qRef"></div>
        <div class="q-hint" id="qHint">🎤 按住麦克风说话来回答这道题，松开后自动识别；可以说好几次，会拼在一起。想改就直接说新的（如“我刚才说错了…”）。</div>
        <div class="answer">
          <div class="mic-row">
            <button class="mic-btn" id="micBtn">🎤 按住说话</button>
            <span class="rec-time" id="recTime"></span>
          </div>
          <div class="rec-status" id="recStatus"></div>
          <audio class="play" id="play" controls style="display:none"></audio>
          <div class="asr-label" id="asrLabel">识别文字（可修改）：</div>
          <textarea class="asr" id="asr" placeholder="松开后识别出的文字会出现在这里；说错了直接改这里，或再按住说一遍"></textarea>
          <div class="lock-tag" id="lockTag"></div>
          <div class="q-timer" id="qTimer">本题用时：0 秒</div>
        </div>
      </div>
  </div>
  <div class="exam-foot">
    <button class="nav" id="prevBtn">← 上一题</button>
    <button class="nav" id="nextBtn">下一题 →</button>
    <span class="foot-spacer"></span>
    <span class="done-tag" id="doneTag"></span>
    <button class="submit" id="submitBtn">完成并提交</button>
  </div>
<script>
window.EXAM_DATA = ${dataJson};
(function(){
  var D = window.EXAM_DATA || {questions:[]};
  var idx = 0;
  var examStart = Date.now();
  var answers = {};
  var media = null, chunks = [], recStart = 0;
  var transcribing = false, recTimer = null;
  var recQid = null; // 正在录音的题 id（onstop 用它定位，防录音停止与切题竞态存错题）
  var $ = function(id){ return document.getElementById(id); };
  $("examTitle").textContent = D.title || "学习考核";
  $("examSubject").textContent = D.subject || "科目";
  // 全局秒表：右上角总用时 + 当前题「本题用时」（只计本题前台作答时长）
  setInterval(function(){
    var s = Math.floor((Date.now()-examStart)/1000);
    $("elapsed").textContent = "总用时 " + String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
    var q = curQ(); if(!q) return;
    var a = answers[q.id];
    if(a && !a.locked && !a.answeredAt){
      a.sec = (a.sec||0) + 1;
      $("qTimer").textContent = "本题用时：" + a.sec + " 秒";
    }
  }, 1000);
  function curQ(){ return D.questions[idx]; }
  function qIndex(qid){ for(var i=0;i<D.questions.length;i++){ if(D.questions[i].id===qid) return i; } return -1; }
  function hasAnswer(a){ return !!(a && (a.segs.length || (a.asr && String(a.asr).trim()))); }
  function setBtn(label, cls){
    $("micBtn").textContent = label;
    $("micBtn").className = "mic-btn" + (cls ? " " + cls : "");
    // 识别中/正在识别、或当前题已答完锁定 → 不可再录
    $("micBtn").disabled = transcribing || cls === "recognizing" || curLocked();
  }
  function curLocked(){ var q = curQ(); return !!(q && answers[q.id] && answers[q.id].locked); }
  // 当前题是否已有作答内容（说了话/录了音/打了字）——有内容才允许进入下一题（防没答偷看后题）
  function curHasContent(){
    var q = curQ(); if(!q) return false;
    var a = answers[q.id] || {};
    return !!((a.segs && a.segs.length > 0) || String($("asr").value || "").trim() || (a.asr && String(a.asr).trim()));
  }
  // 导航可用性：下一题需「当前题已作答」；上一题始终可回看（已答的只读 / 当前作答中返回继续）
  function updateNav(){
    $("nextBtn").disabled = idx === D.questions.length - 1 || !curHasContent();
    $("prevBtn").disabled = idx === 0;
  }
  function renderProgress(){
    var p = $("progress"); p.innerHTML = "";
    D.questions.forEach(function(q,i){
      var d = document.createElement("div");
      var a = answers[q.id];
      d.className = "dot" + (i===idx?" cur":"") + (a && a.locked ? " done":"");
      p.appendChild(d);
    });
  }
  function fmtSec(sec){ return (sec||0) + " 秒"; }
  // 当前题视图的作答控件状态：locked → 全部只读
  function paintState(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    var locked = !!a.locked;
    $("asr").disabled = locked;
    $("asr").value = a.asr || "";
    $("recStatus").textContent = locked ? "" : (a.segs.length ? "已录 " + a.segs.length + " 段" : "");
    $("play").style.display = (a.audioUrl && locked) ? "block" : "none";
    if(a.audioUrl) $("play").src = a.audioUrl;
    $("qTimer").textContent = locked ? "本题用时：" + fmtSec(a.durationMs != null ? Math.round(a.durationMs/1000) : a.sec) : "本题用时：" + fmtSec(a.sec);
    $("lockTag").style.display = locked ? "block" : "none";
    $("lockTag").textContent = locked ? "🔒 本题已答完，不可修改（可以点开录音回听）" : "";
    setBtn(locked ? "🔒 已答完" : (media && media.state === "recording" ? "松开结束" : "🎤 按住说话"), media && media.state === "recording" ? "holding" : "");
    updateNav();
    renderProgress(); updateDone();
  }
  // ===== 流式出题（ISSUE-049）：首门课就绪即可开始作答，其余课程由宿主后台生成后增量送达 =====
  var totalCourses = Number(D.pendingCourses) || 0; // 本场考核总课程数
  var remainingCourses = totalCourses;              // 还差几门课的题目未送达
  function showStreamEmpty(msg){
    var e = $("streamEmpty"); if(!e) return;
    e.style.display = "block"; e.textContent = msg || "";
    $("qCard").style.display = "none";
    $("progress").style.display = "none";
    $("nextBtn").disabled = true; $("prevBtn").disabled = true;
  }
  function hideStreamEmpty(){
    var e = $("streamEmpty"); if(e) e.style.display = "none";
    $("qCard").style.display = "block";
    $("progress").style.display = "flex";
  }
  function renderBanner(){
    var b = $("streamBanner"); if(!b) return;
    if(totalCourses <= 0 || remainingCourses <= 0){ b.style.display = "none"; return; }
    b.style.display = "block";
    var ready = totalCourses - remainingCourses;
    b.innerHTML = "📥 正在生成其余 <b>" + remainingCourses + "</b> 门课的题目…（已就绪 <b>" + ready + "/" + totalCourses + "</b> 门）。可以先答下面的题，新题会不断加入。";
  }
  /** 宿主每出好一门课即调用：把该课题目按序追加到题流（全局重编号），并刷新导航/进度。 */
  function appendCourseQuestions(qs, remainingAfter){
    if(totalCourses > 0 && remainingAfter != null) remainingCourses = remainingAfter;
    var wasEmpty = D.questions.length === 0;
    for(var i = 0; i < (qs || []).length; i++){
      var q = qs[i];
      D.questions.push({
        id: "q" + (D.questions.length + 1), // 全局唯一序号（LLM 每课都从 q1 起，必须覆盖防串题）
        course: q.course || "",
        stem: q.stem || "",
        pointMax: Number(q.pointMax) || 10,
        questionType: q.questionType || "",
        refText: q.refText || ""
      });
    }
    if(wasEmpty){
      hideStreamEmpty();
      idx = 0;
      renderQuestion(); // paintState 内部会刷新 nav/进度/done
    } else {
      paintState(); // 安全重绘当前题（保留已答内容），同时刷新 nav/dots/done 计数
    }
    renderBanner();
  }
  function renderQuestion(){
    var q = curQ();
    if(!q){
      if(D.questions.length === 0 && totalCourses > 0){ showStreamEmpty("📥 正在生成第 1 门课的题目，请稍候…"); renderBanner(); }
      return;
    }
    if(media && media.state === "recording"){ endRec(); }
    var a = answers[q.id] || { segs: [], sec: 0 };
    if(!a.segs) a.segs = [];
    if(a.sec == null) a.sec = 0;
    answers[q.id] = a;
    $("qCourse").textContent = q.course || "";
    $("qStem").textContent = q.stem || "";
    // 背诵/默写记忆类题型（cn_recitation 背诵、cn_poem 古诗文背诵）：考的是记忆，**不给看原文**
    // （原文只用于提交后 SSECP 判分对照与家长端回显）——显示原文会变成"看文朗读"（ISSUE-050 反馈，2026-09-08）。
    // 跟读/朗读/听说类（cn_sentence/cn_paragraph/en_*）才显示参考原文。
    var isReciteBlind = q.questionType === "cn_recitation" || q.questionType === "cn_poem";
    $("qRef").textContent = isReciteBlind ? "" : (q.refText || "");
    // 口语/听说题：隐藏文字识别框、不触发 ASR
    var isSpeech = !!q.questionType;
    $("qHint").textContent = isSpeech
      ? (isReciteBlind
          ? "🧠 这是一道背诵题：先在脑子里回忆本章原文，再按住麦克风背诵，松手即停；可以分几段背，提交后自动评分。"
          : "🎤 按住麦克风朗读/跟读下面的原文，松手即停；可以分几段读，提交后自动评分。")
      : "🎤 按住麦克风说话来回答这道题，松开后自动识别；可以说好几次，会拼在一起。想改就直接说新的（如“我刚才说错了…”）。";
    $("asrLabel").style.display = isSpeech ? "none" : "";
    $("asr").style.display = isSpeech ? "none" : "";
    paintState();
  }
  // 离开当前题：保存文本框；已有内容（录音/文字）→ 打答完时间并锁定（之后只读不可改）
  function saveCurrent(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return;
    a.asr = $("asr").value || "";
    if(hasAnswer(a)){
      if(!a.answeredAt) a.answeredAt = Date.now();
      a.durationMs = (a.sec || 0) * 1000;
      a.locked = true;
    }
    answers[q.id] = a;
  }
  function updateDone(){
    var done = 0;
    D.questions.forEach(function(q){ if(answers[q.id] && answers[q.id].locked) done++; });
    var pending = totalCourses > 0 ? remainingCourses : 0;
    var all = pending === 0 && done === D.questions.length;
    $("submitBtn").disabled = !all;
    if(all){
      $("doneTag").textContent = "全部答完，可提交 ✓";
    } else if(pending > 0 && done === D.questions.length && D.questions.length > 0){
      $("doneTag").textContent = "已答完当前 " + done + " 题，还有 " + pending + " 门课的题目正在生成…";
    } else {
      $("doneTag").textContent = "已答 " + done + " / " + D.questions.length + " 题";
    }
  }
  function stopMic(){
    if(media && media.state === "recording"){ media.stop(); }
    if(recTimer){ clearInterval(recTimer); recTimer = null; }
    $("recTime").textContent = "";
  }
  function endRec(){
    if(media && media.state === "recording"){ media.stop(); }
  }
  function onStopRecording(){
    if(media && media.state === "recording"){ media.stop(); }
  }
  function startRec(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked || transcribing) return;
    if(media && media.state === "recording") return;
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ alert("当前环境不支持录音"); return; }
    $("recStatus").textContent = "正在录音…松开结束";
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      var rec = new MediaRecorder(stream);
      media = rec;
      chunks = [];
      rec.ondataavailable = function(e){ if(e.data.size) chunks.push(e.data); };
      rec.onstop = function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob = new Blob(chunks, {type: rec.mimeType || "audio/webm"});
        var qid = recQid; recQid = null;
        var q = D.questions.find(function(x){ return x.id === qid; });
        if(!q){ return; }
        if(blob.size < 2000){
          // 空/极短 webm（Chromium 常见）：提示重说，不入答案
          $("recStatus").textContent = "录音太短，请按住说完整的一句话再松开";
          media = null;
          paintState();
          return;
        }
        // 录音转 base64 供宿主合并（同聊天：一次输入多段拼接为单个音频）
        var fr = new FileReader();
        fr.onload = function(){
          var recA = answers[qid] || { segs: [], sec: 0 };
          if(!recA.segs) recA.segs = [];
          recA.segs.push(String(fr.result)); // data:...;base64,...
          if(recA.audioUrl) URL.revokeObjectURL(recA.audioUrl);
          recA.audioUrl = URL.createObjectURL(blob);
          answers[qid] = recA;
          if(qIndex(qid) === idx) updateNav(); // 录上音即可进入下一题
          if(qIndex(qid) === idx && !recA.locked){
            if(q.questionType){
              // 背诵/跟读题：无需 ASR，录完即存（提交时统一评测）；不打识别中状态（避免麦克风被锁）
              if(!recA.answeredAt) recA.answeredAt = Date.now();
              if(recA.sec) recA.durationMs = recA.sec * 1000;
              recA.locked = true;
              paintState();
            } else {
              // 识别中提示（防孩子以为没录上）
              transcribing = true;
              setBtn("🔄 识别中…", "recognizing");
              $("recStatus").textContent = "正在识别你的回答…请稍等";
              if(window.parent && window.parent!==window){ window.parent.postMessage({ type:"exam:asr", qid:qid, blob:blob }, "*"); }
            }
          } else {            // 录音后立刻切走的题：已有内容 → 立即锁定（防漏锁导致无法提交）
            if(recA.segs.length || (recA.asr && String(recA.asr).trim())){
              if(!recA.answeredAt) recA.answeredAt = Date.now();
              if(recA.sec) recA.durationMs = recA.sec * 1000;
              recA.locked = true;
            }
            paintState();
          }
        };
        fr.readAsDataURL(blob);
        media = null;
      };
      rec.start();
      recStart = Date.now();
      recQid = q.id;
      setBtn("松开结束", "holding");
      $("recTime").textContent = "00:00";
      recTimer = setInterval(function(){
        var s = Math.floor((Date.now()-recStart)/1000);
        $("recTime").textContent = String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
      }, 500);
    }).catch(function(err){ media = null; $("recStatus").textContent = "无法录音：" + (err && err.message ? err.message : err); });
  }
  // 按住说话（push-to-talk）：桌面 pointer + 移动端 touch
  var micBtn = $("micBtn");
  function downEv(e){
    if(e && e.cancelable) e.preventDefault();
    startRec();
  }
  function upEv(){ endRec(); }
  micBtn.addEventListener("mousedown", downEv);
  micBtn.addEventListener("mouseup", upEv);
  micBtn.addEventListener("mouseleave", upEv); // 按住拖出按钮也停止
  micBtn.addEventListener("touchstart", downEv, {passive:false});
  micBtn.addEventListener("touchend", upEv);
  micBtn.addEventListener("touchcancel", upEv);
  micBtn.addEventListener("contextmenu", function(e){ e.preventDefault(); });
  $("asr").addEventListener("input", function(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return;
    a.asrEdited = true;
    a.asr = $("asr").value;
    answers[q.id] = a;
    updateNav(); // 输入了内容即可进入下一题
  });
  $("prevBtn").addEventListener("click", function(){ if(idx>0){ saveCurrent(); idx--; renderQuestion(); } });
  $("nextBtn").addEventListener("click", function(){
    var q = curQ();
    // 只要当前题已有作答内容（录过音/有文字）即可切下一题；saveCurrent() 会锁定本题，
    // ASR 识别文本晚到也安全（asr:done 对已锁定题仍并入）。仅「完全没答」才禁止（防偷看后题）。
    if(q && !curHasContent()) return;
    if(idx < D.questions.length - 1){ saveCurrent(); idx++; renderQuestion(); }
  });
  $("submitBtn").addEventListener("click", function(){
    saveCurrent();
    // 顺带校验：不应存在未答题（顺序作答已保证），万一有则提示并跳转
    var first = -1;
    for(var i=0;i<D.questions.length;i++){ var aa = answers[D.questions[i].id]; if(!aa || !aa.locked){ first = i; break; } }
    if(first >= 0){
      alert("还有第 " + (first+1) + " 题没有回答（答完才能提交）");
      idx = first; renderQuestion();
      return;
    }
    var payload = {
      title: D.title, subject: D.subject,
      submittedAt: new Date().toISOString(),
      perQuestion: D.questions.map(function(q){
        var a = answers[q.id] || {};
        return { qid:q.id, course:q.course, stem:q.stem, pointMax:q.pointMax || 10,
                 audioB64s: (a.segs || []).slice(), asr:(a.asr||"").trim(),
                 startedAt:null, durationMs: a.durationMs != null ? a.durationMs : ((a.sec||0)*1000),
                 questionType: q.questionType || "", refText: q.refText || "" };
      })
    };
    if(window.parent && window.parent!==window){ window.parent.postMessage({ type:"exam:submit", payload:payload }, "*"); }
    $("submitBtn").textContent = "已提交 ✓";
    $("submitBtn").disabled = true;
  });
  window.addEventListener("message", function(ev){
    var d = ev.data;
    if(!d || typeof d !== "object") return;
    if(d.type === "exam:addQuestions"){
      // 流式出题：宿主每出好一门课就把题目送达，追加到题流（顺序保证由宿主控制）
      appendCourseQuestions(d.questions || [], d.remaining);
      return;
    }
    if(d.type === "exam:asr:done"){
      var q = D.questions.find(function(x){ return x.id === d.qid; });
      if(!q) return;
      transcribing = false;
      var txt = String(d.text || "").trim();
      var a = answers[q.id] || { segs: [], sec: 0 };
      if(!a.segs) a.segs = [];
      var showIdx = qIndex(q.id);
      // 识别文本一律追加到该题（同聊天语义：多次按住说话拼接成完整回答）——
      // 即便孩子已切走/该题已锁定也要并入（判分文本不能丢）
      if(txt){
        a.asr = (a.asr && String(a.asr).trim()) ? (String(a.asr).trim() + "。" + txt) : txt;
        answers[q.id] = a;
      }
      if(showIdx === idx){
        setBtn(curLocked() ? "🔒 已答完" : "🎤 按住说话", "");
        if(txt){
          $("asr").value = a.asr;
          $("recStatus").textContent = "已记录（可继续按住补充，或直接修改文字）";
        } else {
          $("recStatus").textContent = "没听清，请再按住说一遍，或直接在下面输入";
        }
        updateNav();
      }
    }
  });
  // 流式出题（ISSUE-049）：初始只有空壳（题目等宿主逐门送达）；普通出题（questions 直接给全）原样工作
  if(totalCourses > 0){
    remainingCourses = totalCourses;
    renderBanner();
    showStreamEmpty("📥 正在生成第 1 门课的题目，请稍候…（本场共 " + totalCourses + " 门课）");
  } else {
    renderQuestion();
  }
})();
</script>
</body>
</html>`;
}
