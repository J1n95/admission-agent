import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkedAt = new Date().toISOString();
const outputPath = resolve(process.argv.find(arg => arg.startsWith("--output="))?.split("=")[1] || "collector/data/programme-catalogue.json");
const headers = { "user-agent": "Mozilla/5.0 AdmissionProgrammeResearchBot/0.1" };
const clean = value => String(value || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
const absolute = (base, path) => new URL(path, base).href;
const masters = name => /^(?:Executive )?(?:Master|MA\b|MSc\b|MEng\b|MBA\b|EMBA\b|LLM\b|MPA\b|MPP\b|MPH\b)/i.test(name)
  && !/Doctor|Postgraduate (?:Diploma|Certificate)|PgD\b|PhD\b|MPhil\b/i.test(name);
const idFor = (institutionId, url, name) => `${institutionId}-${name
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90)}`;

async function html(url, options = {}) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.text();
    } catch (error) {
      failure = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw failure;
}

async function discoverHku() {
  const base = "https://portal.hku.hk";
  const modes = ["629270000", "629270001"];
  const rows = [];
  for (const mode of modes) {
    const url = `${base}/SavedQueryService/Execute/any-faculty-programmes/%25/${mode}/1/10/hkutgp_feefornonlocalstudent/0/1000000`;
    const payload = JSON.parse(await html(url));
    for (const item of payload.data || []) {
      const attrs = item.Attributes || {};
      const name = clean(attrs.hkutgp_name);
      if (!masters(name)) continue;
      const slug = attrs["rootprogramme.hkutgp_name"]?.Value;
      const officialUrl = `${base}/tpg-admissions/programme-details?programme=${slug}&mode=${mode === "629270000" ? 1 : 2}`;
      rows.push({ institutionId: "hku", region: "香港", nameEn: name, nameZh: null, officialCode: clean(attrs.hkutgp_programmenameabbreviation) || null, faculty: clean(item.FormattedValues?.hkutgp_facultyid) || null, officialUrl, catalogueUrl: `${base}/tpg-admissions/programme-listing` });
    }
  }
  return rows;
}

