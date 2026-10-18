import assert from "node:assert/strict";
import { openCaseStore } from "./store.mjs";
import { allocateSearchSourceLimit, allocateSearchSourceRotationLimit, anchoredProgrammeId, applyCriticalVerification, assessBatchQuality, buildCaseSearchQuery, buildLowCoverageProgrammePlans, buildOcrRequestBody, buildProgrammeCollectionPlan, buildSearchPlannerRequest, buildSourceCandidates, cachedCasesMatchProgrammes, candidatesForQueue, canonicalizeCandidateUrl, classifyProgrammeScope, classifyProgrammeStatus, crawlSourceNeedsAttempt, criticalVerificationReasons, discoverCompassCaseCandidates, discoverEntryLinks, discoverHksgCaseCandidates, discoverMastermateCaseCandidates, discoverSeedCaseCandidates, discoverLinks, extractImageUrls, extractStructuredCasesForSource, fallbackTargetHeadingHits, filterCandidatesForProgramme, filterCandidatesForProgrammes, inferCriticalOfferYear, inferGpaScale, inferOfferYear, inferSourcePublishedAt, isCoreEngineeringProgramme, mergeProgrammeJobs, normalizeCandidate, normalizeOcrResponseText, parseCompassDetailCandidates, parseCompassIndexCandidates, parseHksgLinkCandidates, parseSeedCaseCandidates, parseSearchResultUrls, planNextAgentAction, preparePageTextForSource, programmeCollectionAllowed, programmeScopeAllowed, recoverGpaFromSourceText, resolveHksgIndexedProgramme, resolveOfferYear, robotsAllowsText, scoreHksgIndexedCaseForProgramme, scoreMastermateIndexedCaseForProgramme, scorePageForExtraction, scoreSearchCandidate, searchQueryVariants, shouldSkipPagePrefilter, stripHtml, validateExtractionPayload, validateSearchPlan, verifyCandidateAgainstText } from "./agent.mjs";

const selectedProjectDb = openCaseStore(":memory:");
try {
  const selectedPlans = buildLowCoverageProgrammePlans({ db: selectedProjectDb, programmeIds: ["cuhk-ee", "hkust-ee"], limit: 20 });
  assert.deepEqual(new Set(selectedPlans.map(plan => plan.programmeId)), new Set(["cuhk-ee", "hkust-ee"]), "Explicit collection must not expand to other programmes");
  const sourceStatement = selectedProjectDb.prepare("INSERT INTO crawl_source_scopes (source_url, programme_id, status, first_seen_at, last_checked_at) VALUES (?, 'cuhk-ee', 'completed', '2026-01-01', '2026-01-01')");
  for (let index = 0; index < 12; index += 1) sourceStatement.run(`https://source${index % 3}.example.com/case/${index}`);
  const runStatement = selectedProjectDb.prepare("INSERT INTO agent_runs (id, goal_json, state, started_at, report_json) VALUES (?, '{\"programmeId\":\"cuhk-ee\"}', 'completed', ?, '{\"errors\":0,\"pagesAttempted\":1}')");
  runStatement.run("no-progress-1", "2026-01-01");
  runStatement.run("no-progress-2", "2026-01-02");
  assert.equal(buildLowCoverageProgrammePlans({ db: selectedProjectDb, institutionIds: ["cuhk"], limit: 200 }).some(plan => plan.programmeId === "cuhk-ee"), false, "Automatic collection must skip exhausted projects");
  assert.equal(buildLowCoverageProgrammePlans({ db: selectedProjectDb, programmeIds: ["cuhk-ee"], limit: 20 }).some(plan => plan.programmeId === "cuhk-ee"), true, "Explicit selection may retry an exhausted project");
} finally {
  selectedProjectDb.close();
}

const statusProgramme = { id: "cityu-hk-msc-cybersecurity", institutionId: "cityu-hk", nameEn: "MSc Cybersecurity", nameZh: "MSc Cybersecurity" };
assert.equal(classifyProgrammeStatus({ programme: statusProgramme, officialUrl: "https://www.cityu.edu.hk/en/pg/programme/p91", finalUrl: "https://www.cityu.edu.hk/en/pg/programme/p91", httpStatus: 200, html: "<title>City University of Hong Kong MSc Cybersecurity</title><p>2026/27 admission</p>" }).status, "current-history-unknown");
assert.equal(classifyProgrammeStatus({ programme: statusProgramme, officialUrl: "https://www.cityu.edu.hk/en/pg/programme/p91", httpStatus: 200, html: "<title>MSc Cybersecurity</title><p>New degree programme for 2026 entry</p>" }).status, "confirmed-new");
assert.equal(classifyProgrammeStatus({ programme: statusProgramme, officialUrl: "https://www.cityu.edu.hk/en/pg/programme/p91", httpStatus: 404 }).status, "unverified");
assert.equal(programmeCollectionAllowed({ status: "confirmed-new" }), false);
assert.equal(programmeCollectionAllowed({ status: "current-history-unknown" }), true);
assert.equal(classifyProgrammeScope({ id: "test-msc", institutionId: "ntu", nameEn: "Master of Science in Data Science" }).scope, "target");
assert.equal(classifyProgrammeScope({ id: "test-exec", institutionId: "ntu", nameEn: "Executive Master of Business Administration" }).scope, "catalog-only");
assert.equal(classifyProgrammeScope({ id: "test-research", institutionId: "ntu", nameEn: "Master of Research in Data Science" }).scope, "needs-review");
assert.equal(programmeScopeAllowed({ scope: "catalog-only" }), false);

assert.equal(
  cachedCasesMatchProgrammes([
    { targetUniversity: "新加坡国立大学", targetProgramme: "工业与系统工程理学硕士" },
    { targetUniversity: "新加坡国立大学", targetProgramme: "机械工程理学硕士" }
  ], ["nus-master-of-science-industrial-systems-engineering"]),
  true,
  "A cached raw extraction should be reusable when it resolves to the requested programme"
);
assert.equal(
  cachedCasesMatchProgrammes([
    { targetUniversity: "新加坡国立大学", targetProgramme: "工业与系统工程理学硕士" }
  ], ["nus-master-of-science-biomedical-engineering"]),
  false,
  "A cached extraction must not be reused for an unrelated programme"
);
assert.equal(
  shouldSkipPagePrefilter({ decision: "skip", reasons: ["no-explicit-programme-heading"] }, { trustedProgrammeId: "target-programme" }),
  false,
  "A trusted source match may bypass an over-strict detail-page programme prefilter"
);
assert.equal(
  shouldSkipPagePrefilter({ decision: "skip", reasons: ["source-before-2021:2020"] }, { trustedProgrammeId: "target-programme" }),
  true,
  "A trusted source match must still obey the 2021 source-year floor"
);

const integratedCircuitProgramme = {
  nameEn: "Master of Science (Integrated Circuit Design)",
  nameZh: "Master of Science (Integrated Circuit Design)",
  aliases: ["集成电路设计理学硕士"]
};
assert.deepEqual(
  fallbackTargetHeadingHits("2026年南洋理工大学计算机控制与自动化理学硕士研究生录取案例一览", integratedCircuitProgramme),
  [],
  "A sibling programme heading must not bootstrap an integrated-circuit crawl"
);
assert.ok(
  fallbackTargetHeadingHits("2026 Nanyang Technological University Master of Science (Integrated Circuit Design) cases", integratedCircuitProgramme).length > 0,
  "An exact programme heading must remain eligible for fallback discovery"
);
assert.deepEqual(
  fallbackTargetHeadingHits("2026年香港中文大学电子工程理学硕士研究生录取案例一览", {
    nameEn: "MSc Artificial Intelligence for Sciences",
    nameZh: "理学硕士(人工智能与科学)",
    strictMatchTerms: ["理学硕士", "人工智能与科学硕士"]
  }),
  [],
  "A generic degree label must not count as a programme heading"
);

assert.equal(
  scorePageForExtraction({
    url: "https://www.ukpass.org/study/detail-15807.html",
    html: "<title>CityU Master admission case</title>",
    pageText: "2025 admission case. Master offer. GPA 3.5. IELTS 7.0. 本科院校：某大学。本科专业：计算机科学。",
    programmeId: "cityu-hk-msc-artificial-intelligence-for-sciences"
  }).decision,
  "skip",
  "A generic degree label without a target programme must not reach extraction"
);

