/**
 * 学习考核 · 考试页面 HTML（应用内版本，与 assets/exam-template.html 设计稿同源）。
 * 渲染：宿主 <iframe sandbox="allow-scripts allow-modals allow-forms allow-same-origin" allow="microphone" srcDoc={buildExamHtml(...)}>。
 * 注意：sandbox 必须含 allow-same-origin（否则 srcDoc iframe 是不透明源、非安全上下文，getUserMedia 报 invalid security origin）。
 * 题目注入：开始考核时把本场题目 JSON 填入（服务端/宿主在考核开始时生成题目后调用本函数）。
 * 作答回传：iframe 内经 postMessage 上报 exam:asr（请求语音转写）/ exam:submit（提交全部作答，含录音 Blob）。
 * 锁定规则（2026-09-03 用户拍板）：**一题答完（离开本题）即锁定，不可回改**——防孩子看到后题提示后回头改前题；
 * 锁定题回看只读（可听录音），未作答的空题仍可前后自由移动，全部答完才可提交。
 */

export interface ExamTemplateQuestion {
  id: string;
  course: string;
  pointMax: number;
  stem: string;
}

export function buildExamHtml(
  questions: ExamTemplateQuestion[],
  subject: string,
  title: string
): string {
  const dataJson = JSON.stringify({ title, subject, questions })
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
  .exam-top .elapsed{font-size:22px; color:var(--muted); font-variant-numeric:tabular-nums}
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
  .answer{border-top:1px dashed var(--line); padding-top:18px; margin-top:6px}
  .mic-row{display:flex; align-items:center; gap:14px; flex-wrap:wrap}
  .mic-btn{border:none; border-radius:14px; padding:14px 22px; font-size:24px; font-weight:600; background:var(--brand); color:#fff; cursor:pointer; display:flex; align-items:center; gap:10px;}
  .mic-btn.rec{background:var(--rec); animation:pulse 1.1s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(231,76,60,.5)}70%{box-shadow:0 0 0 14px rgba(231,76,60,0)}100%{box-shadow:0 0 0 0 rgba(231,76,60,0)}}
  .rec-time{font-size:22px; color:var(--rec); font-variant-numeric:tabular-nums; min-width:64px}
  .rerec{font-size:20px; color:var(--brand-d); background:none; border:1px solid var(--line); border-radius:10px; padding:8px 14px; cursor:pointer}
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
  .mic-btn:disabled{background:#aab6cc;cursor:not-allowed;animation:none}
</style>
</head>
<body>
  <div class="exam-top">
    <span class="title" id="examTitle">学习考核</span>
    <span class="subject" id="examSubject">科目</span>
    <span class="spacer"></span>
    <span class="lock">🔒 考核中（不可退出）</span>
    <span class="elapsed" id="elapsed">00:00</span>
  </div>
  <div class="progress" id="progress"></div>
  <div class="stage">
    <div class="q-card" id="qCard">
      <span class="q-course" id="qCourse"></span>
      <div class="q-stem" id="qStem"></div>
      <div class="q-hint">🎤 点击麦克风，用你的话回答这道题（这一段语音只回答本题）</div>
      <div class="answer">
        <div class="mic-row">
          <button class="mic-btn" id="micBtn">🎤 开始回答</button>
          <span class="rec-time" id="recTime"></span>
          <button class="rerec" id="rerecBtn" style="display:none">↺ 重录</button>
        </div>
        <audio class="play" id="play" controls style="display:none"></audio>
        <div class="asr-label">语音转写（可修改 / 也可直接输入文字兜底）：</div>
        <textarea class="asr" id="asr" placeholder="说完后这里会显示转写文字；若语音识别不准，你可以直接修改或输入。"></textarea>
        <div class="lock-tag" id="lockTag"></div>
        <div class="q-timer" id="qTimer">本题用时：—</div>
      </div>
    </div>
  </div>
  <div class="exam-foot">
    <button class="nav" id="prevBtn">← 上一题</button>
    <button class="nav" id="nextBtn">下一题 →</button>
    <span class="foot-spacer"></span>
    <span class="done-tag" id="doneTag"></span>
    <button class="submit" id="submitBtn">提交考核</button>
  </div>
<script>
window.EXAM_DATA = ${dataJson};
(function(){
  var D = window.EXAM_DATA || {questions:[]};
  var idx = 0;
  var examStart = Date.now();
  var answers = {};
  var media = null, chunks = [], recTimer = null, recStart = 0, qTimerInt = null;
  var recQid = null; // 正在录音的题 id（onstop 用它定位，防「停止录音与切题竞态」把录音存错题）
  var RECOG = "识别中…"; // 转写占位（不得当作作答内容保存）
  var $ = function(id){ return document.getElementById(id); };
  $("examTitle").textContent = D.title || "学习考核";
  $("examSubject").textContent = D.subject || "科目";
  setInterval(function(){
    var s = Math.floor((Date.now()-examStart)/1000);
    $("elapsed").textContent = String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
  }, 1000);
  function curQ(){ return D.questions[idx]; }
  function qIndex(qid){ for(var i=0;i<D.questions.length;i++){ if(D.questions[i].id===qid) return i; } return -1; }
  function hasAnswer(a){ return !!(a && ((a.asr && String(a.asr).trim() && a.asr!==RECOG) || a.audioBlob)); }
  function renderProgress(){
    var p = $("progress"); p.innerHTML = "";
    D.questions.forEach(function(q,i){
      var d = document.createElement("div");
      d.className = "dot" + (i===idx?" cur":"") + (answers[q.id]&&answers[q.id].locked?" done":"");
      p.appendChild(d);
    });
  }
  function fmtDur(ms){ if(ms==null) return "—"; var s=Math.round(ms/1000); return Math.floor(s/60)+"分"+(s%60)+"秒"; }
  // 本题实时用时：进入题目即累计（每秒刷新）；作答完成（locked/answeredAt）后冻结。
  function stopQTimer(){ if(qTimerInt){ clearInterval(qTimerInt); qTimerInt = null; } }
  function startQTimer(){
    stopQTimer();
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(!a.startedAt) a.startedAt = Date.now();
    answers[q.id] = a;
    var paint = function(){
      var cur = answers[q.id] || {};
      if(!cur.startedAt) cur.startedAt = Date.now();
      var ms = (cur.answeredAt || Date.now()) - cur.startedAt;
      $("qTimer").textContent = "本题用时：" + fmtDur(ms);
      if(cur.answeredAt){ stopQTimer(); }
    };
    paint();
    qTimerInt = setInterval(paint, 1000);
  }
  // 锁定视图：已答完（locked）的题只读——文本框禁用、麦克风禁用、可播放录音、展示锁定提示
  function paintLocked(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    var locked = !!a.locked;
    var recording = !!(media && media.state === "recording");
    $("asr").disabled = locked;
    $("micBtn").disabled = locked;
    $("micBtn").textContent = locked ? "🔒 已答完" : (recording ? "⏹ 停止" : "🎤 开始回答");
    $("micBtn").className = "mic-btn" + (recording && !locked ? " rec" : "");
    $("rerecBtn").style.display = (a.audioUrl && !locked) ? "inline-block" : "none";
    $("lockTag").style.display = locked ? "block" : "none";
    $("lockTag").textContent = locked ? "🔒 本题已答完，不可修改（可以点开录音回听）" : "";
    $("recTime").textContent = recording ? $("recTime").textContent : "";
  }
  function renderQuestion(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(!a.startedAt) a.startedAt = Date.now();
    answers[q.id] = a;
    stopRec(true);
    $("qCourse").textContent = q.course || "";
    $("qStem").textContent = q.stem || "";
    $("asr").value = a.asr || "";
    if(a.audioUrl){ $("play").src = a.audioUrl; $("play").style.display="block"; }
    else { $("play").src=""; $("play").style.display="none"; }
    paintLocked();
    startQTimer();
    $("prevBtn").disabled = idx===0;
    $("nextBtn").disabled = idx===D.questions.length-1;
    renderProgress(); updateDone();
  }
  // 离开当前题前调用：保存文本框内容；若本题已有作答内容 → 打答完时间并锁定（之后不可改）
  function saveCurrent(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return; // 已锁定的只读题不再动
    var v = $("asr").value;
    a.asr = (v && v !== RECOG) ? v : "";
    if(hasAnswer(a)){
      if(!a.answeredAt) a.answeredAt = Date.now();
      if(a.startedAt) a.durationMs = a.answeredAt - a.startedAt;
      a.locked = true;
    }
    answers[q.id] = a;
    stopQTimer(); startQTimer();
  }
  function updateDone(){
    var done = 0;
    D.questions.forEach(function(q){ if(answers[q.id] && answers[q.id].locked) done++; });
    var all = done === D.questions.length;
    $("submitBtn").disabled = !all;
    $("doneTag").textContent = all ? "全部答完，可提交 ✓" : ("已答 " + done + " / " + D.questions.length + " 题（答完的题不可再改）");
  }
  function stopRec(silent){
    if(media && media.state==="recording"){ media.stop(); }
    if(recTimer){ clearInterval(recTimer); recTimer=null; }
    if(!silent){ paintLocked(); $("recTime").textContent=""; }
  }
  $("micBtn").addEventListener("click", function(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return; // 已答完锁定
    if(media && media.state==="recording"){ media.stop(); return; }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ alert("当前环境不支持录音"); return; }
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      media = new MediaRecorder(stream);
      chunks = [];
      media.ondataavailable = function(e){ if(e.data.size) chunks.push(e.data); };
      media.onstop = function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob = new Blob(chunks, {type: media.mimeType || "audio/webm"});
        var qid = recQid; recQid = null;
        var q = D.questions.find(function(x){ return x.id === qid; });
        if(!q){ return; } // 题目已不在本场（极端），丢弃
        var rec = answers[qid] || {};
        if(rec.audioUrl) URL.revokeObjectURL(rec.audioUrl);
        rec.audioBlob = blob; rec.audioUrl = URL.createObjectURL(blob);
        // 录音完成 = 本题有内容；若已不在该题（录音中切题），立即锁定，避免漏锁导致永远无法提交
        if(qIndex(qid) !== idx){
          if(!rec.answeredAt) rec.answeredAt = Date.now();
          if(rec.startedAt) rec.durationMs = rec.answeredAt - rec.startedAt;
          rec.locked = true;
        }
        answers[qid] = rec;
        if(qIndex(qid) === idx && !rec.locked){
          $("play").src = rec.audioUrl; $("play").style.display="block";
          paintLocked();
          $("asr").value = RECOG;
          if(window.parent && window.parent!==window){ window.parent.postMessage({ type:"exam:asr", qid:qid, blob:blob }, "*"); }
          setTimeout(function(){
            var cur = answers[qid] || {};
            if(!cur.locked && !cur.asrEdited && qIndex(qid) === idx){ $("asr").value = cur.asr || ""; }
          }, 3000);
        }
        updateDone(); renderProgress();
      };
      media.start();
      recStart = Date.now();
      recQid = q.id;
      $("micBtn").textContent="⏹ 停止"; $("micBtn").classList.add("rec");
      $("recTime").textContent = "00:00";
      recTimer = setInterval(function(){
        var s = Math.floor((Date.now()-recStart)/1000);
        $("recTime").textContent = String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
      }, 500);
    }).catch(function(err){ alert("无法录音：" + err.message); });
  });
  $("rerecBtn").addEventListener("click", function(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return;
    if(a.audioUrl){ URL.revokeObjectURL(a.audioUrl); }
    answers[q.id] = { startedAt:a.startedAt, asr:a.asr||"" };
    $("play").src=""; $("play").style.display="none";
    $("asr").value = a.asr || "";
    paintLocked();
    renderProgress(); updateDone();
  });
  $("asr").addEventListener("input", function(){
    var q = curQ(); if(!q) return;
    var a = answers[q.id] || {};
    if(a.locked) return; // 锁定题 textarea 已 disabled，双保险
    a.asrEdited = true;
    a.asr = $("asr").value === RECOG ? "" : $("asr").value;
    answers[q.id] = a;
  });
  $("prevBtn").addEventListener("click", function(){ if(idx>0){ saveCurrent(); idx--; renderQuestion(); } });
  $("nextBtn").addEventListener("click", function(){ if(idx<D.questions.length-1){ saveCurrent(); idx++; renderQuestion(); } });
  $("submitBtn").addEventListener("click", function(){
    saveCurrent();
    var payload = {
      title: D.title, subject: D.subject,
      submittedAt: new Date().toISOString(),
      perQuestion: D.questions.map(function(q){
        var a = answers[q.id] || {};
        return { qid:q.id, course:q.course, stem:q.stem, pointMax:q.pointMax || 10,
                 audioBlob:a.audioBlob||null, asr:(a.asr&&a.asr!==RECOG)?a.asr:"",
                 startedAt:a.startedAt||null, answeredAt:a.answeredAt||null, durationMs:a.durationMs||null };
      })
    };
    if(window.parent && window.parent!==window){ window.parent.postMessage({ type:"exam:submit", payload:payload }, "*"); }
    $("submitBtn").textContent = "已提交 ✓";
    $("submitBtn").disabled = true;
  });
  window.addEventListener("message", function(ev){
    var d = ev.data;
    if(d && d.type === "exam:asr:done"){
      var q = D.questions.find(function(x){ return x.id === d.qid; });
      if(!q) return;
      var a = answers[q.id] || {};
      if(!a.asrEdited){ // 孩子没有手动改过 → 用转写文本；否则保留手工内容
        a.asr = String(d.text || "");
        answers[q.id] = a;
        if(qIndex(q.id) === idx){ $("asr").value = a.asr || ""; }
      }
    }
  });
  renderQuestion();
})();
</script>
</body>
</html>`;
}