async function discoverCuhk() {
  const base = "https://www.gs.cuhk.edu.hk";
  const source = await html(`${base}/programme-filter`);
  return [...source.matchAll(/<a[^>]+href=["'](\/programmes\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({ url: absolute(base, match[1]), name: clean(match[2]) }))
    .filter(item => masters(item.name))
    .map(item => ({ institutionId: "cuhk", region: "香港", nameEn: item.name, nameZh: null, officialCode: null, faculty: item.url.split("/programmes/")[1]?.split("/")[0] || null, officialUrl: item.url, catalogueUrl: `${base}/programme-filter` }));
}

async function discoverHkust() {
  const base = "https://prog-crs.hkust.edu.hk";
  const params = new URLSearchParams({ token_post: "01fecd2fcde5d34b2bdc682731121f85", is_s: "Y", keyword: "", year: "2026-27" });
  for (const school of ["SSCI", "SENG", "SBM", "SHSS", "IPO"]) params.append("school[]", school);
  for (const degree of ["MENG", "MSC", "MA", "MPM", "MPP", "MBA"]) params.append("degree[]", degree);
  const source = await html(`${base}/pgprog/print_result.php?${params}`, { headers: { referer: `${base}/pgprog/2026-27/`, "x-requested-with": "XMLHttpRequest" } });
  return [...source.matchAll(/<li class="program[^>]*><a href="([^"]+)"[^>]*>[\s\S]*?<div class="program-school">([\s\S]*?)<\/div>[\s\S]*?<div class="program-name">([\s\S]*?)<\/div>[\s\S]*?<div class="program-degree">([\s\S]*?)<\/div>/gi)]
    .map(match => ({ institutionId: "hkust", region: "香港", nameEn: `${clean(match[4])} in ${clean(match[3])}`, nameZh: null, officialCode: clean(match[4]), faculty: clean(match[2]), officialUrl: absolute(base, match[1]), catalogueUrl: `${base}/pgprog/2026-27/` }));
}

async function discoverPolyu() {
  const base = "https://www.polyu.edu.hk";
  const catalogueUrl = `${base}/study/pg/taught-postgraduate/find-your-programmes-tpg`;
  const source = await html(catalogueUrl);
  return [...source.matchAll(/<a class="programme[^>]*" href="([^"]+)">([\s\S]*?)<\/a>/gi)].flatMap(match => {
    const body = match[2];
    const code = clean(body.match(/programmes-code-and-entry-description[^>]*>([\s\S]*?)<\/div>/i)?.[1]).split("|")[0].trim();
    const title = clean(body.match(/<div class="title">([\s\S]*?)<\/div>/i)?.[1]);
    const parts = title.split(" - ").map(clean);
    const award = parts.at(-1) || "";
    const name = parts.slice(0, -2).join(" - ") || parts[0];
    if (!/Master|MA\b|MSc\b|MEng\b|MBA\b|EMBA\b/i.test(`${award} ${title}`) || /Doctor|PgD|Postgraduate Diploma/i.test(`${award} ${title}`)) return [];
    return [{ institutionId: "polyu-hk", region: "香港", nameEn: name, nameZh: null, officialCode: code || null, faculty: null, officialUrl: absolute(base, match[1]), catalogueUrl }];
  });
}

async function discoverCityu() {
  const catalogueUrl = "https://www.cityu.edu.hk/pg/taught-postgraduate-programmes/list";
  let source;
  try {
    source = await html(`https://r.jina.ai/${catalogueUrl}`);
    await writeFile(resolve("collector/data/cityu-programme-list.md"), source, "utf8");
  } catch (error) {
    try { source = await readFile(resolve("collector/data/cityu-programme-list.md"), "utf8"); }
    catch { throw error; }
  }
  return [...source.matchAll(/(?:\*\*([^*]+)\*\*)?\s*(p\d+[a-z]?|P\d+[a-z]?)\[([^\]]+)\]\((https:\/\/www\.cityu\.edu\.hk\/en\/pg\/programme\/program-list\/2026\/[^)]+)\)/g)]
    .map(match => {
      const fullName = clean(match[3]);
      const chineseAt = fullName.search(/[\u3400-\u9fff]/);
      return { institutionId: "cityu-hk", region: "香港", nameEn: clean(chineseAt < 0 ? fullName : fullName.slice(0, chineseAt)), nameZh: chineseAt < 0 ? null : clean(fullName.slice(chineseAt)), officialCode: match[2].toUpperCase(), faculty: clean(match[1]) || null, officialUrl: match[4], catalogueUrl };
    })
    .filter(item => masters(item.nameEn));
}

async function discoverNtu() {
  const catalogueUrl = "https://www.ntu.edu.sg/education/degree-programmes";
  const source = await html(catalogueUrl);
  const start = source.indexOf("The graduate degree programmes as of AY2026");
  const end = source.indexOf("The graduate degree programmes as of AY2024", start);
  if (start < 0 || end < 0) throw new Error("NTU AY2026 coursework table not found");
  return [...source.slice(start, end).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(match => clean(match[1]).replace(/\*$/, "").trim())
    .filter(name => masters(name))
    .map(name => ({ institutionId: "ntu", region: "新加坡", nameEn: name, nameZh: null, officialCode: null, faculty: null, officialUrl: `https://www.ntu.edu.sg/graduate-college/admissions/programme/graduate-programmes?listingKeyword=${encodeURIComponent(name)}`, catalogueUrl }));
}

async function discoverNus() {
  const catalogueUrls = [
    "https://masters.nus.edu.sg/scholarships-financial-assistance/detail/nus-master%27s-degree-by-coursework-tuition-fee-rebate",
    "https://masters.nus.edu.sg/scholarships-financial-assistance/detail/nus-master%27s-by-coursework-enhanced-tuition-fee-rebate"
  ];
  const rows = [];
  for (const [index, catalogueUrl] of catalogueUrls.entries()) {
    let source;
    const cachePath = resolve(`collector/data/nus-programme-list-${index + 1}.md`);
    try {
      source = await html(`https://r.jina.ai/${catalogueUrl}`);
      await writeFile(cachePath, source, "utf8");
    } catch (error) {
      try { source = await readFile(cachePath, "utf8"); }
      catch { throw error; }
    }
    const body = source.slice(source.indexOf("The following is a list"));
    for (const match of body.matchAll(/\[([^\]]*(?:Master|MSc|MBA|Juris Doctor)[^\]]*)\]\((https?:\/\/[^)]+)\)/gi)) {
      const name = clean(match[1]);
      if (!masters(name) && !/^Juris Doctor$/i.test(name)) continue;
      rows.push({ institutionId: "nus", region: "新加坡", nameEn: name, nameZh: null, officialCode: null, faculty: null, officialUrl: match[2], catalogueUrl });
    }
  }
  return rows;
}