const text = stripHtml("<html><style>.x{}</style><script>bad()</script><p>GPA 3.6 / 4.0</p><div>IELTS&nbsp;7</div></html>");
assert.ok(text.includes("GPA 3.6 / 4.0"), "Visible case text must be retained");
assert.ok(!text.includes("bad()"), "Scripts must not enter the extraction prompt");
assert.equal(recoverGpaFromSourceText({ gpaRaw: null }, "GPA 3.2", "xdf-public-cases").gpaRaw, "3.2");
assert.equal(recoverGpaFromSourceText({ gpaRaw: null }, "GPA 3.2", "jjl-public-cases").gpaRaw, null);
assert.equal(recoverGpaFromSourceText({ gpaRaw: "81.54" }, "GPA 3.2", "xdf-public-cases").gpaRaw, "81.54");
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/offer/ntu-cca",
    html: "<title>NTU MSc Computer Control and Automation offer case</title>",
    pageText: "2026年NTU admission case. 本科院校：南京大学。本科专业：自动化。GPA 86/100。",
    programmeId: "ntu-cca"
  }).decision,
  "pass",
  "A target programme case page must pass the local prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/cuhk-data-business-statistics",
    html: "<title>CUHK Data Science and Business Statistics offer case</title>",
    pageText: "2025 admission case. Undergraduate university: CUHK. Undergraduate major: Mathematics. GPA 3.6/4.0. IELTS 7.0. Offer: Data Science and Business Statistics.",
    programmeId: "cuhk-msc-in-data-science-and-business-statistics"
  }).decision,
  "pass",
  "A safe project alias must pass strict programme matching"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/cuhk-data-generic",
    html: "<title>CUHK Data Science offer case</title>",
    pageText: "2025 admission case. Undergraduate university: CUHK. Undergraduate major: Mathematics. GPA 3.6/4.0. IELTS 7.0.",
    programmeId: "cuhk-msc-in-data-science-and-business-statistics"
  }).decision,
  "skip",
  "A generic Data Science phrase must not pass as the business-statistics programme"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.peccn.com/uk/202412/19/36969.html",
    html: "<title>香港中文大学数据科学录取案例</title>",
    pageText: "香港中文大学数据科学录取案例。学生背景。2024年。本科院校：某大学。本科专业：计算机科学。GPA 85/100。",
    programmeId: "cuhk-msc-in-advanced-studies-in-statistics-and-data-science",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "A school-and-direction match must not enter programme-scoped extraction"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.peccn.com/uk/202412/19/36969.html",
    html: "<title>NTU、CUHK任选offer案例</title>",
    pageText: "NTU、CUHK录取案例。2024年。本科院校：某大学。本科专业：计算机科学。GPA 85/100。",
    programmeId: "cuhk-msc-in-advanced-studies-in-statistics-and-data-science",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "Multi-institution summary pages must not trigger an expensive direction-only model call"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.peccn.com/uk/202412/19/36967.html",
    html: "<title>NUS offer</title>",
    pageText: "\u5f55\u53d6\u9662\u6821\u53ca\u4e13\u4e1a\uff1aNUS MSc Chemical Engineering\n\u672c\u79d1\u9662\u6821\uff1a211\n\u672c\u79d1\u4e13\u4e1a\uff1a\u8f6f\u4ef6\u5de5\u7a0b\nGPA 82\n2025\u5e74\u5f55\u53d6\n\u540e\u6587\u63d0\u5230\u7533\u8bf7\u8ba1\u7b97\u673a\u7c7b\u9879\u76ee",
    programmeId: "nus-master-of-computing-general-track",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "PECCN offer fields must outrank later consultant text when the offer programme mismatches"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.jjl.cn/case/759597.html",
    html: "<title>2020 Hong Kong Polytechnic University admission case</title>",
    pageText: "2020-05-07 香港理工大学录取案例。2020年录取。本科院校：北京交通大学。本科专业：电气工程。GPA 88.8。IELTS 6.5。",
    programmeId: "polyu-hk-smart-manufacturing",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "Cases published before 2021 must be rejected before any model call"
);
assert.deepEqual(
  mergeProgrammeJobs([
    { url: "https://example.com/case/1", programmeId: "ntu-ee" },
    { url: "https://example.com/case/1", programmeId: "ntu-cca" },
    { url: "https://example.com/case/2", programmeId: "nus-ee" }
  ]),
  [
    { url: "https://example.com/case/1", programmeId: null, requestedProgrammeIds: ["ntu-ee", "ntu-cca"] },
    { url: "https://example.com/case/2", programmeId: "nus-ee", requestedProgrammeIds: ["nus-ee"] }
  ],
  "The pilot must merge repeated URLs before crawling"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/news/tuition",
    html: "<title>NTU tuition and application deadline</title>",
    pageText: "Programme tuition fees, deadline, application instructions.",
    programmeId: "ntu-cca"
  }).decision,
  "skip",
  "A non-case programme page must be skipped before model extraction"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/admission/7418",
    html: "<title>CUHK Mechanical and Automation Engineering case</title>",
    pageText: "香港中文大学机械与自动化工程硕士案例。学生背景、GPA、IELTS、科研项目。相关推荐：City University of Hong Kong。",
    programmeId: "cityu-cie"
  }).decision,
  "skip",
  "A recommendation keyword must not make a different target programme pass"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/ntu-ee",
    html: "<title>NUS Electrical Engineering admission case</title>",
    pageText: "2026-03-01 NUS Electrical Engineering applicant case. 本科院校：南京大学。本科专业：电子工程。GPA 85/100。",
    programmeId: "nus-ee"
  }).decision,
  "pass",
  "A target university with matching engineering direction must pass"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/nus-multiple-programmes",
    html: "<title>NUS/NTU admission cases: AI, Robotics and Biomedical Informatics</title>",
    pageText: "NUS AI、Biomedical Informatics、Robotics录取案例。学生GPA 3.85，IELTS 7.0。",
    programmeId: "nus-ee"
  }).decision,
  "skip",
  "A multi-programme page without the target programme must be skipped"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/cuhk-ie",
    html: "<title>CUHK Information Engineering offer</title>",
    pageText: "2026年香港中文大学信息工程硕士录取案例。本科院校：南京大学。本科专业：计算机科学，GPA 3.3，有科研和项目经历。",
    programmeId: "cuhk-ie"
  }).decision,
  "pass",
  "A page with the simplified target programme name must pass"
);
assert.equal(
  scorePageForExtraction({
    url: "https://liuxue.xdf.cn/blog/example/case/3144557.shtml",
    html: "<title>香港理工大学电气工程硕士案例</title><img src=\"profile.png\"><img src=\"offer.png\">",
    pageText: "香港理工大学电气工程硕士录取案例。学生背景介绍和申请结果，详细成绩在图片中。",
    programmeId: "polyu-ee"
  }).decision,
  "pass",
  "A detail case page with image-based profile data must pass the local prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://liuxue.xdf.cn/blog/admission/blog/3029166.shtml",
    html: "<title>香港科技大学大数据科技案例</title>",
    pageText: "录取院校：香港科技大学 大数据科技。毕业/在读学校：武汉大学。专业：计算机科学技术。GPA 3.55。TOEFL 104。2021年录取。",
    programmeId: "hkust-bdt"
  }).decision,
  "pass",
  "Table-style undergraduate school labels must pass the local prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/hku-eee",
    html: "<title>HKU Electrical and Electronic Engineering offer</title>",
    pageText: "2025-03-01 学生背景：国内本科。本科专业：自动化。GPA：80。雅思7。",
    programmeId: "hku-eee"
  }).decision,
  "skip",
  "A page that only says domestic undergraduate cannot become approved and must be skipped before the model call"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/hku-eee",
    html: "<title>HKU Electrical and Electronic Engineering offer</title>",
    pageText: "2026-01-11 背景介绍\n就读院校：吉林大学 电子信息工程\n在校均分：82.52",
    programmeId: "hku-eee"
  }).decision,
  "pass",
  "A compact source line containing university and major must retain both approved fields"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/ntu-robotics",
    html: "<title>南洋理工大学机器人与智能系统硕士录取案例</title>",
    pageText: "2026-03-11 王同学本科毕业于伦敦大学学院(UCL)机械工程专业，GPA62，成功获得南洋理工大学机器人与智能系统硕士录取。",
    programmeId: "ntu-robotics-intelligent-systems"
  }).decision,
  "pass",
  "Natural-language university and major profiles must pass the prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.hksg.org/offer_21282",
    html: "<title>南洋理工大学应用人工智能计算机硕士 offer</title>",
    pageText: "南洋理工大学应用人工智能计算机硕士，GPA 80-84分，IELTS 6，2026年录取。",
    programmeId: "ntu-master-of-science-cyber-security"
  }).decision,
  "skip",
  "A same-university but different programme case must not pass a programme-scoped prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.compassedu.hk/offers_1693",
    html: "<title>2026年南洋理工大学电力工程理学硕士研究生录取案例一览</title>",
    pageText: "2026年南洋理工大学电力工程理学硕士录取案例。本科院校：华南理工大学。本科专业：能源与动力工程。GPA 2.88。雅思6.0。",
    programmeId: "ntu-master-of-science-cyber-security"
  }).decision,
  "skip",
  "A same-university page naming another concrete programme must remain excluded"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.compassedu.hk/newst_10001",
    html: "<title>2026年南洋理工大学工科录取案例汇总</title>",
    pageText: "2026年南洋理工大学工科录取案例汇总。本科院校：华南理工大学。本科专业：计算机科学。GPA 3.5。雅思7.0。科研项目经历。",
    programmeId: "ntu-master-of-science-cyber-security"
  }).decision,
  "skip",
  "A target-school engineering summary without an explicit programme must be skipped"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.compassedu.hk/offers_1689",
    html: "<title>2026年南洋理工大学数据科学与其他工科录取案例</title>",
    pageText: "2026年南洋理工大学数据科学与其他工科录取案例。本科院校：华南理工大学。本科专业：材料科学与工程。GPA 3.5。雅思7.0。科研项目经历。",
    programmeId: "ntu-master-of-science-applied-materials-analytics"
  }).decision,
  "skip",
  "A multi-programme summary without an explicit target programme must be skipped"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.ukpass.org/study/detail-12679.html",
    html: "<title>Nanyang Technological University Signal Processing &amp; Machine Learning offer</title>",
    pageText: "Nanyang Technological University Signal Processing & Machine Learning offer case. GPA 87. IELTS 7.0. 本科院校：上海科技大学。本科专业：电子信息工程。",
    programmeId: "ntu-master-of-science-signal-processing",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "A more-specific sibling programme must not pass a shorter programme prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://www.mastermate.cn/admission/7418",
    html: "<title>香港中文大学机械与自动化工程硕士案例</title>",
    pageText: "香港理工大学相关案例推荐。本科院校：双非。本科专业：飞行器动力工程。GPA 88.16/100。2023年录取。雅思6.5。项目经历。",
    programmeId: "polyu-hk-artificial-intelligence-and-big-data-computing",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "Direction-only fallback must not trust target-university mentions from related-case content"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/nus-bmi",
    html: "<title>新加坡国立大学生物医学信息录取案例</title>",
    pageText: "2026年双非本科院校，生物科学专业，四年均分80，雅思7.0，成功录取新加坡国立大学生物医学信息硕士。",
    programmeId: "nus-biomedical-informatics"
  }).decision,
  "pass",
  "Tier-only undergraduate profiles with an explicit major must pass the prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/case/polyu-ee",
    html: "<title>香港理工大学电机工程硕士录取案例</title>",
    pageText: "2025-03-05 双非一本 电气工程及自动化专业 均分86 雅思6，成功录取香港理工大学电机工程硕士。",
    programmeId: "polyu-ee"
  }).decision,
  "pass",
  "Tier plus first-batch label and major must pass the prefilter"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/admission/low-coverage-signal-case",
    html: "<title>2026 engineering admission case</title>",
    pageText: "2026年通信工程录取案例。本科院校：南京大学。本科专业：电子信息工程。GPA 85/100，IELTS 7.0，科研项目经历。",
    programmeId: "ntu-master-of-science-signal-processing"
  }).decision,
  "skip",
  "Direction-only discovery must stay opt-in"
);
assert.equal(
  scorePageForExtraction({
    url: "https://example.com/admission/low-coverage-signal-case",
    html: "<title>Nanyang Technological University 2026 engineering admission case</title>",
    pageText: "2026年通信工程录取案例。本科院校：南京大学。本科专业：电子信息工程。GPA 85/100，IELTS 7.0，科研项目经历。",
    programmeId: "ntu-master-of-science-signal-processing",
    allowDirectionOnly: true
  }).decision,
  "skip",
  "Low-coverage runs must not bypass the explicit-programme requirement"
);
assert.equal(
  assessBatchQuality({
    pages: [
      { status: "completed", modelCalled: false, skipped: true, extracted: 0, scoped: 0, queued: 0, duplicates: 0, candidates: [] },
      { status: "completed", modelCalled: true, skipped: false, extracted: 2, scoped: 2, queued: 2, duplicates: 0, candidates: [{ issues: [] }, { issues: [] }] }
    ],
    usage: { extraction: { totalTokens: 1000 } }
  }).status,
  "pass",
  "A batch with correct target matching and clean candidates must pass"
);
assert.equal(
  assessBatchQuality({
    pages: [{ status: "completed", modelCalled: false, extractionMethod: "structured-source", skipped: false, extracted: 1, scoped: 1, queued: 1, duplicates: 0, candidates: [{ issues: [] }] }],
    usage: {}
  }).status,
  "pass",
  "Deterministic structured extraction is a successful zero-token batch"
);
assert.equal(
  assessBatchQuality({
    pages: [{ status: "completed", modelCalled: true, skipped: false, extracted: 10, scoped: 2, queued: 1, duplicates: 1, candidates: [{ issues: ["target mismatch"] }] }],
    usage: { extraction: { totalTokens: 1000 } }
  }).status,
  "fail",
  "A batch dominated by out-of-scope extraction must fail"
);
assert.equal(
  assessBatchQuality({
    pages: [{
      status: "completed", modelCalled: true, extracted: 10, scoped: 2, preservedUnmatched: 8,
      requestedProgrammeIds: ["nus-robotics"], queued: 10, duplicates: 0,
      candidates: [
        { targetProgrammeId: "nus-robotics", issues: [] },
        { targetProgrammeId: "nus-robotics", issues: [] },
        ...Array.from({ length: 8 }, () => ({ targetProgrammeId: null, issues: ["项目未匹配主表"] }))
      ]
    }],
    usage: { extraction: { totalTokens: 1000 } }
  }).status,
  "pass",
  "Intentionally preserved cases from other programmes must not make a successful scoped aggregate batch fail"
);
assert.equal(
  preparePageTextForSource("主案例\n相关案例\n其他人案例", "thinkwithu-public-cases"),
  "主案例",
  "Related-case cards on Thinkwithu detail pages must never enter the extraction prompt"
);
assert.equal(
  preparePageTextForSource("录取详情\n相关案例\n其他学生", "compassedu-public-cases"),
  "录取详情",
  "Compass detail pages must exclude recommendation cards"
);
assert.equal(
  preparePageTextForSource("导航\n相关案例\n录取详情\n学生背景\n相关案例\n其他学生", "compassedu-public-cases"),
  "导航\n相关案例\n录取详情\n学生背景",
  "Compass navigation labels must not remove the primary case"
);
assert.equal(
  preparePageTextForSource("录取详情\n学生背景\n相关案例\n其他学生", "hksg-public-cases"),
  "录取详情\n学生背景",
  "HKSg recommendation cards must not be extracted as the primary case"
);
assert.equal(
  preparePageTextForSource("导航".repeat(1000) + "\n背景介绍\n本科院校：吉林大学\nGPA 82\n院校解读\n推荐", "xdf-public-cases").includes("推荐"),
  false,
  "XDF extraction text must keep the case body and remove navigation and recommendations"
);
assert.equal(
  preparePageTextForSource("表单".repeat(1000) + "\n学生背景：国内本科\nGPA：80\n声明：转载\n常见问题", "jjl-public-cases").includes("常见问题"),
  false,
  "JJL extraction text must stop before boilerplate FAQs"
);
assert.equal(inferSourcePublishedAt("\u6848\u4f8b\u53d1\u5e03\u4e8e 2024\u5e743\u670825\u65e5"), "2024-03-25");
assert.equal(inferSourcePublishedAt("published 2024-03-25T17:46:39"), "2024-03-25");
assert.equal(inferSourcePublishedAt(`${"x".repeat(2000)}2004年2月1日之后赴荷留学的学生需要注册`), null);
assert.deepEqual(resolveOfferYear(2026, "2026申请季录取案例", "2026-04-18"), { value: 2026, inferred: null });
assert.deepEqual(
  resolveOfferYear(null, "香港大学录取时间：2024年12月30日", null),
  { value: 2024, inferred: { value: 2024, confidence: "medium", basis: "page-offer-date" } }
);
assert.deepEqual(
  resolveOfferYear(2023, "页面发表于2026年4月18日，正文没有录取年份", "2026-04-18"),
  { value: 2026, inferred: { value: 2026, confidence: "medium", basis: "source-publication-year-proxy" } },
  "An unsupported model/OCR year must not override the source publication year"
);
assert.deepEqual(
  extractStructuredCasesForSource(`案例标题\n2026-05-20\n录取详情\n学生姓名\nG同学\n录取学校\n南洋理工大学\n录取专业\n机器人与智能系统理学硕士\n毕业学校\n杭州电子科技大学\n本科专业\n自动化\n基本背景\nGPA 90分以上 / 杭州电子科技大学/自动化/GPA: 90-94/雅思7\n软性背景\n1. 实习:1段\n申请Timeline\n提交申请时间\n2025年12月2日\noffer发放时间\n2026年5月19日`, "hksg-public-cases"),
  [{
    targetUniversity: "南洋理工大学", targetProgramme: "机器人与智能系统理学硕士", targetProgrammeEnglishRaw: null,
    offerYear: 2026, undergraduateUniversity: "杭州电子科技大学", undergraduateMajor: "自动化",
    gpaRaw: "90分以上", gpaScale: "UNKNOWN", gpa100: null, languageTest: "雅思", languageScale: null,
    languageScore: 7, auxiliaryScores: [], experiences: [{ raw: "1. 实习:1段", category: "unknown", result: null }], sourcePublishedAt: "2026-05-20"
  }],
  "Stable HKSg label/value pages must bypass the LLM"
);
assert.deepEqual(extractStructuredCasesForSource("本科专业\n自动化", "xdf-public-cases"), []);
const compassCardCases = extractStructuredCasesForSource(`2026年香港中文大学电子工程理学硕士研究生录取案例一览
2026-02-13 23:00:51
香港中文大学电子工程理学硕士研究生offer一枚
利兹大学 电子与电气工程 应届生，GPA70.00
主要经历：嵌入式硬件实习工程师
W同学
香港中文大学电子工程理学硕士研究生offer一枚
南京大学 电子信息科学与技术 应届生，GPA4.02，雅思7.0
主要经历：FPGA项目`, "compassedu-public-cases");
assert.equal(compassCardCases.length, 2, "Compass card-style pages should be parsed without an LLM call");
assert.deepEqual(
  compassCardCases.map(item => ({
    targetUniversity: item.targetUniversity,
    targetProgramme: item.targetProgramme,
    undergraduateUniversity: item.undergraduateUniversity,
    undergraduateMajor: item.undergraduateMajor,
    gpaRaw: item.gpaRaw,
    languageTest: item.languageTest,
    languageScore: item.languageScore,
    offerYear: item.offerYear
  })),
  [
    { targetUniversity: "香港中文大学", targetProgramme: "电子工程理学硕士", undergraduateUniversity: "利兹大学", undergraduateMajor: "电子与电气工程", gpaRaw: "70.00", languageTest: null, languageScore: null, offerYear: 2026 },
    { targetUniversity: "香港中文大学", targetProgramme: "电子工程理学硕士", undergraduateUniversity: "南京大学", undergraduateMajor: "电子信息科学与技术", gpaRaw: "4.02", languageTest: "雅思", languageScore: 7, offerYear: 2026 }
  ],
  "Compass card-style extraction must preserve each applicant separately"
);
assert.deepEqual(
  extractStructuredCasesForSource(`新加坡国立大学生物医学信息学理学硕士研究生offer一枚
2026-03-10 15:11:36
录取详情
录取学校 新加坡国立大学
录取专业 生物医学信息学理学硕士
毕业学校 中国海洋大学
本科专业 生物技术
基本背景 应届生，GPA82.12，雅思6.5、六级489.0
主要经历
1. 数据分析中心分析员 2. 挑战杯
背景提升`, "compassedu-public-cases"),
  [{
    targetUniversity: "新加坡国立大学", targetProgramme: "生物医学信息学理学硕士", targetProgrammeEnglishRaw: null,
    offerYear: 2026, undergraduateUniversity: "中国海洋大学", undergraduateMajor: "生物技术",
    gpaRaw: "82.12", gpaScale: "UNKNOWN", gpa100: null, languageTest: "雅思", languageScale: null,
    languageScore: 6.5, auxiliaryScores: [], experiences: [{ raw: "1. 数据分析中心分析员 2. 挑战杯", category: "unknown", result: null }], sourcePublishedAt: "2026-03-10"
  }],
  "Stable Compass detail pages must bypass the LLM"
);
const validExtraction = {
  targetUniversity: null, targetProgramme: null, targetProgrammeEnglishRaw: null, offerYear: null,
  undergraduateUniversity: null, undergraduateMajor: null, gpaRaw: null, gpaScale: "UNKNOWN", gpa100: null,
  languageTest: null, languageScale: null, languageScore: null, auxiliaryScores: [], experiences: [], sourcePublishedAt: null
};
assert.equal(validateExtractionPayload({ cases: [validExtraction] }).cases.length, 1);
const { gpaRaw: omittedGpaRaw, ...withoutGpaRaw } = validExtraction;
assert.throws(() => validateExtractionPayload({ cases: [withoutGpaRaw] }), /缺少字段.*gpaRaw/);
assert.throws(() => validateExtractionPayload({ cases: [{ ...validExtraction, experiences: null }] }), /experiences 必须是数组/);
assert.deepEqual(
  extractImageUrls('<img src="/case-1.png"><img data-src="https://cdn.example.com/case-2.jpg"><img src="data:image/png;base64,abc">', "https://www.example.com/list"),
  ["https://www.example.com/case-1.png", "https://cdn.example.com/case-2.jpg"],
  "Image URLs must resolve relative paths and ignore data URLs"
);
assert.deepEqual(
  extractImageUrls('<img src="/img/logo.png"><img class="avatar" src="/file/mdpic/avatar.png"><img src="/file/mdpic/case.png">', "https://www.example.com/list"),
  ["https://www.example.com/file/mdpic/case.png"],
  "Content images must be prioritized while logos and avatars are excluded"
);
assert.deepEqual(
  extractImageUrls('<img src="/content/recommend.png"><img src="/ugc/case-1.png">', "https://www.example.com/list"),
  ["https://www.example.com/content/recommend.png", "https://www.example.com/ugc/case-1.png"],
  "UGC case images must be treated as OCR-relevant content"
);
assert.equal(buildOcrRequestBody("qwen3.8-max", [], true).enable_thinking, true, "Qwen3.8-Max image reading should enable thinking");
assert.equal(buildOcrRequestBody("qwen3.5-ocr", [], false).temperature, 0, "Non-thinking OCR requests should remain deterministic");
assert.equal(buildOcrRequestBody("qwen3.8-max", [], false).enable_thinking, false, "Disabling visual reasoning must be explicit to avoid hidden reasoning-token cost");

