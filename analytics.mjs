const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const labels = {
  status: { completed: "已完成", processing: "处理中", failed: "失败" },
  usefulness: { very: "非常有帮助", some: "有一些帮助", none: "帮助不大" },
  valuable: { probability: "概率判断", cases: "案例参照", programme: "项目资料", gaps: "信息缺口" },
  clarity: { clear: "清晰", average: "一般", unclear: "不清晰" }
};

let records = [];

async function json(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.replace(`/admin.html?next=${encodeURIComponent(location.pathname)}`);
    throw new Error("管理员登录已过期");
  }
  if (!response.ok) throw new Error(payload.message || "读取数据失败");
  return payload;
}

function profileOf(record) {
  return record?.applicant?.profile || {};
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function filled(item) {
  return item && Object.values(item).some(value => value !== null && value !== undefined && String(value).trim() !== "");
}

function experienceCount(profile, key) {
  return listOf(profile[key]).filter(filled).length;
}

function hasExperience(profile, key) {
  return experienceCount(profile, key) > 0;
}

function tierOf(profile) {
  const classification = String(profile.schoolClassification || "");
  if (classification.includes("985")) return "985";
  if (classification.includes("211")) return "211";
  if (classification.includes("双非")) return "双非";
  if (classification.includes("海外")) return "海外本科";
  if (profile.schoolTier != null) return `层级 ${profile.schoolTier}`;
  return "未识别";
}

function scaleOf(profile) {
  const scale = String(profile.gpaScale || "");
  if (scale === "100") return "100";
  if (scale === "4") return "4";
  if (scale === "5") return "5";
  return "";
}

function gpaOf(profile) {
  const value = Number(profile.gpaValue);
  return Number.isFinite(value) ? value : null;
}

function gpaLabel(profile) {
  const value = gpaOf(profile);
  if (value == null) return "未填写成绩";
  const scale = scaleOf(profile);
  return `GPA ${value}${scale ? `/${scale}` : ""}`;
}

function targetText(record) {
  const applicant = record.applicant || {};
  const schools = listOf(applicant.targetSchools);
  const regions = listOf(applicant.regions);
  const fields = listOf(applicant.fields);
  return [regions.join("、"), schools.length ? `${schools.length}所学校` : "全部学校", fields.length ? `${fields.length}个方向` : "全部方向"].filter(Boolean).join(" · ");
}

function resultOf(record) {
  return record.result || {};
}

function resultRows(record) {
  return listOf(resultOf(record).results);
}

function feedbackOf(record) {
  return record.feedback || null;
}

function countValues(values) {
  return values.reduce((map, value) => {
    const key = String(value || "未填写");
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});
}

function percent(value, total) {
  return total ? Math.max(4, Math.round((value / total) * 100)) : 0;
}

function renderBars(target, entries, total, emptyText) {
  const rows = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  $(target).innerHTML = rows.length ? rows.map(([label, value]) => `
    <div class="bar-row"><span class="bar-label">${escapeHtml(label)}</span><span class="bar-track"><i class="bar-fill" style="--bar:${percent(value, total)}%"></i></span><span class="bar-value">${value}</span></div>`).join("") : `<p class="chart-empty">${escapeHtml(emptyText)}</p>`;
}

function renderDashboard() {
  const completed = records.filter(record => record.status === "completed").length;
  const feedbackCount = records.filter(record => feedbackOf(record)).length;
  const gpas = records.map(record => gpaOf(profileOf(record))).filter(value => value != null);
  const projectCounts = records.map(record => resultRows(record).length).filter(value => value > 0);
  const average = values => values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1) : "—";
  const feedbackRate = records.length ? `${Math.round((feedbackCount / records.length) * 100)}%` : "—";
  $("#metrics").innerHTML = [
    [records.length, "分析记录", "已保存的申请人分析"],
    [completed, "已完成分析", records.length ? `${Math.round((completed / records.length) * 100)}% 完成率` : "暂无记录"],
    [feedbackRate, "问卷回收率", `${feedbackCount} 条已提交`],
    [average(gpas), "平均成绩值", gpas.length ? `${gpas.length} 条含成绩记录` : "暂无可计算成绩"],
    [average(projectCounts), "平均分析项目数", projectCounts.length ? `${projectCounts.length} 条含结果记录` : "暂无分析结果"]
  ].map(([value, label, note]) => `<div class="metric"><span class="metric-value">${escapeHtml(value)}</span><span class="metric-label">${escapeHtml(label)}</span><span class="metric-note">${escapeHtml(note)}</span></div>`).join("");

  renderBars("#tier-chart", countValues(records.map(record => tierOf(profileOf(record)))), records.length, "有申请人分析记录后显示层次分布");
  renderBars("#experience-chart", {
    "有实习": records.filter(record => hasExperience(profileOf(record), "internships")).length,
    "有科研": records.filter(record => hasExperience(profileOf(record), "researches")).length,
    "有竞赛/奖项": records.filter(record => hasExperience(profileOf(record), "awards")).length
  }, records.length, "有申请人分析记录后显示经历覆盖");
  renderBars("#feedback-chart", countValues(records.filter(record => feedbackOf(record)).map(record => labels.usefulness[feedbackOf(record).usefulness] || "已提交")), feedbackCount, "还没有提交问卷");
}

