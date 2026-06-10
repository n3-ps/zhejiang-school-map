import fs from "node:fs";
import path from "node:path";

const dir = "C:\\Users\\hwfu\\Desktop\\" + "\\u6D59\\u6C5F\\u7701\\u6C11\\u529E\\u6821\\u4F5C\\u6218\\u5730\\u56FE";
const filePath = path.join(dir, "\\u6D59\\u6C5F\\u6C11\\u529E\\u6821\\u4F5C\\u6218\\u5730\\u56FE.html");
const xlsxPath = path.join(dir, "xlsx_schools_temp.txt");

const html = fs.readFileSync(filePath, "utf16le");
const xlsxCode = fs.readFileSync(xlsxPath, "utf-8");

const retPt = "    if (localStorage.getItem(key)) return;";
const rIdx = html.indexOf(retPt);
if (rIdx === -1) { process.exit(1); }

const insertBlock = "".concat(
  '    // 从商机表Excel导入的学校\n',
  "    const xlsxKey = 'zhejiang_xlsx_imported_v1';\n",
  "    if (!localStorage.getItem(xlsxKey)) {\n",
  xlsxCode
    .replace(/^const xlsxSchools = \[/gm, "      const xlsxSchools = [")
    .replace(/^  \{id/gm, "        {id")
    .replace(/^\];$/gm, "      ];")
    .replace(/^let xlsxCount = 0;$/gm, "      let xlsxCount = 0;")
    .replace(/^xlsxSchools\.forEach/gm, "      xlsxSchools.forEach")
    .replace(/^if \(xlsxCount/gm, "      if (xlsxCount")
    .replace("if (xlsxCount > 0) count += xlsxCount;", "      if (xlsxCount > 0) { store.set(this.data); }\\n      localStorage.setItem(xlsxKey, \\\"1\\\");")
    .replace(/\n+$/, ""),
  "\n    }\\n\\n"
);

const result = html.slice(0, rIdx) + insertBlock + html.slice(rIdx);
fs.writeFileSync(filePath, result, "utf16le");
console.log("Done. Size:", (Buffer.byteLength(result, "utf16le") / 1024).toFixed(1), "KB");