const source = { hosts: ["www.example.com"], detailRegexes: ["/offers_\\d+$"] };
const links = discoverLinks('<a href="/offers_1">one</a><a href="/offers_hk">category</a><a href="https://evil.example/offers_2">bad</a>', "https://www.example.com/list", source);
assert.deepEqual(links, ["https://www.example.com/offers_1"], "Discovery must stay inside configured hosts and case-detail patterns");
const hksgSource = { hosts: ["www.hksg.org"], entryRegexes: ["/major_\\d+$"], detailRegexes: ["/offer_\\d+$"] };
const hksgProgramme = {
  id: "ntu-master-of-science-cyber-security",
  institutionId: "ntu",
  nameEn: "Master of Science (Cyber Security)",
  nameZh: "Master of Science (Cyber Security)",
  aliases: []
};
assert.deepEqual(
  parseHksgLinkCandidates(
    '<a href="/major_9160"><span>Nanyang Technological University</span><span>Master of Science in Cyber Security (MSCS)</span></a><a href="/major_1"><span>Other University</span><span>Cyber Security</span></a>',
    "https://www.hksg.org",
    hksgSource,
    hksgProgramme,
    "seed"
  ),
  ["https://www.hksg.org/major_9160"],
  "HKSg project search must retain the target institution and programme entry only"
);
assert.deepEqual(
  parseHksgLinkCandidates(
    '<a href="/offer_1"><b>南洋理工大学集成电路设计理学硕士</b><span>GPA 85</span></a><a href="/offer_2"><b>南洋理工大学应用人工智能硕士</b><span>GPA 85</span></a>',
    "https://www.hksg.org",
    { hosts: ["www.hksg.org"], detailRegexes: ["/offer_\\d+$"] },
    { id: "ntu-master-of-science-integrated-circuit-design", institutionId: "ntu", nameEn: "Master of Science (Integrated Circuit Design)", nameZh: "Master of Science (Integrated Circuit Design)", aliases: ["集成电路设计理学硕士", "集成电路设计"] },
    "detail"
  ),
  ["https://www.hksg.org/offer_1"],
  "HKSg entry pages must keep only detail cards whose programme title matches"
);
assert.deepEqual(
  parseHksgLinkCandidates(
    '<title>南洋理工大学集成电路设计理学硕士</title><a href="/offer_21282"><span class="offer-card"></span></a>',
    "https://www.hksg.org/major_208",
    { hosts: ["www.hksg.org"], detailRegexes: ["/offer_\\d+$"] },
    { id: "ntu-master-of-science-integrated-circuit-design", institutionId: "ntu", nameEn: "Master of Science (Integrated Circuit Design)", nameZh: "Master of Science (Integrated Circuit Design)", aliases: ["集成电路设计理学硕士", "集成电路设计"] },
    "detail"
  ),
  ["https://www.hksg.org/offer_21282"],
  "HKSg icon-only offer cards must inherit programme context from the major page"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南洋理工大学", major_name: "通信工程理学硕士" },
    { id: "ntu-communications", institutionId: "ntu", nameEn: "MSc in Communications Engineering", nameZh: "通信工程理学硕士", aliases: [] }
  ).decision,
  "pass",
  "HKSg communication records must match the explicit NTU programme"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南安普顿大学", major_name: "网络安全硕士" },
    { id: "ntu-master-of-science-cyber-security", institutionId: "ntu", nameEn: "Master of Science (Cyber Security)", nameZh: "Master of Science (Cyber Security)", aliases: [] }
  ).decision,
  "skip",
  "A matching major at another university must not enter the NTU queue"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南洋理工大学", major_name: "应用人工智能计算机硕士" },
    { id: "ntu-master-of-science-cyber-security", institutionId: "ntu", nameEn: "Master of Science (Cyber Security)", nameZh: "Master of Science (Cyber Security)", aliases: [] }
  ).decision,
  "skip",
  "A different NTU programme must not enter the cybersecurity queue"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "The Chinese University of Hong Kong", major_name: "Artificial Intelligence and Robotics", enroll: "offer" },
    { id: "cuhk-msc-in-artificial-intelligence", institutionId: "cuhk", nameEn: "MSc in Artificial Intelligence", nameZh: "MSc in Artificial Intelligence", aliases: [], discoveryTerms: { short: ["Artificial Intelligence"], focus: ["Artificial Intelligence"] } },
    { allowDirectionOnly: true }
  ).decision,
  "skip",
  "A composite sibling programme must not enter the direction-only AI queue"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "The Chinese University of Hong Kong", major_name: "Data Science" },
    { id: "cuhk-msc-in-data-science-and-business-statistics", institutionId: "cuhk", nameEn: "MSc in Data Science and Business Statistics", nameZh: "MSc in Data Science and Business Statistics", aliases: [], strictMatchTerms: ["Data Science and Business Statistics"] }
  ).decision,
  "skip",
  "HKSg generic Data Science must not match CUHK Data Science and Business Statistics"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "The Chinese University of Hong Kong", major_name: "Data Science and Business Statistics" },
    { id: "cuhk-msc-in-data-science-and-business-statistics", institutionId: "cuhk", nameEn: "MSc in Data Science and Business Statistics", nameZh: "MSc in Data Science and Business Statistics", aliases: [], strictMatchTerms: ["Data Science and Business Statistics"] }
  ).decision,
  "pass",
  "HKSg explicit Data Science and Business Statistics must match the target programme"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南洋理工大学", major_name: "信号处理与机器学习理学硕士" },
    { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", nameZh: "Master of Science (Signal Processing)", aliases: [] }
  ).decision,
  "skip",
  "The legacy signal-processing target must not absorb the machine-learning programme"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南洋理工大学", major_name: "信号处理与机器学习理学硕士" },
    { id: "ntu-master-of-science-signal-processing-machine-learning", institutionId: "ntu", nameEn: "Master of Science (Signal Processing & Machine Learning)", nameZh: "Master of Science (Signal Processing & Machine Learning)", aliases: [] }
  ).decision,
  "pass",
  "The machine-learning programme must retain its own records"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "南洋理工大学", major_name: "通信工程理学硕士", title: "南洋理工大学信号处理硕士研究生offer" },
    { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", nameZh: "Master of Science (Signal Processing)", aliases: [] }
  ).decision,
  "skip",
  "A search-title keyword must not override a conflicting explicit HKSg major"
);
assert.equal(
  resolveHksgIndexedProgramme(
    { university_name: "香港大学", major_name: "STEM 教育硕士" }
  ),
  null,
  "HKSg exact programme resolver must not use fuzzy cross-discipline matching"
);
assert.equal(
  resolveHksgIndexedProgramme(
    { university_name: "香港大学", major_name: "电气与电子工程理学硕士（通用方向）" }
  )?.id,
  "hku-eee",
  "HKSg exact programme resolver must retain a clear programme alias"
);
assert.equal(
  resolveHksgIndexedProgramme(
    { university_name: "南洋理工大学", major_name: "信号处理与机器学习理学硕士" }
  )?.id,
  "ntu-master-of-science-signal-processing-machine-learning",
  "HKSg resolver must use maintained source aliases for renamed programmes"
);
assert.equal(
  resolveHksgIndexedProgramme({
    university_name: "\u9999\u6e2f\u4e2d\u6587\u5927\u5b66",
    major_name: "\u7edf\u8ba1\u4e0e\u6570\u636e\u79d1\u5b66\u9ad8\u7ea7\u7814\u7a76\u7406\u5b66\u7855\u58eb"
  })?.id,
  "cuhk-msc-in-advanced-studies-in-statistics-and-data-science",
  "HKSg resolver must consume generated high-confidence programme aliases"
);
assert.equal(
  anchoredProgrammeId(
    { targetUniversity: "南洋理工大学", targetProgramme: "信号处理与机器学习理学硕士" },
    ["ntu-master-of-science-signal-processing"],
    { decision: "pass" },
    "hksg-public-cases"
  ),
  null,
  "A more specific HKSg programme title must not be anchored to the legacy programme"
);
assert.equal(
  anchoredProgrammeId(
    { targetUniversity: "南洋理工大学", targetProgramme: "信号处理理学硕士" },
    ["ntu-master-of-science-signal-processing"],
    { decision: "pass" },
    "hksg-public-cases"
  ),
  "ntu-master-of-science-signal-processing",
  "An explicit HKSg programme title may anchor to the requested programme"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "香港大学", major_name: "计算机科学硕士（通用方向）", title: "香港大学计算机科学(网络安全)硕士录取一枚" },
    { id: "hku-master-of-science-in-computer-science-cyber-security-stream", institutionId: "hku", nameEn: "MSc Computer Science (Cyber Security Stream)", nameZh: "计算机科学硕士（网络安全方向）", aliases: [] }
  ).decision,
  "pass",
  "A source title can identify a cybersecurity stream when its major field is generic"
);
assert.equal(
  scoreHksgIndexedCaseForProgramme(
    { university_name: "香港城市大学", major_name: "数据科学理学硕士", title: "香港城市大学数据科学硕士研究生offer" },
    { id: "cityu-hk-msc-cybersecurity", institutionId: "cityu-hk", nameEn: "MSc Cybersecurity", nameZh: "理學碩士(網絡安全)", aliases: [] }
  ).decision,
  "skip",
  "A CityU data-science record must not enter the CityU cybersecurity queue"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal: { targetApproved: 5, pagesAttempted: 0, maxPages: 5, apiCalls: 0, maxApiCalls: 5, errors: 0, maxErrors: 2 },
    sourceCandidates: [
      { url: "https://www.hksg.org/major_9160", kind: "seed" },
      { url: "https://m.hksg.org/offer_21282", kind: "detail" }
    ]
  }),
  { action: "collect", url: "https://m.hksg.org/offer_21282", kind: "detail" },
  "Detail cases must be collected before spending the page budget on entry pages"
);

