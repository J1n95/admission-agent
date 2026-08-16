import { programmes as seededProgrammes, schools as seededSchools } from "./data.mjs";
import { readFileSync } from "node:fs";

const normalizeName = value => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s·•・,，.。()（）\-_/\\'’]/g, "");

const normalizeProgrammeTitle = value => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/master of science|m\.?sc\.?/g, "")
  .replace(/master of arts|\bma\b/g, "")
  .replace(/master of engineering|\bmeng\b/g, "")
  .replace(/\band\b|&/g, "and").replace(/\bin\b/g, "")
  .replace(/programme|program/g, "").replace(/[^a-z0-9]+/g, "");

const uniqueMasterTerms = values => [...new Set(values
  .filter(value => value !== null && value !== undefined)
  .map(value => String(value).replace(/\s+/g, " ").trim())
  .filter(Boolean))];

const institutionExtras = [
  { id: "shanghaitech", nameZh: "上海科技大学", nameEn: "ShanghaiTech University", aliases: ["ShanghaiTech", "Shanghai Tech", "上海科技大学（2+2项目）"], classification: "双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "dlut", nameZh: "大连理工大学", nameEn: "Dalian University of Technology", aliases: ["大连理工大学（盘锦校区）", "大连理工大学(盘锦校区)", "大连理工大学盘锦校区", "Dalian University of Technology Panjin Campus"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "anonymous-985", nameZh: "985\u9662\u6821", nameEn: null, aliases: ["\u67d0985\u9662\u6821", "\u56fd\u5185985", "\u56fd\u5185985\u9662\u6821", "985\u9662\u6821", "985\u9ad8\u6821", "985\u5927\u5b66"], classification: "985 / 211 / \u53cc\u4e00\u6d41", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "anonymous-211", nameZh: "211\u9662\u6821", nameEn: null, aliases: ["\u67d0211\u9662\u6821", "\u56fd\u5185211", "\u56fd\u5185211\u9662\u6821", "211\u9ad8\u6821", "211\u5927\u5b66"], classification: "211 / \u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "anonymous-double-first-class", nameZh: "\u53cc\u4e00\u6d41\u9662\u6821", nameEn: null, aliases: ["\u67d0\u53cc\u4e00\u6d41\u9662\u6821", "\u56fd\u5185\u53cc\u4e00\u6d41", "\u53cc\u4e00\u6d41\u9ad8\u6821", "\u53cc\u4e00\u6d41\u5927\u5b66"], classification: "\u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "anonymous-non-elite", nameZh: "\u53cc\u975e\u9662\u6821", nameEn: null, aliases: ["\u67d0\u53cc\u975e\u9662\u6821", "\u53cc\u975e", "\u53cc\u975e\u4e8c\u672c", "\u53cc\u975e\u4e09\u672c", "\u53cc\u975e\u9ad8\u6821", "\u53cc\u975e\u5927\u5b66"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "anonymous-overseas", nameZh: "\u6d77\u5916\u9662\u6821", nameEn: null, aliases: ["\u67d0\u6d77\u5916\u9662\u6821", "\u6d77\u672c\u9662\u6821", "\u6d77\u5916\u672c\u79d1\u9662\u6821", "\u52a0\u62ff\u5927\u672c\u79d1", "\u6fb3\u6d32\u672c\u79d1", "\u82f1\u56fd\u672c\u79d1", "\u7f8e\u56fd\u672c\u79d1", "\u56fd\u5916\u672c\u79d1", "\u52a0\u672c", "\u6fb3\u672c", "\u82f1\u672c", "\u7f8e\u672c", "\u6e2f\u672c", "\u65b0\u672c"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6d77\u5916" },
  { id: "hit", nameZh: "\u54c8\u5c14\u6ee8\u5de5\u4e1a\u5927\u5b66", nameEn: "Harbin Institute of Technology", aliases: ["HIT", "\u54c8\u5c14\u6ee8\u5de5\u4e1a\u5927\u5b66\uff08\u5a01\u6d77\uff09", "\u54c8\u5c14\u6ee8\u5de5\u4e1a\u5927\u5b66\u5a01\u6d77", "Harbin Institute of Technology, Weihai"], classification: "985 / 211 / \u53cc\u4e00\u6d41", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "swjtu", nameZh: "\u897f\u5357\u4ea4\u901a\u5927\u5b66", nameEn: "Southwest Jiaotong University", aliases: ["SWJTU", "\u897f\u5357\u4ea4\u901a\u5927\u5b66\uff08211\uff09"], classification: "211 / \u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "ruc-suzhou", nameZh: "\u4e2d\u56fd\u4eba\u6c11\u5927\u5b66\uff08\u82cf\u5dde\uff09", nameEn: "Renmin University of China, Suzhou Campus", aliases: ["\u4e2d\u56fd\u4eba\u6c11\u5927\u5b66\u82cf\u5dde", "Renmin University of China Suzhou"], classification: "985 / 211 / \u53cc\u4e00\u6d41", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "jnu", nameZh: "\u66a8\u5357\u5927\u5b66", nameEn: "Jinan University", aliases: ["JNU"], classification: "211 / \u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "jnu-birmingham", nameZh: "\u66a8\u5357\u5927\u5b66\u4f2f\u660e\u7ff0\u5927\u5b66\u8054\u5408\u5b66\u9662", nameEn: "Jinan University-Birmingham Joint Institute", aliases: ["\u66a8\u5357\u5927\u5b66\u4f2f\u660e\u7ff0\u5927\u5b66\u8054\u5408\u5b66\u9662"], classification: "211 / \u53cc\u4e00\u6d41\u8054\u5408\u57f9\u517b", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "xjtlu", nameZh: "\u897f\u4ea4\u5229\u7269\u6d66\u5927\u5b66", nameEn: "Xi'an Jiaotong-Liverpool University", aliases: ["XJTLU", "\u897f\u6d66"], classification: "\u4e2d\u5916\u5408\u4f5c\u5927\u5b66", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "xmu-cn", nameZh: "\u53a6\u95e8\u5927\u5b66", nameEn: "Xiamen University", aliases: ["XMU", "Amoy University"], classification: "985 / 211 / \u53cc\u4e00\u6d41", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "ouc", nameZh: "\u4e2d\u56fd\u6d77\u6d0b\u5927\u5b66", nameEn: "Ocean University of China", aliases: ["OUC"], classification: "985 / 211 / \u53cc\u4e00\u6d41", scoreTier: 3, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "swu-fl", nameZh: "\u56db\u5ddd\u5916\u56fd\u8bed\u5927\u5b66", nameEn: "Sichuan International Studies University", aliases: ["SISU"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "nufe", nameZh: "\u5357\u4eac\u8d22\u7ecf\u5927\u5b66", nameEn: "Nanjing University of Finance and Economics", aliases: ["NUFE"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "jsnu", nameZh: "\u6c5f\u82cf\u5e08\u8303\u5927\u5b66", nameEn: "Jiangsu Normal University", aliases: ["JSNU"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "hainan", nameZh: "\u6d77\u5357\u5927\u5b66", nameEn: "Hainan University", aliases: ["HNU"], classification: "211 / \u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "hdu", nameZh: "\u676d\u5dde\u7535\u5b50\u79d1\u6280\u5927\u5b66", nameEn: "Hangzhou Dianzi University", aliases: ["HDU"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "qdu", nameZh: "\u9752\u5c9b\u5927\u5b66", nameEn: "Qingdao University", aliases: ["QDU"], classification: "\u53cc\u975e", scoreTier: 1, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "rmit", nameZh: "\u7687\u5bb6\u58a8\u5c14\u672c\u7406\u5de5\u5927\u5b66", nameEn: "RMIT University", aliases: ["RMIT", "Royal Melbourne Institute of Technology", "\u7687\u5bb6\u58a8\u5c14\u672c\u7406\u5de5\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "curtin", nameZh: "\u79d1\u5ef7\u5927\u5b66", nameEn: "Curtin University", aliases: ["Curtin", "\u6fb3\u5927\u5229\u4e9a\u79d1\u5ef7\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "toronto", nameZh: "\u591a\u4f26\u591a\u5927\u5b66", nameEn: "University of Toronto", aliases: ["U of T", "UTSG", "\u591a\u4f26\u591a\u5927\u5b66\u4e3b\u6821\u533aUTSG", "\u52a0\u62ff\u5927\u591a\u4f26\u591a\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u52a0\u62ff\u5927" },
  { id: "brock", nameZh: "\u5e03\u9c81\u514b\u5927\u5b66", nameEn: "Brock University", aliases: ["\u52a0\u62ff\u5927\u5e03\u9c81\u514b\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u52a0\u62ff\u5927" },
  { id: "mcmaster", nameZh: "\u9ea6\u514b\u9a6c\u65af\u7279\u5927\u5b66", nameEn: "McMaster University", aliases: ["\u52a0\u62ff\u5927\u9ea6\u514b\u9a6c\u65af\u7279\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u52a0\u62ff\u5927" },
  { id: "ohio-state", nameZh: "\u4fc4\u4ea5\u4fc4\u5dde\u7acb\u5927\u5b66", nameEn: "The Ohio State University", aliases: ["Ohio State University", "OSU"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u7f8e\u56fd" },
  { id: "melbourne", nameZh: "\u58a8\u5c14\u672c\u5927\u5b66", nameEn: "The University of Melbourne", aliases: ["University of Melbourne"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "monash", nameZh: "\u8499\u7eb3\u58eb\u5927\u5b66", nameEn: "Monash University", aliases: [], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "ucsi", nameZh: "\u9a6c\u6765\u897f\u4e9a\u601d\u7279\u96c5\u5927\u5b66", nameEn: "UCSI University", aliases: ["UCSI", "UCSI UNIVERSITY"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u9a6c\u6765\u897f\u4e9a" },
  { id: "anu", nameZh: "\u6fb3\u6d32\u56fd\u7acb\u5927\u5b66", nameEn: "The Australian National University", aliases: ["Australian National University"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "sydney", nameZh: "\u6089\u5c3c\u5927\u5b66", nameEn: "The University of Sydney", aliases: ["University of Sydney"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u5927\u5229\u4e9a" },
  { id: "ucl", nameZh: "\u4f26\u6566\u5927\u5b66\u5b66\u9662", nameEn: "University College London", aliases: ["UCL", "\u4f26\u6566\u5927\u5b66\u5b66\u9662UCL"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u82f1\u56fd" },
  { id: "bristol", nameZh: "\u5e03\u91cc\u65af\u6258\u5927\u5b66", nameEn: "University of Bristol", aliases: ["Bristol University"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u82f1\u56fd" },
  { id: "edinburgh", nameZh: "\u7231\u4e01\u5821\u5927\u5b66", nameEn: "The University of Edinburgh", aliases: ["University of Edinburgh"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u82f1\u56fd" },
  { id: "birmingham", nameZh: "\u4f2f\u660e\u7ff0\u5927\u5b66", nameEn: "University of Birmingham", aliases: ["The University of Birmingham"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u82f1\u56fd" },
  { id: "glasgow", nameZh: "\u683c\u62c9\u65af\u54e5\u5927\u5b66", nameEn: "University of Glasgow", aliases: ["The University of Glasgow"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u82f1\u56fd" },
  { id: "cmu", nameZh: "\u5361\u5185\u57fa\u6885\u9686\u5927\u5b66", nameEn: "Carnegie Mellon University", aliases: ["CMU", "\u5361\u5185\u57fa\u6885\u9686\u5927\u5b66"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u7f8e\u56fd" },
  { id: "cityu-macau", nameZh: "\u6fb3\u95e8\u57ce\u5e02\u5927\u5b66", nameEn: "City University of Macau", aliases: ["\u6fb3\u57ce\u5927"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u6fb3\u95e8" },
  { id: "leeds", nameZh: "利兹大学", nameEn: "University of Leeds", aliases: ["The University of Leeds"], classification: "海外本科", scoreTier: 3, countryRegion: "英国" },
  { id: "uq", nameZh: "昆士兰大学", nameEn: "The University of Queensland", aliases: ["University of Queensland", "UQ"], classification: "海外本科", scoreTier: 3, countryRegion: "澳大利亚" },
  { id: "xmu-malaysia", nameZh: "厦门大学马来西亚分校", nameEn: "Xiamen University Malaysia", aliases: ["Xiamen University Malaysia Campus", "XMUM"], classification: "海外本科", scoreTier: 3, countryRegion: "马来西亚" },
  { id: "ncepu-beijing", nameZh: "华北电力大学（北京）", nameEn: "North China Electric Power University (Beijing)", aliases: ["华北电力大学", "NCEPU", "NCEPU Beijing"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "sdu-weihai", nameZh: "山东大学（威海）", nameEn: "Shandong University, Weihai", aliases: ["山东大学威海", "Shandong University Weihai"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "neepu", nameZh: "东北电力大学", nameEn: "Northeast Electric Power University", aliases: [], classification: "双非", scoreTier: 1, countryRegion: "中国大陆" },
  { id: "ecnu", nameZh: "华东师范大学", nameEn: "East China Normal University", aliases: ["ECNU", "华东师大"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "tyut", nameZh: "太原理工大学", nameEn: "Taiyuan University of Technology", aliases: ["TYUT"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "shu", nameZh: "上海大学", nameEn: "Shanghai University", aliases: ["SHU"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "whut", nameZh: "武汉理工大学", nameEn: "Wuhan University of Technology", aliases: ["WHUT"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "neu-qhd", nameZh: "东北大学秦皇岛分校", nameEn: "Northeastern University at Qinhuangdao", aliases: ["东北大学秦皇岛", "NEUQ"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "sdu-qingdao", nameZh: "山东大学（青岛）", nameEn: "Shandong University, Qingdao", aliases: ["山东大学青岛", "山东大学青岛校区"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "cityu-hk", nameZh: "香港城市大学", nameEn: "City University of Hong Kong", aliases: ["CityU", "港城"], classification: "海外本科", scoreTier: 3, countryRegion: "香港" },
  { id: "polyu-hk", nameZh: "香港理工大学", nameEn: "The Hong Kong Polytechnic University", aliases: ["PolyU", "港理工"], classification: "海外本科", scoreTier: 3, countryRegion: "香港" },
  { id: "hust", nameZh: "华中科技大学", nameEn: "Huazhong University of Science and Technology", aliases: ["HUST", "华科"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "gdut", nameZh: "广东工业大学", nameEn: "Guangdong University of Technology", aliases: ["GDUT", "广工"], classification: "双非", scoreTier: 1, countryRegion: "中国大陆" },
  { id: "xidian", nameZh: "西安电子科技大学", nameEn: "Xidian University", aliases: ["XDU", "西电"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "sichuan-agri", nameZh: "四川农业大学", nameEn: "Sichuan Agricultural University", aliases: ["Sichuan Agricultural University", "川农"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "swjtu", nameZh: "西南交通大学", nameEn: "Southwest Jiaotong University", aliases: ["Southwest Jiaotong University", "西南交大"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "guizhou", nameZh: "贵州大学", nameEn: "Guizhou University", aliases: ["Guizhou University", "贵大"], classification: "211 / 双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "bit", nameZh: "北京理工大学", nameEn: "Beijing Institute of Technology", aliases: ["BIT", "北理工"], classification: "985 / 211 / 双一流", scoreTier: 3, countryRegion: "中国大陆" },
  { id: "njupt", nameZh: "南京邮电大学", nameEn: "Nanjing University of Posts and Telecommunications", aliases: ["NJUPT", "南邮"], classification: "双一流", scoreTier: 2, countryRegion: "中国大陆" },
  { id: "hkbu", nameZh: "香港浸会大学", nameEn: "Hong Kong Baptist University", aliases: ["HKBU", "浸会"], classification: "海外本科", scoreTier: 3, countryRegion: "香港" },
  { id: "lingnan-hk", nameZh: "岭南大学", nameEn: "Lingnan University", aliases: ["香港岭南大学", "Lingnan"], classification: "海外本科", scoreTier: 3, countryRegion: "香港" },
  { id: "eduhk", nameZh: "香港教育大学", nameEn: "The Education University of Hong Kong", aliases: ["EdUHK", "港教大"], classification: "海外本科", scoreTier: 3, countryRegion: "香港" }
  ,{ id: "dalhousie", nameZh: "戴尔豪斯大学", nameEn: "Dalhousie University", aliases: ["Dalhousie", "alhousie university"], classification: "海外本科", scoreTier: 3, countryRegion: "加拿大" }
  ,{ id: "uibe", nameZh: "\u5bf9\u5916\u7ecf\u6d4e\u8d38\u6613\u5927\u5b66", nameEn: "University of International Business and Economics", aliases: ["\u5bf9\u5916\u7ecf\u8d38\u5927\u5b66", "UIBE"], classification: "211 / \u53cc\u4e00\u6d41", scoreTier: 2, countryRegion: "\u4e2d\u56fd\u5927\u9646" },
  { id: "hipo:1045", nameZh: "\u7231\u8377\u534e\u5927\u5b66", nameEn: "University of Iowa", aliases: ["\u7231\u8377\u534e\u5927\u5b66", "Iowa University", "Iowa"], classification: "\u6d77\u5916\u672c\u79d1", scoreTier: 3, countryRegion: "\u7f8e\u56fd" },
];

const seededIds = new Map([
  ["中国矿业大学", "cumt"], ["清华大学", "tsinghua"], ["北京大学", "pku"],
  ["上海交通大学", "sjtu"], ["浙江大学", "zju"], ["复旦大学", "fudan"],
  ["中国科学技术大学", "ustc"], ["南京大学", "nju"], ["华南理工大学", "scut"],
  ["中国农业大学", "cau"], ["吉林大学", "jlu"], ["南京航空航天大学", "nuaa"],
  ["北京邮电大学", "bupt"], ["南方科技大学", "sustech"], ["帝国理工学院", "imperial"],
  ["伦敦大学学院", "ucl"], ["曼彻斯特大学", "manchester"], ["新加坡国立大学", "nus"],
  ["南洋理工大学", "ntu"], ["新加坡南洋理工", "ntu"], ["Nanyang Technological University, Singapore", "ntu"], ["香港大学", "hku"], ["香港中文大学", "cuhk"],
  ["香港科技大学", "hkust"]
]);

const inferRegion = classification => classification === "海外本科" ? "海外" : "中国大陆";

const fromSeed = seededSchools.map(school => ({
  id: seededIds.get(school.name) || `institution-${normalizeName(school.name)}`,
  nameZh: school.name,
  nameEn: school.aliases?.find(alias => /[a-z]/i.test(alias)) || null,
  aliases: school.aliases || [],
  classification: school.classification || null,
  scoreTier: school.scoreTier ?? null,
  countryRegion: ["香港大学", "香港中文大学", "香港科技大学"].includes(school.name) ? "香港"
    : ["新加坡国立大学", "南洋理工大学"].includes(school.name) ? "新加坡"
      : inferRegion(school.classification),
  ranking: { qs: school.qs || null, arwu: school.arwu || null, sourceUrl: school.rankingUrl || null }
}));

export const institutionMaster = [...fromSeed, ...institutionExtras]
  .filter((item, index, rows) => rows.findIndex(candidate => candidate.id === item.id) === index);

const institutionNames = institutionMaster.flatMap(institution => [
  [institution.nameZh, institution], [institution.nameEn, institution],
  ...(institution.aliases || []).map(alias => [alias, institution]),
  ...(institution.id === "ntu"
    ? [["新加坡南洋理工", institution], ["Nanyang Technological University, Singapore", institution]]
    : [])
  ,...(institution.id === "polyu-hk" ? [["香港理工", institution]] : [])
]).filter(([name]) => name).map(([name, institution]) => [normalizeName(name), institution]);
const institutionIndex = new Map(institutionNames);

export function resolveInstitution(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  if (institutionIndex.has(normalized)) return institutionIndex.get(normalized);
  return institutionMaster.find(institution => {
    const candidates = [institution.nameZh, institution.nameEn, ...(institution.aliases || [])]
      .filter(Boolean).map(normalizeName);
    return candidates.some(candidate => candidate.length >= 4 && (normalized.includes(candidate) || candidate.includes(normalized)));
  }) || null;
}

const undergraduateTierPattern = new RegExp("(985|211|\\u53cc\\u4e00\\u6d41|\\u53cc\\u975e|\\u6d77\\u5916\\u672c\\u79d1|\\u6d77\\u672c|\\u56fd\\u5916\\u672c\\u79d1|\\u52a0\\u62ff\\u5927\\u672c\\u79d1|\\u6fb3\\u6d32\\u672c\\u79d1|\\u82f1\\u56fd\\u672c\\u79d1|\\u7f8e\\u56fd\\u672c\\u79d1|\\u52a0\\u672c|\\u6fb3\\u672c|\\u82f1\\u672c|\\u7f8e\\u672c|\\u6e2f\\u672c|\\u65b0\\u672c)", "iu");
const juniorInstitutionPattern = new RegExp("(\\u4e13\\u79d1|\\u9ad8\\u804c|\\u804c\\u4e1a\\u6280\\u672f|\\u804c\\u4e1a\\u5b66\\u9662|\\u4e13\\u79d1\\u5b66\\u6821|\\u9ad8\\u4e2d|\\u9ad8\\u7ea7\\u4e2d\\u5b66|\\u4e2d\\u5b66|vocational|community college|junior college|high school|secondary school)", "iu");

export function undergraduateInstitutionEvidence(name, institutionId = null) {
  const raw = String(name || "").trim();
  return {
    present: Boolean(raw),
    tierMentioned: undergraduateTierPattern.test(raw),
    junior: juniorInstitutionPattern.test(raw),
    recognized: Boolean(institutionId),
    accepted: Boolean(raw) && !juniorInstitutionPattern.test(raw) && (Boolean(institutionId) || undergraduateTierPattern.test(raw))
  };
}

const programmeCaseSources = {
  "hkust-bdt": ["https://www.51liuxue.com/c/2.shtml"],
  "cuhk-cs": ["https://www.51liuxue.com/c/2.shtml"],
  "cuhk-msc-in-artificial-intelligence-for-science": ["https://liuxue.xdf.cn/blog/case_7954954.shtml"],
  "cuhk-ee": [
    "https://www.compassedu.hk/offers_1727",
    "https://liuxue.gaotu.cn/cgal/115.html"
  ],
  "polyu-hk-artificial-intelligence-and-big-data-computing": ["https://liuxue.xdf.cn/blog/gaonan10/case/5328963.shtml"],
  "polyu-hk-cybersecurity": ["https://liuxue.xdf.cn/blog/case_7995712.shtml"],
  "cuhk-ie": ["https://www.compassedu.hk/offers_1728"],
  "cuhk-mae": ["https://www.compassedu.hk/offers_1729"],
  "ntu-cca": [
    "https://www.compassedu.hk/offers_1689",
    "https://m.study-in-europe.net/nd.jsp?id=651&mid=5"
  ],
  "ntu-electronics": [
    "https://www.compassedu.hk/offers_1690",
    "https://ulec.com.cn/posts/singapore-nus-ntu-cases-2026/",
    "https://m.study-in-europe.net/nd.jsp?id=651&mid=5"
  ],
  "ntu-power": [
    "https://www.compassedu.hk/offers_1693",
    "https://m.study-in-europe.net/nd.jsp?id=651&mid=5"
  ],
  "cuhk-msc-in-microelectronics-and-integrated-circuits": [
    "https://www.eic.org.cn/case/detail/925602802c014b439167fdd7b7ebd64f",
    "https://www.eic.org.cn/case/detail/a0c5f74e813b4f55a660c35addc02716",
    "https://www.eic.org.cn/case/detail/dc7b244b276e4de09b6f75d9540533d8",
    "https://www.eic.org.cn/case/detail/dc1e74947eeb46569c610117e5b89b01"
  ],
  "hku-master-of-science-in-engineering-integrated-circuits-and-electronic-systems": [
    "https://www.eic.org.cn/case/detail/7587b69a06544895b2ba8ccd3d38a8ca"
  ]
};

const programmeFocusTags = {
  "cuhk-ee": ["electronic", "communication", "signal", "integrated-circuit"],
  "hkust-ee": ["electronic", "communication", "automation", "robotics"],
  "nus-ee": ["electrical", "electronic", "automation", "communication", "integrated-circuit"],
  "ntu-communications": ["communication", "network", "signal"],
  "cuhk-ie": ["computer", "data", "communication", "network", "ai"],
  "cuhk-mae": ["mechanical", "automation", "robotics", "manufacturing"],
  "ntu-cca": ["automation", "control"],
  "ntu-electronics": ["electronic", "integrated-circuit", "semiconductor"],
  "ntu-power": ["electrical", "power", "energy"],
  "cityu-eie": ["electronic", "communication", "power"],
  "cityu-cie": ["computer", "ai", "network", "cloud"],
  "polyu-eie": ["electronic", "communication", "iot", "signal"],
  "polyu-ee": ["electrical", "power", "railway"],
  "hku-eee": ["electrical", "electronic", "communication", "signal"],
  "nus-biomedical-informatics": ["biomedical", "healthcare", "data", "ai"],
  "nus-mcomp-ai": ["computer", "ai"],
  "nus-robotics": ["robotics", "automation", "control"],
  "ntu-robotics-intelligent-systems": ["robotics", "automation", "control"],
  "ntu-precision-scientific-instrumentation": ["instrumentation", "physics", "semiconductor", "optoelectronics"],
  "imperial-environmental-data-science-ml": ["environmental", "data", "ai"],
  "ntu-financial-technology": ["finance", "computer", "data"],
  "cityu-business-data-analytics": ["business", "data"],
  "melbourne-information-technology": ["computer", "software", "data"],
  "monash-master-engineering": ["engineering"],
  "cmu-information-systems-management": ["information-systems", "business", "computer"],
  "hkust-bdt": ["computer", "data", "ai"],
  "cuhk-cs": ["computer", "software", "data", "ai"]
};

const seededProgrammeMaster = seededProgrammes.map(programme => ({
  id: programme.id,
  institutionId: resolveInstitution(programme.university)?.id || null,
  region: programme.region,
  nameZh: programme.nameZh,
  nameEn: programme.name,
  aliases: [programme.nameZh, programme.name, ...(programme.aliases || []), `${programme.university}${programme.nameZh}`],
  officialCode: null,
  officialUrl: programme.officialUrl,
  curriculumUrl: programme.curriculumUrl || programme.officialUrl,
  active: true,
  majorTags: programme.majorTags || [],
  focusTags: programme.focusTags || programmeFocusTags[programme.id] || [],
  courseTags: programme.courseTags || [],
  caseSourceUrls: programmeCaseSources[programme.id] || []
}));

const programmeExtras = [
  {
    id: "hku-civil-engineering",
    institutionId: "hku",
    region: "香港",
    nameZh: "土木工程工学硕士",
    nameEn: "MSc(Eng) in Civil Engineering",
    aliases: ["Master of Science in Engineering (Civil Engineering)", "MSc(Eng)(CivE)", "土木工程硕士"],
    officialCode: "MSc(Eng)(CivE)",
    officialUrl: "https://portal.hku.hk/tpg-admissions/programme-details?programme=master-of-science-in-engineering-(civil-engineering)-general-stream-engg&mode=1",
    curriculumUrl: "https://portal.hku.hk/tpg-admissions/programme-details?programme=master-of-science-in-engineering-(civil-engineering)-general-stream-engg&mode=1",
    active: true,
    majorTags: ["civil"],
    focusTags: ["civil"],
    courseTags: [],
    caseSourceUrls: []
  },
  {
    id: "hku-infrastructure-engineering-management",
    institutionId: "hku",
    region: "香港",
    nameZh: "基础设施工程与管理工学硕士",
    nameEn: "MSc(Eng) in Infrastructure Engineering and Management",
    aliases: ["Master of Science in Engineering (Infrastructure Engineering and Management)", "MSc(Eng)(IEM)", "基础设施工程与管理硕士"],
    officialCode: "MSc(Eng)(IEM)",
    officialUrl: "https://portal.hku.hk/tpg-admissions/programme-details?programme=master-of-science-in-engineering-(infrastructure-engineering-and-management)-infrastructure-project-management-stream-engg&mode=1",
    curriculumUrl: "https://portal.hku.hk/tpg-admissions/programme-details?programme=master-of-science-in-engineering-(infrastructure-engineering-and-management)-infrastructure-project-management-stream-engg&mode=1",
    active: true,
    majorTags: ["civil"],
    focusTags: ["civil"],
    courseTags: [],
    caseSourceUrls: []
  },
  {
    id: "hkust-bdt",
    institutionId: "hkust",
    region: "\u9999\u6e2f",
    nameZh: "\u5927\u6570\u636e\u79d1\u6280\u7406\u5b66\u7855\u58eb",
    nameEn: "MSc in Big Data Technology",
    aliases: ["Master of Science in Big Data Technology", "MSc(BDT)", "Big Data Technology", "\u5927\u6570\u636e\u79d1\u6280", "\u5927\u6570\u636e\u79d1\u6280\u7855\u58eb", "\u5927\u6570\u636e\u6280\u672f", "\u5927\u6570\u636e\u6280\u672f\u7406\u5b66\u7855\u58eb"],
    officialCode: "MSc(BDT)",
    officialUrl: "https://seng.hkust.edu.hk/academics/taught-postgraduate/msc-bdt",
    curriculumUrl: "https://prog-crs.hkust.edu.hk/pgprog/2025-26/msc-bdt",
    active: true,
    majorTags: ["computer", "electronic", "automation"],
    focusTags: programmeFocusTags["hkust-bdt"],
    courseTags: ["math", "programming", "data", "ai"],
    caseSourceUrls: programmeCaseSources["hkust-bdt"]
  },
  {
    id: "cuhk-cs",
    institutionId: "cuhk",
    region: "\u9999\u6e2f",
    nameZh: "\u8ba1\u7b97\u673a\u79d1\u5b66\u7406\u5b66\u7855\u58eb",
    nameEn: "MSc in Computer Science",
    aliases: ["Master of Science in Computer Science", "M.Sc. Programme in Computer Science", "Computer Science", "\u8ba1\u7b97\u673a\u79d1\u5b66", "\u8ba1\u7b97\u673a\u79d1\u5b66\u7855\u58eb"],
    officialCode: null,
    officialUrl: "https://www.gs.cuhk.edu.hk/programmes/engineering/msc-computer-science",
    curriculumUrl: "https://msc.cse.cuhk.edu.hk/?lang=en&page_id=160",
    active: true,
    majorTags: ["computer", "electronic", "automation"],
    focusTags: programmeFocusTags["cuhk-cs"],
    courseTags: ["math", "programming", "data", "ai"],
    caseSourceUrls: programmeCaseSources["cuhk-cs"]
  }
];

const curatedProgrammeMaster = [...seededProgrammeMaster, ...programmeExtras];

const focusRules = [
  [/computer|computing|software|cyber|information system/i, ["computer", "software"]],
  [/artificial intelligence|machine learning/i, ["ai"]],
  [/data|analytics|statistics|business intelligence/i, ["data"]],
  [/mathematics|quantitative finance|financial mathematics|applied mathematics/i, ["mathematics"]],
  [/physics|quantum/i, ["physics"]],
  [/electrical|electronic|microelectronic/i, ["electrical", "electronic"]],
  [/communication|telecommunication|signal|network/i, ["communication", "signal"]],
  [/integrated circuit|semiconductor|chip/i, ["integrated-circuit", "semiconductor"]],
  [/robot|automation|control/i, ["robotics", "automation", "control"]],
  [/mechanical|manufactur/i, ["mechanical", "manufacturing"]],
  [/civil|construction|infrastructure/i, ["civil"]],
  [/chemical|chemistry/i, ["chemical"]],
  [/material|nanoscience|nanotechnology/i, ["materials"]],
  [/biology|biological|bioscience|biotechnology|biodiversity|life science|genomic|microbiology/i, ["biology", "life-science"]],
  [/biomedical|bioengineering|health informatics/i, ["biomedical"]],
  [/medicine|medical|clinical|health sciences/i, ["medicine", "healthcare"]],
  [/pharmacy|pharmaceutical|pharmacology|drug development/i, ["pharmacy", "healthcare"]],
  [/public health|epidemiology|health economics|health policy|healthcare quality|patient safety|infectious disease|precision health/i, ["public-health", "healthcare"]],
  [/food science|nutrition/i, ["food-nutrition", "life-science"]],
  [/psychology|behaviou?ral/i, ["psychology"]],
  [/energy|power|environment|sustainab/i, ["energy", "environmental"]],
  [/finance|fintech/i, ["finance"]],
  [/economics/i, ["economics"]],
  [/account/i, ["accounting"]],
  [/supply chain|operations|logistics|maritime/i, ["operations"]],
  [/marketing/i, ["marketing"]],
  [/business|management|marketing|account/i, ["business"]],
  [/law|legal|arbitration|dispute resolution/i, ["law"]],
  [/education|teaching|learning|pedagogy|tesol/i, ["education"]],
  [/media|journalism|communication and new media|creative writing|publishing/i, ["media"]],
  [/architecture|urban design|urban planning|landscape/i, ["architecture", "design"]],
  [/design|creative arts|fine arts|music|theatre/i, ["design", "arts"]],
  [/public policy|public administration|international affairs|social work|sociology|politic|governance/i, ["public-policy", "social-science"]],
  [/language|linguistic|translation|literary|literature|history|chinese studies|asian studies|humanities/i, ["humanities", "language"]]
];

export const inferProgrammeFocus = name => {
  const value = String(name || "");
  const tags = focusRules.flatMap(([pattern, matched]) => pattern.test(value) ? matched : []);
  if (/electronic commerce/i.test(value)) tags.splice(0, tags.length, ...tags.filter(tag => !["electrical", "electronic"].includes(tag)));
  if (/(?:global|media|marketing|corporate|creative|bilingual) communication|communication and new media/i.test(value)) {
    tags.splice(0, tags.length, ...tags.filter(tag => !["communication", "signal"].includes(tag)));
  }
  return [...new Set(tags)];
};
let discoveredProgrammes = [];
try {
  const catalogue = JSON.parse(readFileSync(new URL("./collector/data/programme-catalogue.json", import.meta.url), "utf8"));
  discoveredProgrammes = (catalogue.programmes || []).flatMap(item => {
    // Streams are options inside the parent degree, not separate applications.
    if (/\)\s*-\s*.+ stream$/i.test(item.nameEn)) return [];
    const normalized = normalizeProgrammeTitle(item.nameEn);
    const curated = curatedProgrammeMaster.find(programme => programme.institutionId === item.institutionId
      && [programme.nameEn, programme.nameZh, ...(programme.aliases || [])].filter(Boolean)
        .some(alias => normalizeProgrammeTitle(alias) === normalized));
    if (curated) return [];
    const focusTags = inferProgrammeFocus(item.nameEn);
    return [{
      id: item.id,
      institutionId: item.institutionId,
      region: item.region,
      nameZh: item.nameZh || item.nameEn,
      nameEn: item.nameEn,
      aliases: [item.nameEn, item.nameZh].filter(Boolean),
      officialCode: item.officialCode || null,
      officialUrl: item.officialUrl,
      curriculumUrl: item.officialUrl,
      active: true,
      majorTags: focusTags,
      focusTags,
      courseTags: [],
      caseSourceUrls: []
    }];
  });
} catch {}

const programmeAliasOverrides = {
  "ntu-master-of-science-signal-processing-machine-learning": ["信号处理与机器学习硕士", "信号处理与机器学习理学硕士", "Signal Processing and Machine Learning"],
  "hku-master-of-data-science": ["香港大学数据科学硕士", "数据科学硕士", "香港大学数据科学"],
  "hku-master-of-science-in-engineering-microelectronics-science-and-technology": ["香港大学微电子科学与技术硕士", "微电子科学与技术工程理学硕士"],
  "hkust-msc-in-integrated-circuits": ["香港科技大学集成电路硕士", "集成电路硕士", "集成电路设计"],
  "hkust-msc-in-information-and-cyber-security-management": ["香港科技大学信息与网络安全管理硕士", "网络安全管理硕士", "信息与网络安全管理理学硕士"],
  "cityu-hk-msc-data-science": ["香港城市大学数据科学硕士", "数据科学理学硕士", "理學碩士(數據科學)", "理学硕士(数据科学)", "数据科学专业"],
  "cityu-hk-msc-artificial-intelligence-for-sciences": ["香港城市大学科学人工智能硕士", "香港城市大学人工智能与科学硕士", "人工智能与科学硕士", "科学人工智能硕士", "理學碩士(人工智能與科學)", "理学硕士(人工智能与科学)"],
  "ntu-master-of-science-data-science": ["南洋理工大学数据科学理学硕士", "南洋理工大学数据科学硕士", "数据科学理学硕士", "数据科学硕士", "NTU DS", "NTU Data Science", "南洋理工大学 NTU 数据科学", "南洋理工 NTU 数据科学"],
  "ntu-electronics": ["南洋理工大学电子学硕士", "电子学硕士", "集成电路与微电子硕士", "集成电路与微电子学硕士"],
  "ntu-master-of-science-integrated-circuit-design": ["南洋理工大学集成电路设计硕士", "集成电路设计理学硕士"],
  "ntu-master-of-science-cyber-security": ["南洋理工大学网络安全硕士", "网络安全理学硕士"],
  "cuhk-msc-in-artificial-intelligence-for-science": ["香港中文大学人工智能与科学硕士", "人工智能与科学理学硕士"],
  "cuhk-msc-in-microelectronics-and-integrated-circuits": ["香港中文大学微电子与集成电路硕士", "微电子与集成电路理学硕士"],
  "polyu-hk-artificial-intelligence-and-big-data-computing": ["香港理工大学人工智能与大数据计算", "人工智能与大数据计算", "人工智能和大数据计算", "人工智能及大数据计算"],
  "polyu-hk-cybersecurity": ["香港理工大学网络安全硕士", "网络安全硕士", "网络空间安全", "MSc Cybersecurity", "Cybersecurity"],
  "cityu-hk-msc-cybersecurity": ["香港城市大学网络安全硕士", "网络安全硕士", "网络空间安全", "MSc Cybersecurity", "Cybersecurity"],
  "polyu-hk-data-science-and-analytics": ["香港理工大学数据科学及分析理学硕士", "数据科学及分析理学硕士", "数据科学与分析理学硕士"]
};

programmeAliasOverrides["hkust-msc-in-data-driven-modeling"] = [
  "\u9999\u6e2f\u79d1\u6280\u5927\u5b66\u6570\u636e\u9a71\u52a8\u5efa\u6a21\u7406\u5b66\u7855\u58eb",
  "\u6570\u636e\u9a71\u52a8\u5efa\u6a21\u7406\u5b66\u7855\u58eb",
  "\u6570\u636e\u9a71\u52a8\u5efa\u6a21",
  "HKUST Data-Driven Modeling"
];
programmeAliasOverrides["nus-master-of-science-industrial-systems-engineering"] = [
  "\u5de5\u4e1a\u4e0e\u7cfb\u7edf\u5de5\u7a0b\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-mechanical-engineering"] = [
  "\u673a\u68b0\u5de5\u7a0b\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-biomedical-engineering"] = [
  "\u751f\u7269\u533b\u5b66\u5de5\u7a0b\u7406\u5b66\u7855\u58eb",
  "\u751f\u7269\u533b\u5b66\u5de5\u7a0b"
];
programmeAliasOverrides["nus-master-of-science-in-chemical-sciences"] = [
  "\u5316\u5b66\u79d1\u5b66\u7855\u58eb",
  "\u5316\u5b66\u79d1\u5b66"
];
programmeAliasOverrides["nus-master-of-science-energy-systems"] = [
  "\u80fd\u6e90\u7cfb\u7edf\u7406\u5b66\u7855\u58eb",
  "\u80fd\u6e90\u7cfb\u7edf"
];
programmeAliasOverrides["nus-master-of-science-materials-science-and-engineering"] = [
  "\u6750\u6599\u79d1\u5b66\u4e0e\u5de5\u7a0b\u7406\u5b66\u7855\u58eb",
  "\u6750\u6599\u79d1\u5b66\u4e0e\u5de5\u7a0b"
];
programmeAliasOverrides["nus-master-of-science-project-management"] = [
  "\u9879\u76ee\u7ba1\u7406\u7406\u5b66\u7855\u58eb",
  "\u9879\u76ee\u7ba1\u7406"
];
programmeAliasOverrides["nus-master-of-science-in-pharmaceutical-science-and-technology"] = [
  "\u5236\u836f\u79d1\u5b66\u4e0e\u6280\u672f\u7406\u5b66\u7855\u58eb",
  "\u5236\u836f\u79d1\u5b66\u4e0e\u6280\u672f"
];
programmeAliasOverrides["nus-master-of-science-in-data-science-and-machine-learning"] = [
  "\u6570\u636e\u79d1\u5b66\u4e0e\u673a\u5668\u5b66\u4e60\u7406\u5b66\u7855\u58eb",
  "\u6570\u636e\u79d1\u5b66\u4e0e\u673a\u5668\u5b66\u4e60"
];
programmeAliasOverrides["nus-master-of-computing"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u8ba1\u7b97\u7855\u58eb\uff08\u542b\u7ec6\u5206\u65b9\u5411\uff09",
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u8ba1\u7b97\u7855\u58eb\uff08\u901a\u8bc6\u65b9\u5411\uff09",
  "\u8ba1\u7b97\u7855\u58eb\uff08\u542b\u7ec6\u5206\u65b9\u5411\uff09",
  "\u8ba1\u7b97\u7855\u58eb\uff08\u901a\u8bc6\u65b9\u5411\uff09"
];
programmeAliasOverrides["nus-master-of-science-in-applied-biomedicine"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u5e94\u7528\u751f\u7269\u533b\u5b66\u7406\u5b66\u7855\u58eb",
  "\u5e94\u7528\u751f\u7269\u533b\u5b66\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-supply-chain-management"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u4f9b\u5e94\u94fe\u7ba1\u7406\u7406\u5b66\u7855\u58eb",
  "\u4f9b\u5e94\u94fe\u7ba1\u7406\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-computer-engineering"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u8ba1\u7b97\u673a\u5de5\u7a0b\u7406\u5b66\u7855\u58eb",
  "\u8ba1\u7b97\u673a\u5de5\u7a0b\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-technology-in-software-engineering"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u8f6f\u4ef6\u5de5\u7a0b\u79d1\u6280\u7855\u58eb",
  "\u8f6f\u4ef6\u5de5\u7a0b\u79d1\u6280\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-technology-in-artificial-intelligence-systems"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u4eba\u5de5\u667a\u80fd\u7cfb\u7edf\u79d1\u6280\u7855\u58eb",
  "\u4eba\u5de5\u667a\u80fd\u7cfb\u7edf\u79d1\u6280\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-management-of-technology-and-innovation"] = [
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u6280\u672f\u4e0e\u521b\u65b0\u7ba1\u7406\u7406\u5b66\u7855\u58eb",
  "\u6280\u672f\u4e0e\u521b\u65b0\u7ba1\u7406\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-laws-international-business-law"] = [
  "\u56fd\u9645\u5546\u6cd5\u7855\u58eb"
];
programmeAliasOverrides["ntu-master-of-science-civil-engineering"] = [
  "\u571f\u6728\u5de5\u7a0b\u7855\u58eb"
];
programmeAliasOverrides["ntu-master-of-science-marketing-science"] = [
  "\u5e02\u573a\u8425\u9500\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-maritime-technology-and-management"] = [
  "\u6d77\u4e8b\u6280\u672f\u4e0e\u7ba1\u7406\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-ee"] = [
  "\u7535\u5b50\u5de5\u7a0b\u7855\u58eb"
];
programmeAliasOverrides["ntu-master-of-science-technopreneurship-innovation"] = [
  "\u79d1\u6280\u521b\u65b0\u4e0e\u521b\u4e1a\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-economics"] = [
  "\u7ecf\u6d4e\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-finance"] = [
  "\u91d1\u878d\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-materials-science-and-engineering"] = [
  "\u6750\u6599\u79d1\u5b66\u5de5\u7a0b\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-venture-creation"] = [
  "\u4f01\u4e1a\u5f00\u53d1\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-in-data-science-for-sustainability"] = [
  "\u53ef\u6301\u7eed\u53d1\u5c55\u6570\u636e\u79d1\u5b66\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-science-marketing-analytics-and-insights"] = [
  "\u5e02\u573a\u8425\u9500\u5206\u6790\u4e0e\u6d1e\u5bdf\u7406\u5b66\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-technology-in-enterprise-business-analytics"] = [
  "\u4f01\u4e1a\u5546\u4e1a\u5206\u6790\u79d1\u6280\u7855\u58eb"
];
programmeAliasOverrides["nus-master-of-arts-asian-and-global-history"] = [
  "\u4e9a\u6d32\u4e0e\u5168\u7403\u5386\u53f2\u6587\u5b66\u7855\u58eb"
];
programmeAliasOverrides["ntu-master-of-science-biomedical-data-science"] = [
  "\u751f\u7269\u533b\u5b66\u6570\u636e\u79d1\u5b66"
];
programmeAliasOverrides["ntu-master-of-science-smart-manufacturing"] = [
  "\u667a\u80fd\u5236\u9020"
];
programmeAliasOverrides["ntu-master-of-science-enterprise-artificial-intelligence"] = [
  "\u4f01\u4e1a\u4eba\u5de5\u667a\u80fd"
];
programmeAliasOverrides["ntu-master-of-science-green-energy-technologies"] = [
  "\u7eff\u8272\u80fd\u6e90\u6280\u672f",
  "\u7eff\u8272\u80fd\u6e90"
];
programmeAliasOverrides["ntu-master-in-computing-applied-artificial-intelligence"] = [
  "\u5e94\u7528\u4eba\u5de5\u667a\u80fd"
];
programmeAliasOverrides["ntu-master-of-science-artificial-intelligence-in-medicine"] = [
  "\u533b\u5b66\u4eba\u5de5\u667a\u80fd"
];
programmeAliasOverrides["ntu-master-of-science-chemical-sciences-instrumentation"] = [
  "\u5316\u5b66\u79d1\u5b66\u4e0e\u4eea\u5668", "\u5316\u5b66\u79d1\u5b66\u4e0e\u4eea\u5668\u7855\u58eb"
];
programmeAliasOverrides["ntu-master-in-computing-applied-artificial-intelligence"] = [
  "\u5e94\u7528\u4eba\u5de5\u667a\u80fd\u8ba1\u7b97\u7855\u58eb", "\u5e94\u7528\u4eba\u5de5\u667a\u80fd\u8ba1\u7b97"
];
programmeAliasOverrides["ntu-master-of-science-aviation"] = [
  "\u822a\u7a7a"
];
programmeAliasOverrides["ntu-master-of-science-nanotechnology-nanoscience"] = [
  "\u7eb3\u7c73\u6280\u672f\u548c\u7eb3\u7c73\u79d1\u5b66"
];
programmeAliasOverrides["ntu-master-of-science-supply-chain-engineering"] = [
  "\u4f9b\u5e94\u94fe\u5de5\u7a0b"
];
programmeAliasOverrides["ntu-master-of-science-applied-economics"] = [
  "\u5e94\u7528\u7ecf\u6d4e\u5b66"
];
programmeAliasOverrides["ntu-master-of-science-managerial-economics"] = [
  "\u7ba1\u7406\u7ecf\u6d4e\u5b66", "\u7ba1\u7406\u7ecf\u6d4e\u5b66MME"
];
programmeAliasOverrides["ntu-master-of-science-materials-science-engineering"] = [
  "\u6750\u6599\u79d1\u5b66\u4e0e\u5de5\u7a0b"
];
programmeAliasOverrides["ntu-master-of-science-chemical-engineering"] = [
  "\u5316\u5b66\u5de5\u7a0b"
];
programmeAliasOverrides["ntu-master-of-science-maritime-studies"] = [
  "\u6d77\u4e8b\u7814\u7a76"
];
programmeAliasOverrides["ntu-master-of-science-cyber-security"] = [
  "\u7f51\u7edc\u5b89\u5168"
];
programmeAliasOverrides["hku-master-of-transport-policy-and-planning"] = [
  "\u4ea4\u901a\u653f\u7b56\u4e0e\u89c4\u5212"
];
programmeAliasOverrides["hku-master-of-science-in-geospatial-data-science"] = [
  "\u5730\u7406\u7a7a\u95f4\u6570\u636e\u79d1\u5b66"
];
programmeAliasOverrides["hku-master-of-science-in-artificial-intelligence"] = [
  "\u4eba\u5de5\u667a\u80fd"
];
programmeAliasOverrides["hku-master-of-science-in-engineering-integrated-circuits-and-electronic-systems"] = [
  "\u96c6\u6210\u7535\u8def\u4e0e\u7535\u5b50\u7cfb\u7edf\u5de5\u7a0b"
];
programmeAliasOverrides["hkust-msc-in-telecommunications"] = [
  "\u7535\u4fe1\u5b66"
];
programmeAliasOverrides["polyu-eie"] = [
  "\u7535\u5b50\u4e0e\u4fe1\u606f\u5de5\u7a0b\u5b66"
];
programmeAliasOverrides["nus-master-of-social-work"] = [
  "\u793e\u4f1a\u5de5\u4f5c"
];
programmeAliasOverrides["cuhk-ma-in-social-policy"] = [
  "\u793e\u4f1a\u653f\u7b56"
];
programmeAliasOverrides["hku-master-of-public-administration"] = [
  "\u516c\u5171\u7ba1\u7406"
];
programmeAliasOverrides["ntu-cca"] = [
  "\u8ba1\u7b97\u673a\u63a7\u5236\u548c\u81ea\u52a8\u5316\u7855\u58eb",
  "\u8ba1\u7b97\u673a\u63a7\u5236\u4e0e\u81ea\u52a8\u5316\u7855\u58eb"
];
programmeAliasOverrides["polyu-hk-artificial-intelligence-and-big-data-computing"].push(
  "人工智能及大数据计算理学硕士"
);
programmeAliasOverrides["nus-master-of-science-civil-engineering"] = [
  "土木工程理学硕士", "土木工程硕士"
];
programmeAliasOverrides["ntu-master-of-science-applied-materials-analytics"] = [
  "应用材料分析"
];
programmeAliasOverrides["ntu-master-of-science-mechanical-engineering"] = [
  "机械工程硕士", "机械工程理学硕士", "机械工程硕士专业"
];
programmeAliasOverrides["ntu-master-of-science-modelling-simulation"] = [
  "建模与仿真硕士", "建模与仿真理学硕士"
];
programmeAliasOverrides["ntu-master-of-science-blockchain"] = [
  "区块链理学硕士"
];
programmeAliasOverrides["ntu-master-of-science-signal-processing-machine-learning"] = [
  "信号处理和机器学习理学硕士"
];
programmeAliasOverrides["nus-robotics"] = [
  "机器人学硕士", "机器人学 硕士"
];
programmeAliasOverrides["nus-master-of-science-biomedical-engineering"] = [
  "生物医学工程硕士", "生物医学工程 硕士", "生物医学工程理学硕士"
];
programmeAliasOverrides["ntu-master-of-science-materials-science-engineering"].push(
  "材料科学与工程硕士", "材料科学与工程硕士（25年秋季入学）"
);

programmeAliasOverrides["ntu-communications"] = [
  "通信工程硕士", "通信工程理学硕士", "通讯工程硕士"
];
programmeAliasOverrides["ntu-master-of-science-biomedical-engineering"] = [
  "生物医学工程硕士", "生物医学工程理学硕士"
];
programmeAliasOverrides["ntu-master-of-science-analytics"] = [
  "分析学硕士", "分析学理学硕士", "分析科学硕士"
];
programmeAliasOverrides["ntu-master-of-science-smart-manufacturing"].push(
  "智能制造硕士", "智能制造理学硕士"
);
programmeAliasOverrides["ntu-master-of-science-chemical-sciences-instrumentation"].push(
  "化学科学与仪器理学硕士"
);
programmeAliasOverrides["ntu-master-of-science-managerial-economics"].push(
  "管理经济学理学硕士", "管理经济学理学硕士（中文授课）", "管理经济学理学硕士（英文授课）", "管理经济学硕士"
);
programmeAliasOverrides["nus-ee"].push("电子工程理学硕士");
programmeAliasOverrides["nus-mcomp-ai"] = [
  "\u8ba1\u7b97\u7855\u58eb\uff08\u4eba\u5de5\u667a\u80fd\uff09",
  "\u65b0\u52a0\u5761\u56fd\u7acb\u5927\u5b66\u8ba1\u7b97\u7855\u58eb\uff08\u4eba\u5de5\u667a\u80fd\uff09"
];
programmeAliasOverrides["nus-master-of-science-materials-science-and-engineering"].push(
  "材料科学与工程硕士"
);
programmeAliasOverrides["cuhk-msc-in-economics"] = [
  "经济学", "经济学理学硕士"
];
programmeAliasOverrides["hku-master-of-science-in-the-field-of-physics"] = [
  "物理学硕士", "物理硕士"
];
programmeAliasOverrides["polyu-hk-intelligent-robotics-engineering"] = [
  "机器人硕士", "智能机器人工程", "MSc Intelligent Robotics Engineering"
];
programmeAliasOverrides["hkust-msc-in-information-technology"] = [
  "信息科技硕士", "信息科技理学硕士", "信息科技"
];
programmeAliasOverrides["polyu-hk-actuarial-and-investment-science"] = [
  "精算", "精算学硕士", "精算与投资科学"
];
programmeAliasOverrides["cityu-hk-msc-mechanical-engineering"] = [
  "机械工程", "机械工程硕士"
];
programmeAliasOverrides["ntu-power"] = [
  "电力工程硕士", "电力工程硕士专业"
];
programmeAliasOverrides["ntu-master-of-science-materials-science-engineering"] = [
  "材料学硕士", "材料科学与工程硕士"
];
programmeAliasOverrides["hku-master-of-science-in-the-field-of-applied-geosciences"] = [
  "应用地球科学", "应用地球科学专业"
];
programmeAliasOverrides["hkust-msc-in-engineering-enterprise-management"] = [
  "企业工程管理", "企业工程管理硕士"
];
programmeAliasOverrides["nus-master-of-science-in-quantitative-finance"] = [
  "数量金融", "数量金融专业", "数量金融硕士"
];

// Search vocabulary is deliberately kept separate from programme matching:
// discovery may be broad enough to find a page, while strict terms are only
// used to decide whether that page belongs to the requested programme.
const programmeFocusSearchTerms = {
  computer: ["Computer Science", "Computing", "\u8ba1\u7b97\u673a\u79d1\u5b66", "\u8ba1\u7b97\u673a"],
  software: ["Software Engineering", "Software Development", "\u8f6f\u4ef6\u5de5\u7a0b"],
  cybersecurity: ["Cyber Security", "Cybersecurity", "Information Security", "\u7f51\u7edc\u5b89\u5168", "\u4fe1\u606f\u5b89\u5168"],
  electronic: ["Electronics", "Electronic Engineering", "\u7535\u5b50\u5de5\u7a0b", "\u7535\u5b50\u5b66"],
  electrical: ["Electrical Engineering", "Electrical", "\u7535\u6c14\u5de5\u7a0b"],
  communication: ["Communication Engineering", "Communications Engineering", "Telecommunications", "\u901a\u4fe1\u5de5\u7a0b", "\u901a\u4fe1"],
  signal: ["Signal Processing", "Digital Signal Processing", "\u4fe1\u53f7\u5904\u7406"],
  data: ["Data Science", "Data Analytics", "Big Data", "\u6570\u636e\u79d1\u5b66", "\u6570\u636e\u5206\u6790", "\u5927\u6570\u636e"],
  ai: ["Artificial Intelligence", "Machine Learning", "\u4eba\u5de5\u667a\u80fd", "\u673a\u5668\u5b66\u4e60"],
  robotics: ["Robotics", "Robot", "\u673a\u5668\u4eba"],
  automation: ["Automation", "Industrial Automation", "\u81ea\u52a8\u5316"],
  control: ["Control Engineering", "Control Systems", "\u63a7\u5236\u5de5\u7a0b", "\u63a7\u5236\u7cfb\u7edf"],
  "integrated-circuit": ["Integrated Circuit Design", "Integrated Circuits", "IC Design", "\u96c6\u6210\u7535\u8def", "\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"],
  semiconductor: ["Semiconductor", "Microelectronics", "\u534a\u5bfc\u4f53", "\u5fae\u7535\u5b50"],
  embedded: ["Embedded Systems", "Embedded System", "\u5d4c\u5165\u5f0f\u7cfb\u7edf"],
  mechanical: ["Mechanical Engineering", "\u673a\u68b0\u5de5\u7a0b"],
  manufacturing: ["Manufacturing", "Smart Manufacturing", "\u667a\u80fd\u5236\u9020"],
  power: ["Power Engineering", "Power Systems", "\u7535\u529b\u5de5\u7a0b", "\u7535\u529b\u7cfb\u7edf"],
  energy: ["Energy Engineering", "Renewable Energy", "\u80fd\u6e90\u5de5\u7a0b"],
  instrumentation: ["Instrumentation", "Scientific Instrumentation", "\u4eea\u5668\u4eea\u8868"],
  optoelectronics: ["Optoelectronics", "Optical Engineering", "\u5149\u7535\u5b50"]
};

const programmeSearchProfileOverrides = {
  "ntu-master-of-science-applied-materials-analytics": {
    exact: ["Applied Materials Analytics", "Materials Analytics", "\u5e94\u7528\u6750\u6599\u5206\u6790", "\u6750\u6599\u5206\u6790"],
    short: ["Applied Materials Analytics", "Materials Analytics"],
    strict: ["Applied Materials Analytics", "Materials Analytics", "\u5e94\u7528\u6750\u6599\u5206\u6790", "\u6750\u6599\u5206\u6790"],
    sourceSearchTerms: {
      "mastermate-public-cases": { exact: ["NTU Applied Materials Analytics", "\u5357\u6d0b\u7406\u5de5\u5927\u5b66\u5e94\u7528\u6750\u6599\u5206\u6790"], short: ["Applied Materials Analytics", "\u5e94\u7528\u6750\u6599\u5206\u6790"] },
      "compassedu-public-cases": { exact: ["Applied Materials Analytics", "\u5e94\u7528\u6750\u6599\u5206\u6790"], short: ["Materials Analytics"] }
    }
  },
  "ntu-master-of-science-signal-processing": {
    exact: ["Signal Processing", "\u4fe1\u53f7\u5904\u7406"],
    short: ["Signal Processing", "\u4fe1\u53f7\u5904\u7406"],
    strict: ["Signal Processing", "\u4fe1\u53f7\u5904\u7406"],
    sourceSearchTerms: {
      "mastermate-public-cases": { exact: ["NTU Signal Processing", "\u5357\u6d0b\u7406\u5de5\u5927\u5b66\u4fe1\u53f7\u5904\u7406"], short: ["Signal Processing", "\u4fe1\u53f7\u5904\u7406"] },
      "compassedu-public-cases": { exact: ["Signal Processing", "\u4fe1\u53f7\u5904\u7406"], short: ["Signal Processing"] }
    }
  },
  "ntu-master-of-science-integrated-circuit-design": {
    exact: ["Integrated Circuit Design", "IC Design", "\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"],
    short: ["Integrated Circuit Design", "IC Design", "\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"],
    strict: ["Integrated Circuit Design", "IC Design", "\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"],
    sourceSearchTerms: {
      "mastermate-public-cases": { exact: ["NTU Integrated Circuit Design", "\u5357\u6d0b\u7406\u5de5\u5927\u5b66\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"], short: ["IC Design", "\u96c6\u6210\u7535\u8def\u8bbe\u8ba1"] },
      "compassedu-public-cases": { exact: ["Integrated Circuit Design", "IC Design"], short: ["Integrated Circuit Design"] }
    }
  },
  "cuhk-msc-in-data-science-and-business-statistics": {
    exact: [
      "Data Science and Business Statistics",
      "MSc Data Science and Business Statistics",
      "\u6570\u636e\u79d1\u5b66\u4e0e\u5546\u4e1a\u7edf\u8ba1",
      "\u6570\u636e\u79d1\u5b66\u53ca\u5546\u4e1a\u7edf\u8ba1"
    ],
    short: ["Data Science and Business Statistics", "\u6570\u636e\u79d1\u5b66\u4e0e\u5546\u4e1a\u7edf\u8ba1"],
    strict: [
      "Data Science and Business Statistics",
      "MSc Data Science and Business Statistics",
      "\u6570\u636e\u79d1\u5b66\u4e0e\u5546\u4e1a\u7edf\u8ba1",
      "\u6570\u636e\u79d1\u5b66\u53ca\u5546\u4e1a\u7edf\u8ba1"
    ]
  },
  "cuhk-msc-in-advanced-materials-science": {
    exact: ["Advanced Materials Science", "MSc Advanced Materials Science", "\u9ad8\u7ea7\u6750\u6599\u79d1\u5b66", "\u5148\u8fdb\u6750\u6599\u79d1\u5b66"],
    short: ["Advanced Materials Science", "\u9ad8\u7ea7\u6750\u6599\u79d1\u5b66"],
    strict: ["Advanced Materials Science", "MSc Advanced Materials Science", "\u9ad8\u7ea7\u6750\u6599\u79d1\u5b66", "\u5148\u8fdb\u6750\u6599\u79d1\u5b66"]
  },
  "nus-master-of-science-in-applied-data-science": {
    exact: ["Applied Data Science", "MSc Applied Data Science", "NUS Applied Data Science", "\u5e94\u7528\u6570\u636e\u79d1\u5b66"],
    short: ["Applied Data Science", "NUS Applied Data Science", "\u5e94\u7528\u6570\u636e\u79d1\u5b66"],
    strict: ["Applied Data Science", "MSc Applied Data Science", "NUS Applied Data Science", "\u5e94\u7528\u6570\u636e\u79d1\u5b66"]
  },
  "nus-master-of-science-artificial-intelligence-innovation": {
    exact: ["Artificial Intelligence & Innovation", "Artificial Intelligence and Innovation", "AI Innovation", "\u4eba\u5de5\u667a\u80fd\u4e0e\u521b\u65b0"],
    short: ["AI Innovation", "Artificial Intelligence Innovation"],
    strict: ["Artificial Intelligence & Innovation", "Artificial Intelligence and Innovation", "AI Innovation", "\u4eba\u5de5\u667a\u80fd\u4e0e\u521b\u65b0"]
  },
  "nus-msc-artificial-intelligence-and-innovation": {
    exact: ["Artificial Intelligence & Innovation", "Artificial Intelligence and Innovation", "AI Innovation"],
    short: ["AI Innovation", "Artificial Intelligence Innovation"],
    strict: ["Artificial Intelligence & Innovation", "Artificial Intelligence and Innovation", "AI Innovation"]
  },
  "polyu-hk-mathematics-for-artificial-intelligence-technology": {
    exact: ["Mathematics for Artificial Intelligence Technology", "Mathematics for AI Technology", "\u4eba\u5de5\u667a\u80fd\u6280\u672f\u6570\u5b66"],
    short: ["Mathematics for AI Technology", "AI Technology Mathematics"],
    strict: ["Mathematics for Artificial Intelligence Technology", "Mathematics for AI Technology", "\u4eba\u5de5\u667a\u80fd\u6280\u672f\u6570\u5b66"]
  },
  "polyu-hk-artificial-intelligence-and-big-data-computing": {
    sourceSearchTerms: {
      "mastermate-public-cases": { exact: ["PolyU Artificial Intelligence and Big Data Computing", "\u7406\u5de5\u4eba\u5de5\u667a\u80fd\u4e0e\u5927\u6570\u636e\u8ba1\u7b97"], short: ["Artificial Intelligence and Big Data Computing"] },
      "compassedu-public-cases": { exact: ["Artificial Intelligence and Big Data Computing", "\u4eba\u5de5\u667a\u80fd\u4e0e\u5927\u6570\u636e\u8ba1\u7b97"], short: ["AI Big Data"] }
    }
  },
  "polyu-hk-cybersecurity": {
    sourceSearchTerms: {
      "mastermate-public-cases": { exact: ["PolyU Cybersecurity", "\u7406\u5de5\u7f51\u7edc\u5b89\u5168"], short: ["Cybersecurity", "\u7f51\u7edc\u5b89\u5168"] },
      "compassedu-public-cases": { exact: ["Cybersecurity", "\u7f51\u7edc\u5b89\u5168"], short: ["Cybersecurity"] }
    }
  }
};

function stripProgrammeDegreeTerms(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:master\s+of\s+science|master\s+of\s+engineering|master|msc(?:\s*\(eng\))?|m\.sc\.?|msceng|programme|program|degree)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildProgrammeSearchProfile(programme) {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const override = programmeSearchProfileOverrides[programme?.id] || {};
  const rawNames = uniqueMasterTerms([
    programme?.nameEn,
    programme?.nameZh,
    ...(programme?.aliases || [])
  ]).filter(term => term.length >= 3);
  const strippedNames = uniqueMasterTerms(rawNames.map(stripProgrammeDegreeTerms))
    .filter(term => term.length >= 3);
  const focusTerms = uniqueMasterTerms((programme?.focusTags || programme?.majorTags || [])
    .flatMap(tag => programmeFocusSearchTerms[tag] || []));
  const exact = uniqueMasterTerms([
    ...(override.exact || []),
    ...rawNames,
    ...strippedNames
  ]).filter(term => term.length >= 3);
  const short = uniqueMasterTerms([
    ...(override.short || []),
    ...strippedNames.slice(0, 4),
    ...focusTerms
  ]).filter(term => term.length >= 3);
  const institutionTerms = uniqueMasterTerms([
    institution?.nameEn,
    institution?.nameZh,
    ...(institution?.aliases || [])
  ]).filter(term => term.length >= 2);
  const institutionQualified = uniqueMasterTerms(
    institutionTerms.slice(0, 3).flatMap(institutionTerm => exact.slice(0, 4).map(term => `${institutionTerm} ${term}`))
  );
  const strictMatchTerms = uniqueMasterTerms([
    ...(override.strict || []),
    ...rawNames,
    ...strippedNames
  ]).filter(term => term.length >= 3);
  return {
    discoveryTerms: {
      exact,
      short,
      institutionQualified,
      focus: focusTerms,
      caseSignals: ["offer", "admission", "case", "GPA", "\u5f55\u53d6\u6848\u4f8b", "\u5f55\u53d6"]
    },
    sourceSearchTerms: override.sourceSearchTerms || {},
    strictMatchTerms,
    searchEntrypoints: uniqueMasterTerms([
      ...(programme?.caseSourceUrls || []),
      ...(override.searchEntrypoints || [])
    ])
  };
}

export const programmeMaster = [...curatedProgrammeMaster, ...discoveredProgrammes]
  .map(item => {
    const merged = {
      ...item,
      aliases: uniqueMasterTerms([...(item.aliases || []), ...(programmeAliasOverrides[item.id] || [])]),
      caseSourceUrls: uniqueMasterTerms([...(item.caseSourceUrls || []), ...(programmeCaseSources[item.id] || [])])
    };
    return { ...merged, ...buildProgrammeSearchProfile(merged) };
  })
  .filter((item, index, rows) => rows.findIndex(candidate => candidate.id === item.id
    || (candidate.institutionId === item.institutionId
      && normalizeProgrammeTitle(candidate.nameEn) === normalizeProgrammeTitle(item.nameEn))) === index);

export function resolveProgramme({ universityName, programmeName, programmeEnglishName } = {}) {
  const institution = resolveInstitution(universityName);
  const names = [programmeName, programmeEnglishName].filter(Boolean).map(normalizeName);
  if (!names.length) return null;
  const candidates = institution
    ? programmeMaster.filter(programme => programme.institutionId === institution.id)
    : programmeMaster;
  const institutionTerms = institution
    ? [institution.nameZh, institution.nameEn, ...(institution.aliases || [])]
      .filter(Boolean).map(normalizeName)
    : [];
  const matchesAlias = (name, alias) => {
    if (name === alias) return true;
    const chineseLength = (alias.match(/[\u3400-\u9fff]/g) || []).length;
    const minimumLength = chineseLength >= 4 ? 4 : 6;
    if (alias.length < minimumLength) return false;
    if (alias.includes(name)) return true;
    if (!name.includes(alias)) return false;
    if (chineseLength < 4) return true;
    const extra = name.replace(alias, "");
    const isInstitutionPrefix = institutionTerms.some(term => term && extra.startsWith(term));
    const isDirectionSuffix = /(?:方向|通识|通用|专业|speciali[sz]ation|track|stream)$/i.test(extra);
    const isDegreeSuffix = /^(?:(?:理|工|文|法|教育|医学|艺术|管理)?学)?硕士(?:中文授课|英文授课|专业)?$/i.test(extra)
      || /^硕士20\d{2}年(?:春季|秋季)?入学$/i.test(extra);
    return isInstitutionPrefix || isDirectionSuffix || isDegreeSuffix;
  };
  const exact = candidates.find(programme => {
    const aliases = [programme.nameZh, programme.nameEn, ...(programme.aliases || [])].filter(Boolean).map(normalizeName);
    const canonicalNames = [programmeName, programmeEnglishName].filter(Boolean)
      .filter(value => /[a-z]/i.test(String(value)))
      .map(normalizeProgrammeTitle);
    const canonicalAliases = [programme.nameEn, ...(programme.aliases || [])].filter(Boolean).map(normalizeProgrammeTitle);
    return names.some(name => aliases.includes(name))
      || canonicalNames.some(name => canonicalAliases.includes(name));
  });
  if (exact) return exact;
  return candidates.find(programme => {
    const aliases = [programme.nameZh, programme.nameEn, ...(programme.aliases || [])].filter(Boolean).map(normalizeName);
    const canonicalNames = [programmeName, programmeEnglishName].filter(Boolean)
      .filter(value => /[a-z]/i.test(String(value)))
      .map(normalizeProgrammeTitle);
    const canonicalAliases = [programme.nameEn, ...(programme.aliases || [])].filter(Boolean).map(normalizeProgrammeTitle);
    return names.some(name => aliases.some(alias => matchesAlias(name, alias)))
      || canonicalNames.some(name => canonicalAliases.some(alias => name === alias || matchesAlias(name, alias)));
  }) || null;
}

export const normalizeMasterName = normalizeName;
