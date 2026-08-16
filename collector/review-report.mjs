import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listCases, openCaseStore } from "./store.mjs";
import { programmeMaster } from "../master-data.mjs";

const outputPath = resolve(process.argv[2] || "outputs/review-queue.md");
const db = openCaseStore();
let rows;
let rejectedRows;
try {
  const allRows = listCases(db, 1000);
  rows = allRows.filter(row => ["pending", "needs-review"].includes(row.reviewStatus));
  rejectedRows = allRows.filter(row => row.reviewStatus === "rejected");
} finally {
  db.close();
}

const list = values => values?.length ? values.map(value => `  - ${value}`).join("\n") : "  - 未披露";
const evidenceLine = row => {
  const matched = Object.values(row.sourceEvidence?.matched || {}).filter(Boolean).length;
  const missing = Object.values(row.sourceEvidence?.missing || {}).filter(Boolean).length;
  return `${matched} 个硬字段已在抓取原文找到${missing ? `，${missing} 个未找到` : ""}；仍需人工打开来源核对`;
};
const sourceLine = row => {
  const refs = row.sourceRefs || [];
  return refs.length > 1
    ? `- 交叉来源：${refs.map(ref => `[${ref.comparison?.status || "未比较"}](${ref.url})`).join("、")}`
    : "- 交叉来源：当前只有一个来源";
};
const blocks = rows.map((row, index) => {
  const programme = programmeMaster.find(item => item.id === row.targetProgrammeId);
  return `## ${index + 1}. ${row.undergraduateUniversity || "本科院校缺失"} · ${row.reviewStatus}

- fingerprint：\`${row.fingerprint}\`
- 目标项目原文：${row.targetUniversity || "未披露"} / ${row.targetProgramme || "未披露"}
- 项目主表：${programme ? `${programme.nameEn}（${programme.id}）` : "未匹配"}
- 本科：${row.undergraduateUniversity || "未披露"} / ${row.undergraduateMajor || "未披露"}
- GPA原文：${row.gpaRaw || "未披露"}
- GPA分制：${row.gpaScale}；可比较百分制值：${row.gpa100 ?? "无，不跨分制换算"}
- 语言：${row.languageTest || "未披露"} ${row.languageScore ?? ""} ${row.languageScale || ""}
- 年份：${row.offerYear || "未披露"}
- 自动原文核对：${evidenceLine(row)}
- 结构校验：${row.issues.length ? row.issues.join("；") : "无结构错误，仍需核对网页原文"}
- 来源：[打开原始页面](${row.sourceUrl})
${sourceLine(row)}

实习：
${list(row.internships)}

工作：
${list(row.workExperience)}

科研：
${list(row.research)}

竞赛：
${list(row.competitions)}

奖项：
${list(row.awards)}

专利：
${list(row.patents)}

项目：
${list(row.projects)}

审核命令：

\`node collector/agent.mjs approve "${row.fingerprint}"\`

拒绝命令：

\`node collector/agent.mjs reject "${row.fingerprint}"\`
`;
});

const report = `# 案例人工审核队列

生成时间：${new Date().toISOString()}

共 ${rows.length} 条待审核；另有 ${rejectedRows.length} 条保留但不进入分析的拒绝/重复记录。请逐条打开原始页面，重点核对申请人边界、目标项目、本科院校/专业、GPA原文与分制、语言考试、年份和经历是否串人。通过审核前，案例不会进入RAG或概率分析。

${blocks.join("\n---\n\n")}
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, report, "utf8");
console.log(JSON.stringify({ output: outputPath, pending: rows.length }, null, 2));