const candidate = normalizeCandidate({
  targetUniversity: "香港中文大学",
  targetProgramme: "电子工程理学硕士",
  offerYear: 2026,
  undergraduateUniversity: "中国矿业大学",
  undergraduateMajor: "自动化",
  gpaRaw: "3.6 / 4.0",
  gpaScale: "GPA_4",
  languageTest: "IELTS",
  languageScale: "IELTS_9",
  languageScore: 7,
  internships: ["自动化实习"],
  projects: ["PLC控制项目"]
}, "https://www.example.com/offer/1");

assert.equal(candidate.gpa100, null, "Four-point GPA must not be linearly converted into a fake percentage");
assert.equal(candidate.gpaScale, "GPA_4", "Original GPA scale must be retained");
assert.equal(candidate.reviewStatus, "pending", "A structurally valid extracted case must still await human approval");
assert.equal(candidate.completenessScore, 100, "The score measures field completeness, not factual accuracy");
assert.deepEqual(candidate.projects, ["PLC控制项目"], "Course and personal projects must not be forced into research");

const toeflCandidate = normalizeCandidate({
  targetUniversity: "香港科技大学",
  targetProgramme: "电子工程",
  offerYear: 2026,
  undergraduateUniversity: "中国矿业大学",
  gpaRaw: "85 / 100",
  languageTest: "TOEFL",
  languageScore: 95,
  research: ["信号处理科研"]
}, "https://www.example.com/offer/2");
assert.equal(toeflCandidate.languageScale, "TOEFL_IBT_120", "TOEFL 95 should be recognized as the 120-point iBT scale");
assert.equal(toeflCandidate.reviewStatus, "pending", "A valid TOEFL case should pass structural validation but still await review");
const chineseIeltsCandidate = normalizeCandidate({
  targetUniversity: "香港中文大学", targetProgramme: "电子工程理学硕士", offerYear: 2026,
  undergraduateUniversity: "中国矿业大学", gpaRaw: "85/100", languageTest: "雅思", languageScore: 7
}, "https://www.example.com/offer/zh-language");
assert.equal(chineseIeltsCandidate.languageTest, "IELTS", "Chinese IELTS labels must normalize to the canonical test name");