function experienceSummary(profile) {
  return [
    ["实习", "internships"],
    ["科研", "researches"],
    ["竞赛/奖项", "awards"]
  ].map(([label, key]) => {
    const items = listOf(profile[key]).filter(filled);
    const lines = items.map(item => Object.values(item).filter(value => value !== null && value !== undefined && String(value).trim() !== "").map(value => String(value)).join(" · ")).filter(Boolean);
    return `<div class="experience-block"><h4>${label}（${items.length}段）</h4>${lines.length ? `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : `<span class="meta">未填写</span>`}</div>`;
  }).join("");
}

function renderResultList(record) {
  const rows = resultRows(record);
  if (!rows.length) return `<p class="meta">本次没有保存项目分析结果。</p>`;
  return `<div class="result-list">${rows.map(row => {
    const programme = row.programme || {};
    const result = row.result || {};
    const probability = result.assessmentAvailable && Number.isFinite(Number(result.center)) ? `${result.center}% (${result.low}%–${result.high}%)` : "待分析";
    return `<div class="result-item"><span>${escapeHtml(`${programme.university || programme.school || ""} · ${programme.nameZh || programme.name || "未命名项目"}`)}</span><strong class="${probability === "待分析" ? "waiting" : ""}">${escapeHtml(probability)}</strong></div>`;
  }).join("")}</div>`;
}

function renderFeedback(record) {
  const feedback = feedbackOf(record);
  if (!feedback) return `<div class="feedback-box"><strong>问卷</strong><p><span>状态：</span>尚未填写</p></div>`;
  return `<div class="feedback-box"><strong>问卷反馈</strong><p><span>帮助程度：</span>${escapeHtml(labels.usefulness[feedback.usefulness] || feedback.usefulness)}</p><p><span>最有价值：</span>${escapeHtml(labels.valuable[feedback.valuable] || feedback.valuable)}</p><p><span>清晰度：</span>${escapeHtml(labels.clarity[feedback.clarity] || feedback.clarity)}</p>${feedback.comment ? `<p><span>补充意见：</span>${escapeHtml(feedback.comment)}</p>` : ""}</div>`;
}

function renderRecord(record) {
  const profile = profileOf(record);
  const results = resultRows(record);
  const assessed = results.filter(row => row.result?.assessmentAvailable).length;
  const created = record.createdAt ? new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
  const profileText = record.applicant?.profileText;
  return `<details class="record">
    <summary>
      <span></span>
      <span class="record-title"><strong>${escapeHtml(profile.university || "本科院校未填写")}</strong><span>${escapeHtml(profile.major || "本科专业未填写")} · ${escapeHtml(gpaLabel(profile))}</span></span>
      <span class="record-summary">${escapeHtml(targetText(record) || "未填写申请范围")}<br>${results.length} 个结果，${assessed} 个有概率</span>
      <span class="record-time">${escapeHtml(created)}</span>
      <span><em class="status-badge ${escapeHtml(record.status)}">${escapeHtml(labels.status[record.status] || record.status)}</em><br><em class="feedback-badge ${feedbackOf(record) ? "has" : ""}">${feedbackOf(record) ? "已回收问卷" : "未填写问卷"}</em></span>
    </summary>
    <div class="record-body">
      <div class="record-columns">
        <section>
          <h3>申请人资料</h3>
          <dl class="data-list">
            <dt>本科院校</dt><dd>${escapeHtml(profile.university || "未填写")} ${profile.schoolClassification ? `（${escapeHtml(profile.schoolClassification)}）` : ""}</dd>
            <dt>本科专业</dt><dd>${escapeHtml(profile.major || profile.majorName || "未填写")}</dd>
            <dt>成绩</dt><dd>${escapeHtml(gpaLabel(profile))}</dd>
            <dt>语言</dt><dd>${escapeHtml([profile.languageTest, profile.language].filter(value => value !== null && value !== undefined && String(value).trim() !== "").join(" ") || "未填写")}</dd>
            <dt>申请地区</dt><dd>${escapeHtml(listOf(record.applicant?.regions).join("、") || "未填写")}</dd>
            <dt>申请学校</dt><dd>${escapeHtml(listOf(record.applicant?.targetSchools).join("、") || "全部学校")}</dd>
            <dt>申请方向</dt><dd>${escapeHtml(listOf(record.applicant?.fields).join("、") || "全部方向")}</dd>
            <dt>课程</dt><dd>${escapeHtml(listOf(profile.courseNames).join("、") || profile.additionalCourses || "未填写")}</dd>
          </dl>
          ${experienceSummary(profile)}
          ${profileText ? `<div class="experience-block"><h4>申请资料摘要</h4><p class="meta">${escapeHtml(profileText)}</p></div>` : ""}
        </section>
        <section>
          <h3>分析结果</h3>
          <dl class="data-list"><dt>状态</dt><dd>${escapeHtml(labels.status[record.status] || record.status)}</dd><dt>生成时间</dt><dd>${escapeHtml(record.completedAt ? new Date(record.completedAt).toLocaleString("zh-CN", { hour12: false }) : "未完成")}</dd><dt>读取项目数</dt><dd>${results.length}</dd><dt>有概率项目</dt><dd>${assessed}</dd></dl>
          <div class="experience-block"><h4>项目概率与结果</h4>${renderResultList(record)}</div>
          ${record.error ? `<div class="feedback-box"><strong>错误信息</strong><p>${escapeHtml(record.error)}</p></div>` : ""}
          ${renderFeedback(record)}
        </section>
      </div>
      <details class="raw-detail"><summary>查看完整原始记录（申请资料与分析结果）</summary><pre>${escapeHtml(JSON.stringify({ applicant: record.applicant, result: record.result, feedback: record.feedback }, null, 2))}</pre></details>
    </div>
  </details>`;
}

function matches(record) {
  const profile = profileOf(record);
  const applicant = record.applicant || {};
  const query = $("#query").value.trim().toLowerCase();
  const searchText = [profile.university, profile.major, profile.majorName, applicant.profileText, ...listOf(applicant.regions), ...listOf(applicant.fields)].join(" ").toLowerCase();
  const gpa = gpaOf(profile);
  return (!query || searchText.includes(query))
    && (!$("#tier").value || tierOf(profile) === $("#tier").value)
    && (!$("#scale").value || scaleOf(profile) === $("#scale").value)
    && (!$("#gpa-min").value || (gpa != null && gpa >= Number($("#gpa-min").value)))
    && (!$("#internship").value || ($("#internship").value === "yes") === hasExperience(profile, "internships"))
    && (!$("#research").value || ($("#research").value === "yes") === hasExperience(profile, "researches"))
    && (!$("#feedback").value || ($("#feedback").value === "yes") === Boolean(feedbackOf(record)))
    && (!$("#status").value || record.status === $("#status").value);
}

function renderRecords() {
  const filtered = records.filter(matches);
  $("#record-count").textContent = `${filtered.length} / ${records.length} 条`;
  $("#filter-hint").textContent = filtered.length === records.length ? "当前显示全部记录。点击一行左侧的 + 展开申请人资料、经历、分析结果和问卷。" : `当前筛选出 ${filtered.length} 条记录。筛选只改变显示，不会修改数据库。`;
  $("#records").innerHTML = filtered.length ? filtered.map(renderRecord).join("") : `<p class="empty">没有符合当前条件的分析记录。</p>`;
}

async function load() {
  $("#records").innerHTML = `<p class="empty">正在读取分析记录…</p>`;
  try {
    const payload = await json("/api/admin/analysis-records?limit=1000");
    records = Array.isArray(payload.records) ? payload.records : [];
    renderDashboard();
    renderRecords();
  } catch (error) {
    $("#records").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

for (const control of document.querySelectorAll("#filters input, #filters select")) {
  control.addEventListener(control.tagName === "INPUT" ? "input" : "change", renderRecords);
}
$("#refresh").addEventListener("click", load);
$("#logout").addEventListener("click", async () => {
  await json("/api/admin/logout", { method: "POST" });
  location.replace("/admin.html");
});
load();