async function discoverHkbu() {
  const catalogueUrl = "https://ar.hkbu.edu.hk/tpg-admissions/programmes";
  const source = await html(catalogueUrl);
  return [...source.matchAll(/<p class="programme-blk__title"><a href="([^"]+)">([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      institutionId: "hkbu", region: "香港",
      nameEn: clean(match[2]).replace(/\s*\(Approved Programme[\s\S]*$/i, "").trim(),
      nameZh: null, officialCode: null, faculty: null,
      officialUrl: absolute(catalogueUrl, match[1]), catalogueUrl
    }))
    .filter(item => masters(item.nameEn) && !/^\(Zhuhai/i.test(item.nameEn));
}

async function discoverLingnan() {
  const catalogueUrl = "https://www.ln.edu.hk/sgs/programmes-on-offer";
  const source = await html(catalogueUrl);
  return [...source.matchAll(/Programme Name:<\/span>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/gi)]
    .map(match => ({ institutionId: "lingnan-hk", region: "香港", nameEn: clean(match[2]), nameZh: null,
      officialCode: null, faculty: null, officialUrl: absolute(catalogueUrl, match[1]), catalogueUrl }))
    .filter(item => masters(item.nameEn));
}

async function discoverEduhk() {
  const catalogueUrl = "https://www.eduhk.hk/acadprog/postgrad/index.html";
  let source;
  try { source = await html(catalogueUrl); }
  catch {
    // Official page is intermittently unreachable from the collector host.
    // Keep a local official-page snapshot generated by the discovery workflow.
    source = await readFile(resolve("collector/data/eduhk-programmes-source.txt"), "utf8");
  }
  return [...source.matchAll(/(?:^|\n)\s*((?:Executive )?Master(?: of| in)[^\n\[]+)(?:\s*\[([^\]]+)\])?/gim)]
    .map(match => ({ institutionId: "eduhk", region: "香港", nameEn: clean(match[1]), nameZh: null,
      officialCode: clean(match[2]) || null, faculty: null, officialUrl: catalogueUrl, catalogueUrl }))
    .filter(item => masters(item.nameEn));
}

export async function discoverProgrammes() {
  const sources = ["hku", "cuhk", "hkust", "polyu-hk", "cityu-hk", "ntu", "nus", "hkbu", "lingnan-hk", "eduhk"];
  const settled = await Promise.allSettled([discoverHku(), discoverCuhk(), discoverHkust(), discoverPolyu(), discoverCityu(), discoverNtu(), discoverNus(), discoverHkbu(), discoverLingnan(), discoverEduhk()]);
  const errors = settled.flatMap((result, index) => result.status === "rejected" ? [{ source: sources[index], error: result.reason?.message || String(result.reason) }] : []);
  const programmes = settled.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .map(item => ({ ...item, id: idFor(item.institutionId, item.officialUrl, item.nameEn), checkedAt }))
    .filter((item, index, rows) => rows.findIndex(candidate => candidate.id === item.id) === index)
    .sort((a, b) => a.institutionId.localeCompare(b.institutionId) || a.nameEn.localeCompare(b.nameEn));
  return { checkedAt, scope: "official-taught-masters-catalogue", programmes, errors };
}

async function main() {
  const report = await discoverProgrammes();
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, programmes: report.programmes.length, byInstitution: Object.fromEntries([...new Set(report.programmes.map(item => item.institutionId))].map(id => [id, report.programmes.filter(item => item.institutionId === id).length])), errors: report.errors }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