const anonymousCandidate = normalizeCandidate({
  targetUniversity: "\u9999\u6e2f\u79d1\u6280\u5927\u5b66",
  targetProgramme: "MSc in Big Data Technology",
  targetProgrammeEnglishRaw: "MSc in Big Data Technology",
  offerYear: 2026,
  undergraduateUniversity: "985\u9662\u6821",
  undergraduateMajor: "\u8ba1\u7b97\u673a\u79d1\u5b66\u4e0e\u6280\u672f",
  gpaRaw: "87+",
  gpaScale: "UNKNOWN",
  languageTest: "TOEFL",
  languageScale: "TOEFL_IBT_6",
  languageScore: 101
}, "https://www.51liuxue.com/c/2.shtml");
assert.equal(anonymousCandidate.targetProgrammeId, "hkust-bdt");
assert.equal(anonymousCandidate.undergraduateInstitutionId, "anonymous-985");
assert.equal(anonymousCandidate.languageScale, "TOEFL_IBT_120");
assert.equal(anonymousCandidate.gpaScale, "UNKNOWN", "Inferred GPA scale must not overwrite the raw source scale");
assert.deepEqual(
  anonymousCandidate.sourceEvidence.inferred.gpaScale,
  { value: "PERCENT_100", confidence: "medium", basis: "score-range-only" }
);
assert.equal(anonymousCandidate.completenessScore, 100, "Undisclosed soft background must not reduce field completeness");
assert.equal(inferOfferYear("\u4ee5\u4e0a\u5747\u4e3a2026\u7533\u8bf7\u5b63\u6848\u4f8b"), 2026);
assert.equal(inferOfferYear("Commencement of Study: 1 September 2026"), 2026);
assert.equal(inferOfferYear("Copyright 2017-2026"), null);
assert.equal(inferCriticalOfferYear("Offer year\n2026\nGPA 87+\nTOEFL 101"), 2026, "Dedicated OCR output may contain a bare but unique recent year");
assert.equal(inferCriticalOfferYear("2025\n2026"), null, "Ambiguous OCR years must not be guessed");
assert.deepEqual(criticalVerificationReasons({ offerYear: 2020, gpaRaw: "87+", languageTest: "TOEFL", languageScore: 101 }), [], "Older valid cases are weighted down later, not rejected here");
const correctedCritical = applyCriticalVerification(
  { offerYear: null, gpaRaw: "87+", languageTest: "TOEFL", languageScore: 101 },
  "GPA 87+ TOEFL 101\nCommencement of Study: 1 September 2026",
  { model: "qwen3.5-ocr" }
);
assert.equal(correctedCritical.candidate.offerYear, 2026, "Independent OCR should correct an implausible primary year");
assert.equal(correctedCritical.verification.status, "corrected");
assert.equal(correctedCritical.verification.model, "qwen3.5-ocr");
const conflictingCritical = applyCriticalVerification(
  { offerYear: 2020, gpaRaw: "87+", languageTest: "TOEFL", languageScore: 101 },
  "Commencement of Study: 1 September 2020",
  { model: "qwen3.5-ocr" }
);
assert.equal(conflictingCritical.verification.status, "conflict", "Unresolved critical fields must be isolated for review");
const formattedCritical = applyCriticalVerification(
  { offerYear: 2025, gpaRaw: "GPA 85+", languageTest: "IELTS", languageScore: 6.5 },
  "average 85 IELTS 6 . 5",
  { model: "qwen3.5-ocr" }
);
assert.equal(formattedCritical.verification.status, "verified", "OCR field verification must tolerate equivalent score formatting");
assert.match(
  normalizeOcrResponseText('{"rawText":"NUS offer","fields":{"gpaRaw":"3.66/4.0","offerYear":2024}}'),
  /\[OCR_FIELDS\][\s\S]*gpaRaw: 3\.66\/4\.0[\s\S]*offerYear: 2024/,
  "Structured OCR responses must remain searchable after normalization"
);
assert.match(
  normalizeOcrResponseText('[{"rawText":"2025 NUS offer 本3.6/4.0 IELTS 7.5","fields":{"gpaRaw":null,"offerYear":null}}]'),
  /\[OCR_FIELDS\][\s\S]*gpaRaw: 3\.6\/4\.0[\s\S]*offerYear: 2025[\s\S]*languageTest: IELTS[\s\S]*languageScore: 7\.5/,
  "OCR arrays with empty model fields must still receive deterministic field recovery"
);
assert.equal(inferGpaScale({ gpaRaw: "3.8", gpaScale: "UNKNOWN" }), null);
assert.deepEqual(
  filterCandidatesForProgramme([
    { targetProgrammeId: "ntu-electronics" },
    { targetProgrammeId: "ntu-cca" },
    { targetProgrammeId: null }
  ], "ntu-electronics"),
  [{ targetProgrammeId: "ntu-electronics" }],
  "Programme-scoped Agent runs must not store unrelated cases from a mixed source page"
);
assert.deepEqual(
  filterCandidatesForProgrammes([
    { targetProgrammeId: "cityu-eie" },
    { targetProgrammeId: "polyu-eie" },
    { targetProgrammeId: "ntu-power" },
    { targetProgrammeId: null }
  ], ["cityu-eie", "polyu-eie"]),
  [{ targetProgrammeId: "cityu-eie" }, { targetProgrammeId: "polyu-eie" }],
  "A merged URL must retain only cases belonging to its requested programmes"
);
assert.deepEqual(
  candidatesForQueue([
    { targetInstitutionId: "polyu-hk", targetProgrammeId: "polyu-eie" },
    { targetInstitutionId: "polyu-hk", targetProgrammeId: null },
    { targetInstitutionId: "polyu-hk", targetProgrammeId: "polyu-ee" },
    { targetInstitutionId: "manchester", targetProgrammeId: null }
  ], ["polyu-eie"]),
  [
    { targetInstitutionId: "polyu-hk", targetProgrammeId: "polyu-eie" },
    { targetInstitutionId: "polyu-hk", targetProgrammeId: null }
  ],
  "An unmatched case from the requested university must be preserved for later programme routing"
);
assert.deepEqual(
  discoverLinks(
    '<a href="/webwyjbinfo/196">case</a><a href="/p/196">article</a>',
    "https://www.51liuxue.com/alfx",
    { hosts: ["www.51liuxue.com"], detailRegexes: ["/webwyjbinfo/\\d+$"] }
  ),
  ["https://www.51liuxue.com/webwyjbinfo/196"],
  "51liuxue case-detail URLs must be discoverable"
);
assert.deepEqual(
  discoverLinks(
    '<a href="/blog/case_7936056.shtml">case</a><a href="/blog/author/case/123.shtml">nested</a>',
    "https://liuxue.xdf.cn/blog/",
    { hosts: ["liuxue.xdf.cn"], detailRegexes: ["/blog/(?:case_\\d+|[^/]+/case/\\d+)\\.shtml$"] }
  ),
  ["https://liuxue.xdf.cn/blog/case_7936056.shtml", "https://liuxue.xdf.cn/blog/author/case/123.shtml"],
  "XDF case-detail URL variants must be discoverable"
);
assert.deepEqual(
  discoverEntryLinks(
    '<a href="/major_9160">programme</a><a href="/major_9160/2">page</a><a href="/offer_21282">case</a>',
    "https://www.hksg.org/major_9160",
    { hosts: ["www.hksg.org"], entryRegexes: ["/major_\\d+(?:/\\d+)?$"] }
  ),
  ["https://www.hksg.org/major_9160", "https://www.hksg.org/major_9160/2"],
  "Programme entry pages must be discoverable separately from case-detail pages"
);

