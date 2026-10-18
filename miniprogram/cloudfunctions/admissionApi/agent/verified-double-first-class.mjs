// Education Ministry, second-round Double First-Class list (2022):
// https://hudong.moe.gov.cn/srcsite/A22/s7065/202202/W020220214318455516037.pdf
// Only schools outside the historical 985/211 lists belong here. Membership is
// an institution identity, not an admissions threshold or a programme advantage.
export const doubleFirstClassOnlyNames = [
  "北京协和医学院", "首都师范大学", "外交学院", "中国人民公安大学", "中国音乐学院", "中央美术学院", "中央戏剧学院",
  "天津工业大学", "天津中医药大学", "山西大学", "上海海洋大学", "上海中医药大学", "上海体育大学", "上海音乐学院",
  "南京邮电大学", "南京林业大学", "南京信息工程大学", "南京医科大学", "南京中医药大学", "中国美术学院",
  "河南大学", "湘潭大学", "华南农业大学", "广州医科大学", "广州中医药大学", "西南石油大学", "成都理工大学",
  "成都中医药大学", "宁波大学", "南方科技大学", "上海科技大学", "中国科学院大学"
];

const names = new Set([...doubleFirstClassOnlyNames, "上海体育学院"]);
export const isVerifiedDoubleFirstClass = name => names.has(String(name || "").replace(/[（(].*?[）)]/g, "").trim());