const structuredCandidate = normalizeCandidate({
  targetUniversity: "香港中文大学",
  targetProgramme: "电子工程理学硕士",
  offerYear: 2026,
  undergraduateUniversity: "某大学",
  gpaRaw: "3.8",
  gpaScale: "UNKNOWN",
  languageTest: "IELTS",
  languageScale: "IELTS_9",
  languageScore: 7,
  auxiliaryScores: [{ test: "CET6", scoreRaw: "573" }],
  experiences: [
    { raw: "某公司算法实习生", category: "internship" },
    { raw: "全国大学生数学建模竞赛", category: "competition" },
    { raw: "一种控制方法专利", category: "patent" }
  ]
}, "https://www.example.com/offer/3");
assert.deepEqual(structuredCandidate.internships, ["某公司算法实习生"]);
assert.deepEqual(structuredCandidate.competitions, ["全国大学生数学建模竞赛"]);
assert.deepEqual(structuredCandidate.patents, ["一种控制方法专利"]);
assert.deepEqual(structuredCandidate.auxiliaryScores, [{ test: "CET6", scoreRaw: "573" }]);

assert.equal(robotsAllowsText("User-agent: *\nDisallow: /private\nAllow: /private/public", "/private/item"), false);
assert.equal(robotsAllowsText("User-agent: *\nDisallow: /private\nAllow: /private/public", "/private/public/1"), true);

const sourceEvidence = verifyCandidateAgainstText(
  { targetUniversity: "香港中文大学", undergraduateUniversity: "南京大学", gpaRaw: "4.02" },
  "香港中文大学录取案例，本科南京大学，GPA 4.02"
);
assert.deepEqual(sourceEvidence.missing, []);
assert.deepEqual(
  verifyCandidateAgainstText(
    { targetProgramme: "大数据科技理学硕士", targetProgrammeEnglishRaw: "MSc in Big Data Technology" },
    "MSc in Big Data Technology"
  ).missing,
  [],
  "A formal English programme name must verify the normalized Chinese programme record"
);
assert.deepEqual(verifyCandidateAgainstText({ undergraduateUniversity: "虚构大学" }, "本科南京大学").missing, ["undergraduateUniversity"]);
assert.deepEqual(verifyCandidateAgainstText({ offerYear: 2026 }, "页面发布于2026年").missing, []);
assert.deepEqual(verifyCandidateAgainstText({ offerYear: 2023 }, "页面发布于2026年").missing, ["offerYear"]);
assert.equal(
  verifyCandidateAgainstText({ targetUniversity: "香港城市大学", targetProgramme: "商业及数据分析理学硕士（信息分析管理方向）", targetProgrammeId: "cityu-business-data-analytics" }, "香港城市大学商业与数据分析硕士录取案例").matched.targetProgramme,
  true,
  "Programme evidence may use a canonical alias instead of the model's direction suffix"
);

const goal = { targetApproved: 10, maxPages: 5, maxApiCalls: 5, maxErrors: 2, pagesAttempted: 0, apiCalls: 0, errors: 0 };
assert.deepEqual(
  buildSourceCandidates(
    { caseSourceUrls: ["https://primary.example/case", "https://primary.example/case"] },
    [{ id: "fallback", fallbackUrls: ["https://fallback.example/case"] }]
  ),
  [
    { url: "https://primary.example/case", sourceId: null, priority: 0, kind: "detail" },
    { url: "https://fallback.example/case", sourceId: "fallback", priority: 1, kind: "detail", discoveredBy: "configured-source" }
  ],
  "Agent must deduplicate primary and fallback sources while preserving priority"
);
assert.deepEqual(
  buildSourceCandidates(
    { caseSourceUrls: [] },
    [{ id: "seed-source", seedUrls: ["https://seed.example/cases"] }]
  ),
  [{ url: "https://seed.example/cases", sourceId: "seed-source", priority: 2, kind: "seed", discoveredBy: "configured-source" }],
  "Agent must include configured seed pages as discovery actions"
);
assert.equal(isCoreEngineeringProgramme({ nameEn: "MSc in Computer Science", focusTags: ["computer"] }), true);
assert.equal(isCoreEngineeringProgramme({ nameEn: "MSc in Business Analytics", focusTags: ["data", "business"] }), false);
assert.equal(isCoreEngineeringProgramme({ nameEn: "MSc in Engineering Management", focusTags: ["business"] }), false);
const now = Date.parse("2026-08-14T00:00:00.000Z");
assert.equal(crawlSourceNeedsAttempt(null, "test-programme", now), true);
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: "test-programme", extracted_count: 1, scoped_count: 1, last_checked_at: "2026-08-01T00:00:00.000Z" }, "test-programme", now), false);
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: "other-programme", extracted_count: 2, last_checked_at: "2026-08-01T00:00:00.000Z" }, "test-programme", now), true, "A source extracted for another programme must be rechecked in the current programme scope");
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: null, extracted_count: 2, last_checked_at: "2026-08-01T00:00:00.000Z" }, "test-programme", now), true, "An unscoped extracted source must be checked in the current programme scope");
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: "test-programme", extracted_count: 1, scoped_count: 0, last_checked_at: "2026-07-31T00:00:00.000Z" }, "test-programme", now), true, "An extracted but unmatched source must be rechecked");
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: "test-programme", extracted_count: 0, last_checked_at: "2026-08-13T00:00:00.000Z" }, "test-programme", now), false);
assert.equal(crawlSourceNeedsAttempt({ status: "completed", programme_id: "other-programme", extracted_count: 0, last_checked_at: "2026-08-13T00:00:00.000Z" }, "test-programme", now), true);
const searchSource = { hosts: ["www.example.com"], detailRegexes: ["/case/\\d+$"] };
assert.equal(buildCaseSearchQuery({ nameEn: "MSc in Computer Science", aliases: [] }, searchSource).includes("site:www.example.com"), true);
assert.deepEqual(
  parseSearchResultUrls('<a href="https://www.example.com/case/1">ok</a><a href="https://www.example.com/programme">no</a><a href="https://evil.example.com/case/2">no</a>', searchSource),
  ["https://www.example.com/case/1"],
  "Search discovery must keep only whitelisted detail URLs"
);
assert.deepEqual(
  parseSearchResultUrls(String.raw`<div>https:\/\/www.example.com\/case\/7</div>`, searchSource),
  ["https://www.example.com/case/7"],
  "Search discovery must recover escaped same-host detail URLs"
);
const scoredSearchCandidate = scoreSearchCandidate(
  { url: "https://www.example.com/case/8", kind: "detail", anchorText: "NTU Master of Science Signal Processing admission offer" },
  { institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", aliases: [], strictMatchTerms: ["Signal Processing"], discoveryTerms: { focus: ["Signal Processing"] } },
  searchSource
);
assert.equal(scoredSearchCandidate.accepted, true, "Exact programme text should pass candidate scoring");
assert.ok(scoredSearchCandidate.score >= 15, "Exact programme candidates should outrank generic detail URLs");
assert.equal(allocateSearchSourceLimit(10, 16, 4), 4, "Search budget must reserve enough queries for each selected source");
assert.equal(allocateSearchSourceLimit(10, 3, 4), 1, "A tiny search budget must still probe one source");
assert.equal(allocateSearchSourceRotationLimit(10, 16, 14), 10, "A normal budget should rotate across all configured sources");
assert.equal(allocateSearchSourceRotationLimit(10, 3, 14), 3, "Rotation must never exceed the request budget");
assert.deepEqual(
  scoreMastermateIndexedCaseForProgramme(
    { enroll: "offer", university: { name: "Nanyang Technological University" }, major_name: "signal processing master", major_ename: "Master of Science (Signal Processing)" },
    { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", nameZh: "信号处理", aliases: ["信号处理"] }
  ).decision,
  "pass",
  "Mastermate index rows must be scoped by institution and programme"
);
const mastermateCalls = [];
const mastermateSource = {
  id: "mastermate-public-cases",
  search: { kind: "mastermate-api", baseUrl: "https://www.mastermate.cn", admissionPath: "/admission", apiPath: "/mm_api/admission", districtIds: [1, 4] }
};
const mastermateDiscovery = await discoverMastermateCaseCandidates(
  { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", nameZh: "信号处理", aliases: ["信号处理"] },
  mastermateSource,
  {
    maxResults: 5,
    maxRequests: 1,
    searchPlan: { queryTerms: ["信号处理"] },
    fetchImpl: async (url, init = {}) => {
      mastermateCalls.push({ url: String(url), init });
      if (String(url).endsWith("/admission")) return { ok: true, text: async () => '<meta name="csrf-token" content="test-token">', headers: { getSetCookie: () => ["session=test; Path=/"] } };
      return { ok: true, json: async () => ({ data: [{ id: 42, enroll: "offer", university: { name: "Nanyang Technological University" }, major_name: "signal processing master", major_ename: "Master of Science (Signal Processing)" }] }) };
    }
  }
);
assert.deepEqual(mastermateDiscovery.urls, ["https://www.mastermate.cn/admission/42"]);
assert.equal(mastermateDiscovery.attempts[0].matched, 1);
assert.equal(mastermateCalls.length, 2, "Mastermate discovery must initialize once and query once");
assert.equal(mastermateCalls[1].init.headers["Content-Type"], "application/json");
assert.deepEqual(JSON.parse(mastermateCalls[1].init.body), { words: "信号处理", district_id: 1, rank_id: 0 });
const pagedMastermateDiscovery = await discoverMastermateCaseCandidates(
  { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Master of Science (Signal Processing)", nameZh: "信号处理", aliases: [] },
  { ...mastermateSource, search: { ...mastermateSource.search, districtIds: [1] } },
  {
    maxResults: 5,
    maxRequests: 2,
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/admission")) return { ok: true, text: async () => '<meta name="csrf-token" content="test-token">', headers: { getSetCookie: () => [] } };
      const page = new URL(url).searchParams.get("page");
      const row = id => ({ id, enroll: "offer", university: { name: "Nanyang Technological University" }, major_name: "信号处理", major_ename: "Master of Science (Signal Processing)" });
      return { ok: true, json: async () => ({ data: [row(page === "1" ? 51 : 52)], next_page_url: page === "1" ? "https://www.mastermate.cn/mm_api/admission?page=2" : null }) };
    }
  }
);
assert.deepEqual(
  pagedMastermateDiscovery.urls,
  ["https://www.mastermate.cn/admission/51", "https://www.mastermate.cn/admission/52"],
  "Mastermate discovery must follow a result page when it contains a target match"
);
const sparsePagedMastermateDiscovery = await discoverMastermateCaseCandidates(
  { id: "ntu-master-of-science-signal-processing", institutionId: "ntu", nameEn: "Signal Processing", nameZh: "Signal Processing", aliases: [] },
  { ...mastermateSource, search: { ...mastermateSource.search, districtIds: [1] } },
  {
    maxResults: 5,
    maxRequests: 2,
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/admission")) return { ok: true, text: async () => '<meta name="csrf-token" content="test-token">', headers: { getSetCookie: () => [] } };
      const page = new URL(url).searchParams.get("page");
      const row = page === "1"
        ? { id: 61, enroll: "offer", university: { name: "Nanyang Technological University" }, major_name: "Computer Science", major_ename: "Master of Computer Science" }
        : { id: 62, enroll: "offer", university: { name: "Nanyang Technological University" }, major_name: "Signal Processing", major_ename: "Master of Science (Signal Processing)" };
      return { ok: true, json: async () => ({ data: [row], next_page_url: page === "1" ? "https://www.mastermate.cn/mm_api/admission?page=2" : null }) };
    }
  }
);
assert.deepEqual(
  sparsePagedMastermateDiscovery.urls,
  ["https://www.mastermate.cn/admission/62"],
  "Mastermate discovery must continue through a populated page with no current-page match"
);
const mastermateBudgetBodies = [];
await discoverMastermateCaseCandidates(
  { id: "test-master", institutionId: "ntu", nameEn: "Signal Processing", nameZh: "信号处理", aliases: [] },
  { ...mastermateSource, search: { ...mastermateSource.search, districtIds: [1, 4] } },
  {
    maxResults: 5,
    maxRequests: 3,
    searchPlan: { queryTerms: ["中文规划", "English Plan"] },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/admission")) return { ok: true, text: async () => '<meta name="csrf-token" content="test-token">', headers: { getSetCookie: () => [] } };
      mastermateBudgetBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ data: [] }) };
    }
  }
);
assert.deepEqual(
  mastermateBudgetBodies.map(body => body.district_id),
  [1, 4, 4],
  "Mastermate small budgets must rotate districts while covering interleaved query terms"
);
assert.deepEqual(
  mastermateBudgetBodies.map(body => body.words),
  ["信号处理", "Signal Processing", "中文规划"],
  "Mastermate must spend its first requests on deterministic programme terms before planner fallbacks"
);
assert.equal(
  new Set(mastermateBudgetBodies.map(body => body.words)).size,
  3,
  "Mastermate small budgets must use distinct terms before repeating a term in another district"
);
const compassSource = {
  id: "compassedu-public-cases",
  hosts: ["www.compassedu.hk"],
  entryRegexes: ["/offers_\\d+$"],
  detailRegexes: ["/newst_\\d+$"],
  search: { kind: "compass-index", baseUrl: "https://www.compassedu.hk", indexPath: "/offers" }
};
const compassProgramme = {
  id: "cuhk-ee",
  institutionId: "cuhk",
  nameEn: "MSc in Electronic Engineering",
  nameZh: "Electronic Engineering",
  aliases: ["电子工程理学硕士"],
  strictMatchTerms: ["Electronic Engineering", "电子工程"]
};
const compassIndexHtml = '<a href="//www.compassedu.hk/offers_1727">2026 The Chinese University of Hong Kong Electronic Engineering MSc admission cases</a><a href="//www.compassedu.hk/offers_1729">2026 The Chinese University of Hong Kong Mechanical and Automation Engineering MSc admission cases</a>';
assert.deepEqual(
  parseCompassIndexCandidates(compassIndexHtml, "https://www.compassedu.hk/offers", compassSource, compassProgramme).map(candidate => candidate.url),
  ["https://www.compassedu.hk/offers_1727"],
  "Compass index discovery must keep only the target programme category"
);
const compassDetailHtml = '<a href="/newst_1">2026 The Chinese University of Hong Kong Mechanical and Automation Engineering MSc offer</a><a href="/newst_2">2026 The Chinese University of Hong Kong Electronic Engineering MSc offer GPA 4.02</a>';
assert.deepEqual(
  parseCompassDetailCandidates(compassDetailHtml, "https://www.compassedu.hk/offers_1727", compassSource, compassProgramme).map(candidate => candidate.url),
  ["https://www.compassedu.hk/newst_2", "https://www.compassedu.hk/newst_1"],
  "Compass category expansion must prioritize detail links naming the target programme"
);
const compassDiscovery = await discoverCompassCaseCandidates(compassProgramme, compassSource, {
  fetchImpl: async () => ({ ok: true, text: async () => compassIndexHtml }),
  maxRequests: 1
});
assert.deepEqual(compassDiscovery.entryUrls, ["https://www.compassedu.hk/offers_1727"]);
assert.deepEqual(
  validateSearchPlan({ queryTerms: ["Joint NTU-TUM IC Design", "site:example.com bad", "南洋理工大学 集成电路设计"] }),
  { queryTerms: ["Joint NTU-TUM IC Design", "南洋理工大学 集成电路设计"] },
  "Search planner output must remain a small list of safe search terms"
);
const searchPlannerRequest = buildSearchPlannerRequest(
  { id: "ntu-ic", institutionId: "ntu", nameEn: "Integrated Circuit Design", aliases: [], focusTags: ["integrated-circuit"] },
  [{ id: "mastermate", hosts: ["www.mastermate.cn"] }],
  "test-search-model"
);
assert.equal(searchPlannerRequest.model, "test-search-model");
assert.match(searchPlannerRequest.messages[0].content, /queryTerms/);
assert.ok(searchQueryVariants(
  { nameEn: "Integrated Circuit Design", aliases: [], focusTags: ["integrated-circuit"] },
  searchSource,
  { queryTerms: ["Joint NTU-TUM IC Design"] }
).some(query => query.includes("Joint NTU-TUM IC Design")));
const plannerFirstQueries = searchQueryVariants(
  {
    nameEn: "Stored English Programme",
    sourceSearchTerms: { "search-source": { exact: ["Stored English Alias"] } }
  },
  { id: "search-source", hosts: ["www.example.com"], detailRegexes: ["/case/\\d+$"] },
  { queryTerms: ["中文精准项目", "Planner English Alias"] }
);
assert.match(plannerFirstQueries[0], /中文精准项目/);
assert.match(plannerFirstQueries[1], /Planner English Alias/);
assert.ok(plannerFirstQueries.length >= 12, "Search discovery must include expanded query variants");
assert.ok(plannerFirstQueries.some(query => query.includes("GPA")), "Expanded search variants must include case-field signals");
assert.ok(plannerFirstQueries.some(query => query.includes("site:www.example.com Planner English Alias (offer OR admission")), "Search discovery must include an unquoted loose variant");
const searchCalls = [];
await (async () => {
  const result = await (await import("./agent.mjs")).discoverCaseUrlsBySearch(
    { institutionId: "ntu", nameEn: "Master of Science (Cyber Security)", nameZh: "网络安全理学硕士", aliases: ["南洋理工大学网络安全硕士"], focusTags: ["computer", "cybersecurity"] },
    searchSource,
    {
      maxResults: 5,
      maxQueries: 2,
      fetchImpl: async url => {
        searchCalls.push(String(url));
        return { ok: true, text: async () => "" };
      }
    }
  );
  assert.deepEqual(result.urls, [], "An empty search response must not fabricate source URLs");
})();
assert.ok(searchCalls.length <= 8, "Search discovery must cap low-value query attempts");
assert.ok(searchCalls.length <= 2, "Search discovery must honor the caller query budget");
assert.ok(searchCalls.every(url => !url.includes("%3F")), "Search queries must not contain replacement-question marks");
const firstSearchQuery = new URL(searchCalls[0]).searchParams.get("q") || "";
assert.match(firstSearchQuery, /Cyber Security|Cybersecurity/i, "Exact programme terms must lead discovery");
assert.doesNotMatch(firstSearchQuery, /Computer Science|Computing/i, "A neighbouring direction must not lead an exact-project search");
const rankedDiscovery = await (await import("./agent.mjs")).discoverCaseUrlsBySearch(
  { institutionId: "ntu", nameEn: "MSc in Computer Science", aliases: [], focusTags: ["computer"] },
  searchSource,
  {
    maxResults: 2,
    maxQueries: 2,
    fetchImpl: async () => ({ ok: true, text: async () => '<a href="https://www.example.com/case/10">NTU MSc in Computer Science offer</a>' })
  }
);
assert.deepEqual(rankedDiscovery.urls, ["https://www.example.com/case/10"]);
assert.ok(rankedDiscovery.discoveryFunnel.accepted >= 1);
assert.ok(rankedDiscovery.attempts[0].candidates[0].score >= 15);
const seededSource = {
  id: "seeded-cases",
  hosts: ["www.example.com"],
  detailRegexes: ["/case/\\d+$"],
  seedUrls: ["https://www.example.com/cases"]
};
const seededProgramme = {
  institutionId: "ntu",
  nameEn: "MSc in Computer Science",
  aliases: ["Computer Science"]
};
const seededHtml = '<a href="/case/12">NTU MSc in Computer Science offer GPA 3.8</a><a href="/case/13">NTU MSc in Mechanical Engineering offer</a>';
assert.deepEqual(
  parseSeedCaseCandidates(seededHtml, "https://www.example.com/cases", seededSource, seededProgramme).map(candidate => candidate.url),
  ["https://www.example.com/case/12"],
  "Configured source seed pages must keep only target-scoped detail links"
);
assert.equal(
  canonicalizeCandidateUrl("https://www.example.com/case/12?FromRecommandation#top"),
  "https://www.example.com/case/12",
  "Tracking query parameters must not create a second detail URL"
);
assert.deepEqual(
  discoverLinks(
    '<a href="/case/12?FromRecommandation">one</a><a href="/case/12">same</a>',
    "https://www.example.com/cases",
    seededSource
  ),
  ["https://www.example.com/case/12"],
  "Detail links with recommendation tracking must be deduplicated"
);
const seededDiscovery = await discoverSeedCaseCandidates(seededProgramme, seededSource, {
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => seededHtml }),
  maxResults: 5
});
assert.deepEqual(seededDiscovery.urls, ["https://www.example.com/case/12"]);
assert.equal(seededDiscovery.requestCount, 1);
assert.equal(seededDiscovery.discoveredBy, "seed-page");
const institutionOnlySource = {
  id: "institution-scoped-cases",
  hosts: ["www.example.com"],
  detailRegexes: ["/case/\\d+$"],
  acceptInstitutionOnly: true,
  seedUrls: ["https://www.example.com/cases"]
};
assert.deepEqual(
  parseSeedCaseCandidates(
    '<a href="/case/14">2025 NUS offer</a>',
    institutionOnlySource.seedUrls[0],
    institutionOnlySource,
    { institutionId: "nus", nameEn: "Master of Computing" }
  ).map(candidate => candidate.url),
  ["https://www.example.com/case/14"],
  "Institution-scoped case indexes may queue same-school details for final page-level filtering"
);
assert.deepEqual(
  parseSeedCaseCandidates(
    '<a href="/case/15">2025 NUS Electronic Engineering MSc offer</a>',
    institutionOnlySource.seedUrls[0],
    institutionOnlySource,
    { institutionId: "nus", nameEn: "Master of Technology in Software Engineering" }
  ),
  [],
  "Institution-scoped indexes must discard a clearly competing direction"
);
const pagedSource = {
  id: "paged-cases",
  hosts: ["www.example.com"],
  detailRegexes: ["/study/detail-\\d+\\.html$"],
  paginationRegexes: ["/study/case-\\d+-7\\.html$"],
  seedUrls: ["https://www.example.com/study/case-1-7.html"]
};
const pagedSeedCandidates = parseSeedCaseCandidates(
  '<a href="/study/case-2-7.html">2</a><a href="/study/detail-22.html">NTU MSc in Computer Science offer</a>',
  pagedSource.seedUrls[0],
  pagedSource,
  seededProgramme
);
assert.deepEqual(
  pagedSeedCandidates.map(candidate => [candidate.kind, candidate.url]),
  [["detail", "https://www.example.com/study/detail-22.html"], ["seed", "https://www.example.com/study/case-2-7.html"]],
  "Seed discovery must preserve pagination links while separating true detail pages"
);
const plan = buildProgrammeCollectionPlan(
  { id: "test-programme", institutionId: "ntu", nameEn: "MSc in Computer Science", nameZh: "计算机科学", focusTags: ["computer"], caseSourceUrls: ["https://primary.example/case"] },
  [{ id: "fallback", fallbackUrls: ["https://fallback.example/case"] }]
);
assert.deepEqual(plan.sourceCandidates.map(item => item.url), ["https://primary.example/case", "https://fallback.example/case"]);
assert.equal(plan.primarySourceCount, 1, "Collection plan should expose fresh project-specific sources");
assert.equal(plan.sourceCount, 1, "Collection plan should report configured source count");
assert.equal(
  buildSourceCandidates(
    { caseSourceUrls: [] },
    [{ id: "compass", hosts: ["www.compassedu.hk"], detailRegexes: ["/newst_\\d+$"], entryRegexes: ["/offers_\\d+$"], fallbackUrls: ["https://www.compassedu.hk/offers_1728"] }]
  )[0].kind,
  "seed",
  "Configured Compass category fallbacks must trigger link discovery"
);
assert.deepEqual(
  buildSourceCandidates(
    { caseSourceUrls: [] },
    [{ id: "compass", hosts: ["www.compassedu.hk"], detailRegexes: ["/newst_\\d+$"], entryRegexes: ["/offers_\\d+$"], search: { kind: "compass-index" }, fallbackUrls: ["https://www.compassedu.hk/offers_1728"] }]
  ),
  [],
  "Native Compass search must not fall back to stale category pages"
);
assert.deepEqual(
  buildSourceCandidates(
    { caseSourceUrls: [] },
    [{ id: "compass", hosts: ["www.compassedu.hk"], detailRegexes: ["/newst_\\d+$"], entryRegexes: ["/offers_\\d+$"], search: { kind: "compass-index" }, seedUrls: ["https://www.compassedu.hk/offer"] }]
  ),
  [],
  "Native Compass search must not fall back to the generic offer listing"
);
assert.deepEqual(planNextAgentAction({ coverage: { approved: 10, pending: 0 }, goal, sourceUrls: [] }), { action: "stop", reason: "target-satisfied" });
assert.deepEqual(planNextAgentAction({ coverage: { approved: 2, pending: 3 }, goal, sourceUrls: ["https://www.example.com/1"] }), { action: "stop", reason: "awaiting-human-review" });
assert.deepEqual(planNextAgentAction({ coverage: { approved: 2, pending: 0 }, goal, sourceUrls: ["https://www.example.com/1"] }), { action: "collect", url: "https://www.example.com/1" });
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 2, pending: 0 },
    goal,
    sourceCandidates: [{ url: "primary", sourceId: "primary" }, { url: "fallback", sourceId: "fallback" }],
    visitedUrls: ["primary"]
  }),
  { action: "collect", url: "fallback", sourceId: "fallback" },
  "The Agent must select an unvisited fallback source after the primary source"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 2, pending: 0 },
    goal,
    sourceCandidates: [{ url: "seed", sourceId: "seed-source", priority: 2, kind: "seed" }],
    visitedUrls: []
  }),
  { action: "discover-seed", url: "seed", sourceId: "seed-source", kind: "seed" },
  "Seed pages must trigger discovery rather than LLM extraction"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "detail-from-index", sourceId: "paged-source", priority: 0, kind: "detail", discoveredBy: "seed-page" },
      { url: "next-index-page", sourceId: "paged-source", priority: 0, kind: "seed", discoveredBy: "seed-page" }
    ]
  }),
  { action: "collect", url: "detail-from-index", sourceId: "paged-source", kind: "detail" },
  "Visible detail pages must be filtered before spending page budget on pagination"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "configured-detail", kind: "detail", priority: 1, discoveredBy: "configured-source" },
      { url: "hksg-entry", kind: "seed", priority: 0, discoveredBy: "hksg-search" }
    ]
  }),
  { action: "discover-seed", url: "hksg-entry", kind: "seed" },
  "Search-discovered target entry pages must be processed before generic configured URLs"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "hksg-detail", kind: "detail", discoveredBy: "hksg-search" },
      { url: "jjl-detail", kind: "detail", discoveredBy: "seed-page", casePriority: 0 }
    ]
  }),
  { action: "collect", url: "hksg-detail", kind: "detail" },
  "Structured search discoveries must run before broad image-first pagination details"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "configured-detail", kind: "detail", priority: 1, discoveredBy: "configured-source" },
      { url: "mastermate-detail", kind: "detail", priority: 0, discoveredBy: "mastermate-search" }
    ]
  }),
  { action: "collect", url: "mastermate-detail", kind: "detail" },
  "Mastermate API discoveries must be prioritized as search results"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "compass-detail", sourceId: "compass", priority: 0, kind: "detail", discoveredBy: "compass-search" },
      { url: "other-detail", sourceId: "other", priority: 1, kind: "detail", discoveredBy: "configured-source" }
    ],
    visitedUrls: ["compass-seed"]
  }),
  { action: "collect", url: "compass-detail", sourceId: "compass", kind: "detail" },
  "Compass details must remain eligible after opening the Compass index seed"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "configured-fallback-detail", kind: "detail", priority: 1, discoveredBy: "configured-source" },
      { url: "bing-entry", kind: "seed", priority: 0, discoveredBy: "bing" }
    ]
  }),
  { action: "discover-seed", url: "bing-entry", kind: "seed" },
  "Search-discovered entry pages must stay ahead of generic fallback detail pages"
);
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 0, pending: 0 },
    goal,
    sourceCandidates: [
      { url: "configured-fallback-detail", kind: "detail", priority: 1, discoveredBy: "configured-source" },
      { url: "configured-case-index", kind: "seed", priority: 2, discoveredBy: "configured-source" }
    ]
  }),
  { action: "discover-seed", url: "configured-case-index", kind: "seed" },
  "Configured case index pages must be opened before stale configured detail fallbacks"
);
assert.deepEqual(
  planNextAgentAction({ coverage: { approved: 2, pending: 3 }, goal, sourceUrls: ["seed"], stopOnPending: false }),
  { action: "collect", url: "seed" },
  "The Agent can continue source discovery when explicitly allowed despite pending cases"
);
assert.deepEqual(planNextAgentAction({ coverage: { approved: 2, pending: 0 }, goal: { ...goal, pagesAttempted: 5 }, sourceUrls: ["https://www.example.com/1"] }), { action: "stop", reason: "page-budget-reached" });
assert.deepEqual(
  planNextAgentAction({
    coverage: { approved: 2, pending: 0 },
    goal: { ...goal, pagesAttempted: 5, detailAttempts: 1, maxDetailAttempts: 3 },
    sourceCandidates: [{ url: "detail-after-page-budget", kind: "detail" }]
  }),
  { action: "collect", url: "detail-after-page-budget", kind: "detail" },
  "A split budget must keep collecting details after the pagination budget is exhausted"
);

console.log("collector checks passed");
